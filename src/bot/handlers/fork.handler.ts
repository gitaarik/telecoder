/**
 * /fork — hand off a conversation from this bot to a sibling bot at a chosen
 * past assistant message.
 *
 * Tap flow:
 *   1. "🍴 Fork" button on a past bot message     → fork:pick
 *      ↳ shows picker of sibling bots
 *   2. Tap target bot                             → fork:to:<botId>:<msgId>
 *      ↳ shows confirmation
 *   3. Tap Confirm                                → fork:confirm:<botId>:<msgId>
 *      ↳ truncates source JSONL, writes pending fork to target's file
 *
 * On a bot with threads none of that is asked: the 🍴 tap (or /fork) opens a
 * new thread at once with createForumTopic, the fork goes into the new
 * thread's session, and this one carries on. Pickers sent before that still
 * carry `fork:to:thread:<msgId>`, which goes the same way through the
 * confirmation.
 *
 * Target-side pickup (in message.handler):
 *   user sends any message → bot sees pending fork → shows accept/decline
 *      Accept  → fork:accept    (loads transcript, switches project if needed)
 *      Decline → fork:decline   (discards pending fork)
 *
 * Both confirmations keep a 🍴 Fork button anchored at the fork point — the
 * "Forked to" message here and the loaded fork's in the bot that received it
 * — so the same point can be forked again from either chat without scrolling
 * back to the message it was taken from.
 *
 * /accept and /decline slash commands behave the same as the buttons, in
 * case the inline keyboard isn't accessible.
 */

import { Context, Bot } from 'grammy';
import type { Message } from 'grammy/types';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { BOT_ID, config } from '../../config.js';
import { buildSessionKey, getSessionKeyFromCtx } from '../../utils/session-key.js';
import { messageOffsets, countJsonlLines, type MessageOffsetEntry } from '../../claude/message-offsets.js';
import { FORK_KEYBOARD, BRANCH_MARKER_KEYBOARD } from '../../telegram/message-sender.js';
import {
  getPendingFork,
  putPendingFork,
  removePendingFork,
  markForkOffered,
  listPendingForks,
  pendingForksPathFor,
  PendingFork,
} from '../../claude/pending-forks.js';
import { listSiblingBots, findBotById } from '../../utils/instances.js';
import { buildLetteredKeyboard, letteredOptionLines } from '../../telegram/lettered-options.js';
import {
  sessionJsonlPath,
  lastAssistantTurnText,
  lastExchangeIn,
  rewriteJsonlSessionId,
  forkPastRunningTurn,
  type RecapExchange,
} from '../../claude/session-jsonl.js';
import { sessionManager } from '../../claude/session-manager.js';
import { clearConversation } from '../../providers/provider-router.js';
import { isAllowedUser } from '../../utils/user-roster.js';
import { EntityText, joinMessages, plain, type EntityMessage } from '../../telegram/entities.js';
import { editCallbackMessage, replyFormatted, sendFormatted } from '../../telegram/send.js';
import { cutLabel, promptLabel } from '../../telegram/prompt-label.js';
import { restoreTopic } from './command.handler.js';
import { getSessionTopic } from './command.handler.js';
import { sessionDisplayName } from './command/shared.js';
import { adoptThread, threadName } from '../../telegram/thread-titles.js';
import { isHomeProject } from '../../utils/home-project.js';
import { userPreferences } from '../../providers/user-preferences.js';
import { buildSyntheticCtx } from '../../claude/synthetic-ctx.js';
import { replayIntoThread } from '../middleware/queued-messages.js';
import { sanitizeError } from '../../utils/sanitize.js';
import { summarizeTopicWithHaiku } from '../../claude/auto-topic-haiku.js';


/**
 * Stands in for a bot id in `fork:to:` and `fork:confirm:` when the target is
 * a new thread. The picker no longer offers it, but pickers already in a chat do.
 */
const THREAD_TARGET = 'thread';
/** In front of a forked thread's name, so it reads apart from the one it came from. */
const FORK_THREAD_PREFIX = '🍴 ';

/**
 * Whether a fork can open a thread of its own here: a private chat with a bot
 * that has threads turned on. Groups have forum topics, but people name and
 * order those for each other, so a fork doesn't add to them.
 *
 * Where it can, that's where every fork goes, without a picker: a new thread
 * keeps both conversations open side by side, which a branch here or a
 * sibling bot only approximates, and someone who turned threads on wants them.
 */
function canForkToThread(ctx: Context): boolean {
  return ctx.chat?.type === 'private' && ctx.me?.has_topics_enabled === true;
}

interface ForkOfferTexts {
  text: EntityMessage;
  keyboard: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
}

/**
 * Build the fork-target picker: this bot itself (a fresh branch of the current
 * conversation) first, then every sibling bot, then Cancel. Self is always
 * offered so you can branch a thread without needing a second bot.
 *
 * Returns the body lines as well as the rows. A sibling's name is whatever the
 * operator wrote in the instances config, and on a button anything past the
 * width Telegram renders is ellipsised away with no way to read it — two bots
 * sharing a prefix would arrive as the same clipped line. So the targets are
 * written out in the message keyed A/B/C and the same letter keys the button,
 * the way /resume and `telecoder_ask_user` list their options. Cancel keeps
 * its own row and no letter: it is the way out, not one of the targets.
 */
export function buildTargetPicker(anchorMsgId: number): {
  lines: string[];
  keyboard: Array<Array<{ text: string; callback_data: string }>>;
} {
  const targets = [
    // Which bot "here" is goes in the description rather than the label: it
    // is the one sending the message, so it is context, not the choice — and
    // parenthesising it on the label costs the whole keyboard its labels.
    {
      label: '🌱 New branch here',
      description: config.BOT_NAME,
      callbackData: `fork:to:${BOT_ID}:${anchorMsgId}`,
    },
    ...listSiblingBots(BOT_ID).map((b) => ({
      label: b.name,
      callbackData: `fork:to:${b.botId}:${anchorMsgId}`,
    })),
  ];

  return {
    lines: letteredOptionLines(targets),
    keyboard: [
      ...buildLetteredKeyboard(targets),
      [{ text: 'Cancel', callback_data: 'fork:cancel' }],
    ],
  };
}

/**
 * Compose the "fork received" message + inline keyboard. Shared between the
 * lazy in-message path (reply in current chat) and the proactive watcher
 * (DMs the user without waiting for them to type).
 */
function buildForkOffer(fork: PendingFork, mode: 'lazy' | 'proactive'): ForkOfferTexts {
  const projectLabel = path.basename(fork.projectPath);
  const text = new EntityText()
    .add('📦 ').bold(`Fork received from ${fork.fromBotName}`).newline(2)
    .add('Project: ').bold(projectLabel);
  if (fork.topic) text.newline().bold('Topic:').add(` ${fork.topic}`);
  if (fork.assistantPreview) {
    text.newline(2).italic('Last assistant message:').newline().add(fork.assistantPreview.substring(0, 200));
  }
  text.newline(2).add("Accepting will replace this bot's current conversation (saved to /resume history). Decline to discard the fork.");
  if (mode === 'lazy') {
    text.newline(2).italic("Your message was held back so it doesn't get attached to the wrong context. Re-send it after deciding.");
  }

  return {
    text: text.build(),
    keyboard: {
      inline_keyboard: [
        [
          { text: '✅ Accept fork', callback_data: 'fork:accept' },
          { text: '❌ Decline', callback_data: 'fork:decline' },
        ],
      ],
    },
  };
}

export async function handleForkCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;
  const parts = data.split(':');
  const action = parts[1];

  try {
    if (action === 'pick') {
      await onPick(ctx);
    } else if (action === 'to') {
      await onTo(ctx, parts[2], parseInt(parts[3], 10));
    } else if (action === 'confirm') {
      await onConfirm(ctx, parts[2], parseInt(parts[3], 10));
    } else if (action === 'cancel') {
      await onCancel(ctx);
    } else if (action === 'accept') {
      await onAccept(ctx);
    } else if (action === 'decline') {
      await onDecline(ctx);
    } else {
      await ctx.answerCallbackQuery({ text: 'Unknown fork action.' });
    }
  } catch (err) {
    console.error('[Fork] callback failed:', err instanceof Error ? err.message : err);
    try {
      await ctx.answerCallbackQuery({ text: 'Fork failed — see bot logs.' });
    } catch { /* ignore */ }
  }
}

async function onPick(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  const msgId = ctx.callbackQuery?.message?.message_id;
  if (!keyInfo || !msgId) {
    await ctx.answerCallbackQuery({ text: 'Cannot identify this message.' });
    return;
  }

  const offset = messageOffsets.lookup(keyInfo.sessionKey, msgId);
  if (!offset) {
    await ctx.answerCallbackQuery({ text: 'Fork point no longer available for this message.' });
    return;
  }
  if (canForkToThread(ctx)) {
    await forkStraightIntoThread(ctx, keyInfo.sessionKey, offset, msgId);
    return;
  }

  await ctx.answerCallbackQuery();

  const projectLabel = path.basename(offset.projectPath);

  const picker = buildTargetPicker(msgId);
  await replyFormatted(
    ctx,
    new EntityText()
      .add('🍴 ').bold('Fork conversation').newline(2)
      .add('From this point in ').bold(projectLabel).add(' — pick where to branch it:').newline(2)
      .add(picker.lines.join('\n'))
      .build(),
    {
      reply_parameters: { message_id: msgId },
      reply_markup: { inline_keyboard: picker.keyboard },
    },
  );
}

async function onTo(ctx: Context, targetBotId: string, sourceMsgId: number): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo || Number.isNaN(sourceMsgId)) {
    await ctx.answerCallbackQuery({ text: 'Invalid fork target.' });
    return;
  }

  const offset = messageOffsets.lookup(keyInfo.sessionKey, sourceMsgId);
  if (!offset) {
    await ctx.answerCallbackQuery({ text: 'Fork point no longer available.' });
    return;
  }
  const toThread = targetBotId === THREAD_TARGET;
  const target = toThread ? undefined : findBotById(targetBotId);
  if (!toThread && !target) {
    await ctx.answerCallbackQuery({ text: 'Target bot not found.' });
    return;
  }

  await ctx.answerCallbackQuery();

  const projectLabel = path.basename(offset.projectPath);
  const isSelf = targetBotId === BOT_ID;
  const text = new EntityText();
  if (toThread) {
    text.add('🍴 ').bold('Fork into a new thread?').newline(2)
      .add('This copies ').bold(projectLabel)
      .add(" up to that point into a new thread, with this thread's settings. This thread carries on unchanged.");
  } else if (isSelf) {
    text.add('🍴 ').bold('Branch into a new conversation?').newline(2)
      .add('This copies ').bold(projectLabel)
      .add(' up to that point into a fresh conversation on this bot. '
        + 'Your current conversation is saved to /resume history, and you continue from the branch point.');
  } else {
    const name = target!.name;
    text.add('🍴 ').bold(`Fork to ${name}?`).newline(2)
      .add('This will copy the conversation in ').bold(projectLabel)
      .add(' up to that point and hand it off to ').bold(name).add('.').newline(2)
      .add('When you open ').bold(name).add(" and send any message, you'll get a prompt to accept the fork. ")
      .add('Accepting replaces ').bold(name).add("'s current conversation (saved to its /resume history).");
  }

  try {
    await editCallbackMessage(ctx, text.build(), {
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Confirm fork', callback_data: `fork:confirm:${targetBotId}:${sourceMsgId}` }],
          [{ text: 'Cancel', callback_data: 'fork:cancel' }],
        ],
      },
    });
  } catch (err) {
    console.debug('[Fork] onTo edit failed:', err instanceof Error ? err.message : err);
  }
}

async function onConfirm(ctx: Context, targetBotId: string, sourceMsgId: number): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo || Number.isNaN(sourceMsgId)) {
    await ctx.answerCallbackQuery({ text: 'Invalid fork target.' });
    return;
  }

  const offset = messageOffsets.lookup(keyInfo.sessionKey, sourceMsgId);
  if (!offset) {
    await ctx.answerCallbackQuery({ text: 'Fork point no longer available.' });
    return;
  }
  const toThread = targetBotId === THREAD_TARGET;
  const target = toThread ? undefined : findBotById(targetBotId);
  if (!toThread && !target) {
    await ctx.answerCallbackQuery({ text: 'Target bot not found.' });
    return;
  }

  const cut = cutFork(ctx, keyInfo.sessionKey, offset);
  if ('error' in cut) {
    await ctx.answerCallbackQuery({ text: cut.error });
    return;
  }
  const { fork } = cut;

  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.answerCallbackQuery({ text: 'Could not identify user.' });
    return;
  }

  // Self-fork: branch within this same bot/chat. The pending-fork handoff
  // (and its accept/decline prompt) only exists to cross bots — here the
  // source and target are the same conversation, so load the branch right
  // now. loadFork saves the current conversation to /resume history first.
  if (targetBotId === BOT_ID) {
    await loadFork(ctx, keyInfo.sessionKey, fork);
    await ctx.answerCallbackQuery({ text: 'Branched.' });
    return;
  }

  if (toThread) {
    await forkIntoThread(ctx, keyInfo.sessionKey, fork, offset);
    return;
  }

  // Key the pending fork by Telegram user id, not sessionKey: each bot has
  // its own DM with the user with a different chatId, so the target bot
  // can't find the fork by chatId-based key. User id is constant across
  // bots; the offer will land in whichever chat the user next messages
  // the target bot in.
  putPendingFork(target!.botId, userId, fork);

  await ctx.answerCallbackQuery({ text: 'Forked.' });

  const projectLabel = path.basename(offset.projectPath);
  try {
    await editCallbackMessage(
      ctx,
      new EntityText()
        .add('✅ ').bold(`Forked to ${target!.name}`).newline(2)
        .add('Open ').bold(target!.name)
        .add(` and send any message — you'll get the option to accept the forked conversation (${projectLabel}).`)
        .newline(2)
        .italic('This conversation carries on here unchanged.')
        .build(),
      { reply_markup: FORK_KEYBOARD },
    );
    // This confirmation stands for the same point as the message the fork was
    // taken from, and it's the one at the bottom of the chat — so it gets that
    // message's fork point, and sending the point on to another bot, or
    // branching it here, doesn't mean scrolling back up to find it.
    const anchorId = ctx.callbackQuery?.message?.message_id;
    if (anchorId) messageOffsets.record(keyInfo.sessionKey, anchorId, offset);
  } catch (err) {
    console.debug('[Fork] onConfirm edit failed:', err instanceof Error ? err.message : err);
  }
}

/**
 * The conversation as it stood at a fork point: the source transcript cut to
 * the recorded line count, with what the receiving side shows about it.
 */
function cutFork(
  ctx: Context,
  sessionKey: string,
  offset: MessageOffsetEntry,
): { fork: PendingFork } | { error: string } {
  const sourceJsonl = sessionJsonlPath(offset.projectPath, offset.claudeSessionId);
  if (!fs.existsSync(sourceJsonl)) return { error: 'Source transcript no longer on disk.' };

  let truncated: string;
  try {
    const raw = fs.readFileSync(sourceJsonl, 'utf-8');
    const lines = raw.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const sliced = lines.slice(0, offset.lineCount);
    truncated = sliced.join('\n') + (sliced.length > 0 ? '\n' : '');
  } catch (err) {
    console.error('[Fork] Failed to read source JSONL:', err);
    return { error: 'Could not read source transcript.' };
  }

  return {
    fork: {
      fromBotName: config.BOT_NAME,
      fromBotId: BOT_ID,
      fromChatId: ctx.chat?.id,
      projectPath: offset.projectPath,
      jsonl: truncated,
      topic: getSessionTopic(sessionKey),
      // The reply the fork was taken from, read out of the cut transcript. The
      // chat's stored preview is its latest reply, which a fork taken from any
      // earlier message doesn't contain.
      assistantPreview: lastAssistantTurnText(truncated)?.substring(0, 200),
      createdAt: new Date().toISOString(),
    },
  };
}

/**
 * A fork on a bot with threads: straight into a new thread, with no picker
 * and no confirmation. Nothing here changes, and a thread you didn't want is
 * deleted as easily as a confirmation is cancelled. The result is a reply to
 * `replyTo`, the message the fork was taken from, which stays as it is.
 */
async function forkStraightIntoThread(
  ctx: Context,
  sessionKey: string,
  offset: MessageOffsetEntry,
  replyTo: number,
): Promise<void> {
  const cut = cutFork(ctx, sessionKey, offset);
  if ('error' in cut) {
    await tell(ctx, cut.error);
    return;
  }
  await forkIntoThread(ctx, sessionKey, cut.fork, offset, { replyTo });
}

/** A short notice: the tapped button's toast, or a reply when /fork was typed. */
async function tell(ctx: Context, text: string): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text });
  else await ctx.reply(text);
}

/**
 * Open a new thread and load the fork into it, leaving this thread as it is.
 *
 * The new thread starts with the settings this one chose for itself (model,
 * effort, transport…), since it carries on the same conversation, and a name
 * from the same topic with 🍴 in front, which it keeps through later renames
 * so the two stay apart in the list. The fork's banner goes into the new
 * thread; here, the confirmation it came through turns into a link to it, or
 * with `replyTo` a reply to that message says where it went. Either way that
 * message keeps the fork point.
 */
async function forkIntoThread(
  ctx: Context,
  sessionKey: string,
  fork: PendingFork,
  offset: MessageOffsetEntry,
  opts: { replyTo?: number } = {},
): Promise<void> {
  const opened = await openForkThread(ctx, sessionKey, fork, {
    above: 'The conversation it was forked from carries on in its own thread.',
  });
  if ('error' in opened) {
    await tell(ctx, opened.error);
    return;
  }
  if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: 'Forked into a new thread.' });
  const { name, link } = opened;
  const projectLabel = path.basename(fork.projectPath);

  const b = new EntityText().add('✅ ').bold('Forked into a new thread').newline(2);
  if (link) b.link(name, link);
  else b.bold(name);
  b.add(' carries on from that point in ').bold(projectLabel).add('.').newline(2)
    .italic('This thread carries on here unchanged.');
  const text = b.build();
  try {
    const anchorId = opts.replyTo
      ? (await replyFormatted(ctx, text, {
          reply_markup: FORK_KEYBOARD,
          reply_parameters: { message_id: opts.replyTo },
        })).message_id
      : (await editCallbackMessage(ctx, text, { reply_markup: FORK_KEYBOARD }),
        ctx.callbackQuery?.message?.message_id);
    // Same as a fork to another bot: this message stands for the point the
    // fork was taken from, so it can be forked again from here.
    if (anchorId) messageOffsets.record(sessionKey, anchorId, offset);
  } catch (err) {
    console.debug('[Fork] forkIntoThread edit failed:', err instanceof Error ? err.message : err);
  }
}

/**
 * Open a new thread named after the conversation, with this thread's
 * settings, and load the fork into it with its banner. Nothing is said here.
 */
async function openForkThread(
  ctx: Context,
  sessionKey: string,
  fork: PendingFork,
  marker: ForkMarkerOptions,
): Promise<{ threadId: number; threadKey: string; name: string; link?: string } | { error: string }> {
  const chatId = ctx.chat?.id;
  if (!chatId) return { error: 'Cannot identify this chat.' };

  const projectLabel = path.basename(fork.projectPath);
  const name = threadName(fork.topic ?? '', FORK_THREAD_PREFIX, isHomeProject(fork.projectPath) ? '' : projectLabel)
    || `${FORK_THREAD_PREFIX}${projectLabel}`;
  let threadId: number;
  try {
    threadId = (await ctx.api.createForumTopic(chatId, name)).message_thread_id;
  } catch (err) {
    console.error('[Fork] createForumTopic failed:', err instanceof Error ? err.message : err);
    return { error: 'Could not open a new thread.' };
  }

  const threadKey = buildSessionKey(chatId, threadId);
  adoptThread(threadKey, name, FORK_THREAD_PREFIX);
  userPreferences.copyScope(sessionKey, threadKey);

  const threadCtx = buildSyntheticCtx({ api: ctx.api, sessionKey: threadKey, syntheticText: '' });
  await loadFork(threadCtx, threadKey, fork, marker);

  const link = ctx.me?.username ? `https://t.me/${ctx.me.username}/${threadId}` : undefined;
  return { threadId, threadKey, name, link };
}

/**
 * What a fork taken while a turn is running has Claude say about that turn.
 * In Claude's voice, because it stands as Claude's reply to the prompt.
 */
export const STILL_RUNNING_NOTE = 'TeleCoder forked this conversation while the original was still working on the '
  + 'message above, so none of that work happened here. The original is still on it, in the same working '
  + "directory, so files may change while this fork runs. I won't redo or undo that work, and I'll check a "
  + "file's current state before relying on it.";

/** What one sent while a turn was running says, on one line, for the `You:` line in the fork. */
function describeMessage(message: Message): string {
  const words = message.text ?? message.caption;
  if (words?.trim()) return words;
  return message.voice ? '🎤 voice note' : message.photo ? '🖼 photo' : message.document ? '📎 file' : 'message';
}

/**
 * The conversation as it stands, for a fork taken whether or not a turn is
 * running: up to the last turn that ended, with the running one's prompt and
 * STILL_RUNNING_NOTE after it when there is one (see forkPastRunningTurn).
 */
function forkOfLatest(ctx: Context, sessionKey: string): { fork: PendingFork; noted: boolean } | { error: string } {
  const session = sessionManager.getSession(sessionKey);
  if (!session?.claudeSessionId) return { error: 'No conversation to fork yet.' };
  const sourceJsonl = sessionJsonlPath(session.workingDirectory, session.claudeSessionId);
  let raw: string;
  try {
    raw = fs.readFileSync(sourceJsonl, 'utf-8');
  } catch {
    return { error: 'No transcript on disk to fork.' };
  }

  const { jsonl, noted } = forkPastRunningTurn(raw, STILL_RUNNING_NOTE);
  return {
    noted,
    fork: {
      fromBotName: config.BOT_NAME,
      fromBotId: BOT_ID,
      fromChatId: ctx.chat?.id,
      projectPath: session.workingDirectory,
      jsonl,
      topic: getSessionTopic(sessionKey),
      assistantPreview: lastAssistantTurnText(jsonl)?.substring(0, 200),
      createdAt: new Date().toISOString(),
    },
  };
}

/**
 * "Ask in a fork" on a message waiting behind a running turn: the conversation
 * as it stood before that turn goes into a new thread, with the running prompt
 * and a reply saying it's still being worked on elsewhere (see
 * forkPastRunningTurn), and a `You:` line showing what's about to be asked
 * there. Sending the message itself is the caller's: it's the queue that holds
 * the update.
 */
export async function forkPastRunningTurnIntoThread(
  ctx: Context,
  sessionKey: string,
  message: Message,
): Promise<{ threadId: number; name: string; link?: string } | { error: string }> {
  if (!canForkToThread(ctx)) return { error: 'Forks need threads, which are off for this bot.' };
  const latest = forkOfLatest(ctx, sessionKey);
  if ('error' in latest) return latest;
  const { fork, noted } = latest;
  if (!noted) console.warn(`[Fork] ${sessionKey}: running turn not on disk yet, forking without the note`);

  const opened = await openForkThread(ctx, sessionKey, fork, {
    above: 'The conversation it was forked from carries on in its own thread, still working on that prompt.',
  });
  if ('error' in opened) return opened;

  try {
    await sendFormatted(
      ctx.api,
      ctx.chat!.id,
      youLine(describeMessage(message), MARKER_PROMPT_LEN),
      { message_thread_id: opened.threadId },
    );
  } catch (err) {
    console.warn('[Fork] Could not post the You line:', err instanceof Error ? err.message : err);
  }
  return { threadId: opened.threadId, name: opened.name, link: opened.link };
}

async function onCancel(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery({ text: 'Cancelled.' });
  try {
    await ctx.editMessageText('🍴 Fork cancelled.');
  } catch { /* ignore */ }
}

// ── Target-side accept / decline ─────────────────────────────────────────

/**
 * Show the "fork received" prompt in the target bot when a pending fork
 * exists for this user. Called from message.handler before normal message
 * handling. Returns true if a fork was offered (and the caller should drop
 * the incoming message), false otherwise.
 */
export async function offerPendingForkIfAny(ctx: Context): Promise<boolean> {
  const userId = ctx.from?.id;
  if (!userId) return false;
  const fork = getPendingFork(BOT_ID, userId);
  if (!fork) return false;

  const offer = buildForkOffer(fork, 'lazy');
  await replyFormatted(ctx, offer.text, { reply_markup: offer.keyboard });
  markForkOffered(BOT_ID, userId);
  return true;
}

async function onAccept(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  const userId = ctx.from?.id;
  if (!keyInfo || !userId) {
    await ctx.answerCallbackQuery({ text: 'No active chat.' });
    return;
  }
  const fork = getPendingFork(BOT_ID, userId);
  if (!fork) {
    await ctx.answerCallbackQuery({ text: 'No pending fork.' });
    try { await ctx.editMessageText('No pending fork to accept.'); } catch { /* ignore */ }
    return;
  }

  await loadFork(ctx, keyInfo.sessionKey, fork);
  removePendingFork(BOT_ID, userId);
  await ctx.answerCallbackQuery({ text: 'Fork loaded.' });
}

async function onDecline(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.answerCallbackQuery({ text: 'No active chat.' });
    return;
  }
  removePendingFork(BOT_ID, userId);
  await ctx.answerCallbackQuery({ text: 'Fork discarded.' });
  try {
    await ctx.editMessageText('❌ Fork discarded. Send a message to continue your current conversation.');
  } catch { /* ignore */ }
}

/**
 * Slash-command equivalents of the inline buttons. Useful if the inline
 * keyboard is missing (e.g. user scrolled away in a busy chat) or for power
 * users who'd rather type. Both shape the response the same as the buttons.
 */
/**
 * /fork [bot name] — alternative to tapping the 🍴 Fork button. Forks from
 * the current session state (the latest JSONL line). With no args, shows
 * the picker; with a bot name, jumps straight to the confirmation step.
 */
export async function handleForkCommand(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;

  const session = sessionManager.getSession(keyInfo.sessionKey);
  if (!session?.claudeSessionId) {
    await ctx.reply('No active conversation to fork. Send at least one message in this session first.');
    return;
  }

  const jsonlPath = sessionJsonlPath(session.workingDirectory, session.claudeSessionId);
  if (!fs.existsSync(jsonlPath)) {
    await ctx.reply('No transcript on disk yet — finish an assistant turn before forking.');
    return;
  }
  const raw = fs.readFileSync(jsonlPath, 'utf-8');
  const lines = raw.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const lineCount = lines.length;
  if (lineCount === 0) {
    await ctx.reply('Transcript is empty — nothing to fork.');
    return;
  }

  // Record a synthetic offset against the user's /fork message so the rest
  // of the flow can reuse the inline-button machinery unchanged. The
  // /fork command itself is the anchor message.
  const anchorMsgId = ctx.message?.message_id;
  if (!anchorMsgId) {
    await ctx.reply('Could not anchor fork — try the 🍴 button on a bot message instead.');
    return;
  }
  messageOffsets.record(keyInfo.sessionKey, anchorMsgId, {
    claudeSessionId: session.claudeSessionId,
    projectPath: session.workingDirectory,
    lineCount,
    conversationId: session.conversationId,
  });
  const offset = messageOffsets.lookup(keyInfo.sessionKey, anchorMsgId);
  if (offset && canForkToThread(ctx)) {
    await forkStraightIntoThread(ctx, keyInfo.sessionKey, offset, anchorMsgId);
    return;
  }

  const projectLabel = path.basename(session.workingDirectory);

  const picker = buildTargetPicker(anchorMsgId);
  await replyFormatted(
    ctx,
    new EntityText()
      .add('🍴 ').bold('Fork conversation').newline(2)
      .add('From the current state of ').bold(projectLabel).add(' — pick where to branch it:').newline(2)
      .add(picker.lines.join('\n'))
      .build(),
    { reply_markup: { inline_keyboard: picker.keyboard } },
  );
}

/**
 * What the spun-off conversation is compacted around: the task, and that the
 * rest of the work stays with the conversation it came from.
 */
export function spinoffCompactFocus(task: string): string {
  return 'This conversation is being spun off into a new session for one task, which is the next message. '
    + 'Keep what that task needs: the decisions, constraints and knowledge of the code that bear on it. '
    + 'The original conversation carries on separately in the same working directory, with its own work '
    + 'and background tasks; mention those only as far as they affect this task, and as belonging to the '
    + `other session, not this one. The task: ${task}`;
}

/**
 * /spinoff <task> — split one task off into a conversation of its own. The
 * conversation as it stands (past a running turn, as "Ask in a fork" takes
 * it) goes into a new thread, is compacted there around the task, and the
 * task goes in as the first prompt. This thread carries on unchanged, so it
 * works mid-turn: it's registered ahead of sequentialize, and the new thread
 * has a queue of its own.
 *
 * Unlike a /fork, which takes the whole conversation along, the spinoff
 * starts with only what its task needs, and starts on it without waiting for
 * another message.
 *
 * Sent as a reply to one of the bot's messages, it spins off from that point
 * instead, the way that message's 🍴 button forks: for a task planned before
 * a tangent the spinoff has no need of.
 *
 * The thread is named after the task, not the conversation it came from. A
 * thread's name is its topic's general half, which the topic summarizer keeps
 * from one message to the next, so the source's topic would name the thread
 * for good. Asked with no previous topic, it names the task's own area.
 */
export async function handleSpinoffCommand(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  const message = ctx.message;
  if (!keyInfo || !message?.text) return;

  const argStart = message.text.match(/^\/spinoff(?:@\w+)?\s*/i)?.[0].length ?? message.text.length;
  const task = message.text.slice(argStart).trim();
  if (!task) {
    await ctx.reply(
      'Usage: /spinoff <task>\n\n'
      + 'Opens a new thread with this conversation compacted around the task, and starts on it there. '
      + 'This thread carries on as it is. Send it as a reply to one of my messages to spin off from that point.',
    );
    return;
  }
  if (!canForkToThread(ctx)) {
    await ctx.reply('A spinoff opens a new thread, and threads are off for this bot.');
    return;
  }

  // In a thread, a message that isn't a reply still carries the thread's
  // opening service message as its reply_to_message; that isn't a fork point.
  const repliedTo = message.reply_to_message?.forum_topic_created ? undefined : message.reply_to_message;
  const offset = repliedTo && messageOffsets.lookup(keyInfo.sessionKey, repliedTo.message_id);
  if (repliedTo && !offset) {
    await ctx.reply(
      "There's no fork point on that message. Reply to one of my replies to spin off from there, "
      + 'or send /spinoff without replying to spin off from where the conversation is now.',
    );
    return;
  }
  const cut = offset ? cutFork(ctx, keyInfo.sessionKey, offset) : forkOfLatest(ctx, keyInfo.sessionKey);
  if ('error' in cut) {
    await ctx.reply(cut.error);
    return;
  }
  const { fork } = cut;
  if (config.AUTO_TOPIC_HAIKU) {
    fork.topic = await summarizeTopicWithHaiku(task, undefined, path.basename(fork.projectPath)) ?? fork.topic;
  }

  const opened = await openForkThread(ctx, keyInfo.sessionKey, fork, {
    above: 'The conversation it was spun off from carries on in its own thread. '
      + 'This one is compacted around the task below first, then starts on it.',
  });
  if ('error' in opened) {
    await ctx.reply(opened.error);
    return;
  }

  let taskLineId: number | undefined;
  try {
    taskLineId = (await sendFormatted(ctx.api, message.chat.id, youLine(task, MARKER_PROMPT_LEN), {
      message_thread_id: opened.threadId,
    })).message_id;
  } catch (err) {
    console.warn('[Spinoff] Could not post the You line:', sanitizeError(err));
  }

  const b = new EntityText().add('🍴 ').bold('Spun off into ');
  if (opened.link) b.link(opened.name, opened.link);
  else b.bold(opened.name);
  b.newline(2).italic('It compacts this conversation around the task, then starts on it. This thread carries on unchanged.');
  try {
    await replyFormatted(ctx, b.build(), {
      reply_parameters: { message_id: message.message_id },
      ...(opened.link ? { reply_markup: { inline_keyboard: [[{ text: `Open ${opened.name}`, url: opened.link }]] } } : {}),
    });
  } catch (err) {
    console.warn('[Spinoff] Could not confirm:', sanitizeError(err));
  }

  // The compact and then the task, each as if typed in the new thread. Each
  // replay settles once its turn is over, so the task waits for the compact.
  // Their own ids, or the message handler would take the second for a retry
  // of the first: the /spinoff's for the compact (the handler never saw it),
  // the You line's for the task.
  const compact = `/compact ${spinoffCompactFocus(task)}`;
  const taskEntities = message.entities
    ?.filter((e) => e.offset >= argStart && e.type !== 'bot_command')
    .map((e) => ({ ...e, offset: e.offset - argStart }));
  void (async () => {
    await replayIntoThread(ctx.update, opened.threadId, {
      text: compact,
      entities: [{ type: 'bot_command', offset: 0, length: '/compact'.length }],
    });
    await replayIntoThread(ctx.update, opened.threadId, {
      text: task,
      entities: taskEntities?.length ? taskEntities : undefined,
      ...(taskLineId ? { message_id: taskLineId } : {}),
    });
  })().catch((err: unknown) => {
    console.error(`[Spinoff] Starting the spinoff in thread ${opened.threadId} failed:`, sanitizeError(err));
  });
}

export async function handleAcceptCommand(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  const userId = ctx.from?.id;
  if (!keyInfo || !userId) return;
  const fork = getPendingFork(BOT_ID, userId);
  if (!fork) {
    await ctx.reply('There is no pending fork to accept.');
    return;
  }
  await loadFork(ctx, keyInfo.sessionKey, fork);
  removePendingFork(BOT_ID, userId);
}

export async function handleDeclineCommand(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;
  if (!getPendingFork(BOT_ID, userId)) {
    await ctx.reply('There is no pending fork to decline.');
    return;
  }
  removePendingFork(BOT_ID, userId);
  await ctx.reply('❌ Fork discarded.');
}

/**
 * Take a pending fork, write the truncated JSONL to a fresh session file in
 * the source project's Claude Code dir, and point this bot's session at it.
 * If the project we're forking into is different from the current one, the
 * session-manager call mints a fresh conversation in the new cwd; if it's
 * the same project, we still want a fresh conversation so we don't tack the
 * old transcript onto whatever's already loaded.
 *
 * `marker` rewords the banner for a caller whose fork doesn't come from the
 * chat above it — /tree branches from any point, not the message you tapped.
 */
export async function loadFork(
  ctx: Context,
  sessionKey: string,
  fork: PendingFork,
  marker?: ForkMarkerOptions,
): Promise<void> {
  // Generate a fresh sessionId for this bot's copy of the transcript. We
  // rewrite the `sessionId` field in each record so the file is internally
  // consistent — Claude Code stamps the original session's id into every
  // record, and a resume can get confused if the filename and contents
  // disagree.
  const newSessionId = crypto.randomUUID();
  const rewritten = rewriteJsonlSessionId(fork.jsonl, newSessionId);

  const targetPath = sessionJsonlPath(fork.projectPath, newSessionId);
  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, rewritten, { mode: 0o600 });
  } catch (err) {
    console.error('[Fork] Failed to write target JSONL:', err);
    await ctx.reply('❌ Failed to load fork: could not write transcript to disk.');
    return;
  }

  // The branch point, for the 🍴 Fork button on the done message below.
  // Counted before the session points at the file: from then on the next
  // turn appends to it.
  const loadedLineCount = countJsonlLines(targetPath);

  // Reset this bot's session to the forked project + transcript. Calling
  // setWorkingDirectory mints a fresh conversation; if the project matches
  // an existing session, we still want a clean slate, so we follow up with
  // startNewConversation when needed.
  const existing = sessionManager.getSession(sessionKey);
  if (existing && existing.workingDirectory === fork.projectPath) {
    sessionManager.startNewConversation(sessionKey);
  } else {
    sessionManager.setWorkingDirectory(sessionKey, fork.projectPath);
  }
  sessionManager.setClaudeSessionId(sessionKey, newSessionId);

  // Sever any live process bound to the old session. A long-lived
  // `claude` process is reused as long as its cwd is unchanged (see
  // PtyProvider._getOrCreateSession) — so a same-project fork would otherwise
  // keep serving the pre-fork session and silently ignore the branch we just
  // loaded. Tearing it down (exactly what /clear does) forces the next turn to
  // respawn with `--resume <newSessionId>` onto the forked transcript. Order
  // matters: this must run AFTER setClaudeSessionId, since clearConversation
  // leaves sessionManager's session id untouched — only the live process and
  // in-memory provider state are dropped.
  clearConversation(sessionKey);

  // Restore the source topic, for the status line and the thread name.
  //
  // Even with no topic to restore: the one in memory is the conversation this
  // chat just left, and a fork that arrives without a topic — from a chat
  // that had none, or from /tree, where no history may name the point — would
  // otherwise carry it on. Restoring none falls back to the title Claude Code
  // gave the transcript.
  restoreTopic(sessionKey, fork.topic);

  await postMarker(ctx, sessionKey, buildForkMarker(fork, marker), {
    claudeSessionId: newSessionId,
    projectPath: fork.projectPath,
    lineCount: loadedLineCount,
  });
}

/**
 * Put a banner where the chat switched conversations — over the message whose
 * button made the switch, or as a reply to the command that did — and anchor
 * its 🍴 Fork button at `point`.
 *
 * The banner is where the new conversation starts in this chat, so it forks
 * that point: sending it to another bot, or branching it again here, doesn't
 * mean scrolling back to the message it was first taken from. Like that
 * message's button, it forks the transcript as it was at that point, whatever
 * the conversation has done since. Its 🌳 button opens the tree the
 * conversation is part of.
 *
 * A marker Telegram won't format still has to land in plain text: left
 * unedited, the message would go on offering the buttons that made the switch.
 * The send helpers retry it unformatted.
 */
export async function postMarker(
  ctx: Context,
  sessionKey: string,
  marker: EntityMessage,
  point: { claudeSessionId: string; projectPath: string; lineCount: number },
): Promise<void> {
  try {
    let anchorId: number | undefined;
    if (ctx.callbackQuery) {
      await editCallbackMessage(ctx, marker, { reply_markup: BRANCH_MARKER_KEYBOARD });
      anchorId = ctx.callbackQuery.message?.message_id;
    } else {
      const sent = await replyFormatted(ctx, marker, { reply_markup: BRANCH_MARKER_KEYBOARD });
      anchorId = sent.message_id;
    }
    if (anchorId) {
      messageOffsets.record(sessionKey, anchorId, {
        ...point,
        conversationId: sessionManager.getSession(sessionKey)?.conversationId,
      });
    }
  } catch { /* ignore */ }
}

/** A line heavy enough to read as a break in the chat, short enough for a phone. */
const MARKER_RULE = '━'.repeat(16);

/**
 * How long the prompt a fork picks up after can run before the banner shows
 * only its start and its end: as long as /prompts and the status line let one
 * run. The longest reply a banner holds still fits in the message with it.
 */
const MARKER_PROMPT_LEN = 300;

/**
 * How much of the reply a fork picks up after its marker holds. Telegram caps
 * a message at 4096 characters, and the rest of the banner has to fit too.
 */
const MARKER_REPLY_LEN = 3000;

/** What a switch left above the banner, when it wasn't the conversation branched from. */
export const LEFT_ABOVE = "What's above is the conversation you were in — it's in /resume.";

export interface ForkMarkerOptions {
  /** What the closing line says went where — the conversation above the banner. */
  above?: string;
}

/**
 * The message a loaded fork leaves in its chat: a banner where
 * one conversation ends and another begins.
 *
 * Scrolled back through, the messages on either side of it would otherwise
 * read as one thread — and for a branch taken in the same chat, the messages
 * just above even carry on past the point the branch starts from. So it says
 * outright that a new conversation starts here, shows the exchange it picks
 * up after, and says where the conversation above went.
 *
 * The reply goes in whole, collapsed. A fork to another bot would otherwise
 * leave it in the other bot's chat, and a branch taken here would leave the
 * last reply above your next message one the branch never had.
 */
export function buildForkMarker(fork: PendingFork, opts: ForkMarkerOptions = {}): EntityMessage {
  const isBranch = fork.fromBotId === BOT_ID;
  return buildMarker({
    title: isBranch ? '🌱 New branch' : `🍴 Forked from ${fork.fromBotName}`,
    name: sessionDisplayName({ projectName: path.basename(fork.projectPath), topic: fork.topic }),
    lead: 'A new conversation starts here.',
    after: 'It picks up after:',
    exchange: lastExchangeIn(fork.jsonl),
    above: opts.above ?? (isBranch
      ? "What's above is the conversation you branched from — it's in /resume."
      : "What's above is this bot's previous conversation — it's in /resume."),
  });
}

/**
 * The banner for going back to a branch that already exists: the same break
 * in the chat as a fork's, except the conversation below it isn't new — it
 * carries on from the exchange shown.
 */
export function buildBackOnBranchMarker(branch: { projectPath: string; topic?: string; jsonl: string }): EntityMessage {
  return buildMarker({
    title: '↪️ Back on a branch',
    name: sessionDisplayName({ projectName: path.basename(branch.projectPath), topic: branch.topic }),
    lead: "You're back on an earlier branch.",
    after: 'It carries on from:',
    exchange: lastExchangeIn(branch.jsonl),
    above: LEFT_ABOVE,
  });
}

function buildMarker(parts: {
  title: string;
  name: string;
  lead: string;
  after: string;
  exchange?: RecapExchange;
  above: string;
}): EntityMessage {
  const { title, name, lead, after, exchange, above } = parts;
  return joinMessages([
    plain(MARKER_RULE),
    new EntityText().bold(title).build(),
    plain(MARKER_RULE),
    plain(name),
    plain(''),
    ...(exchange
      ? [
          plain(`${lead} ${after}`),
          youLine(exchange.user, MARKER_PROMPT_LEN),
          ...replyQuote(exchange.assistant),
        ]
      : [plain(lead)]),
    plain(''),
    new EntityText().italic(above).build(),
  ], '\n');
}

/** `You: <prompt>`, the prompt on one line: how a banner or a node names what was asked. */
export function youLine(user: string, max: number): EntityMessage {
  return new EntityText().bold('You:').add(` ${promptLine(user, max)}`).build();
}

/**
 * The prompt of an exchange, on one line: cleaned the way promptLabel cleans
 * one — a paste's text without its tags, an upload's caption, the words
 * written under a quote — or as the log has it when it was a command. Whole
 * up to `max` characters, past that by its start and its end.
 */
export function promptLine(user: string, max: number): string {
  return cutLabel(promptLabel(user) ?? user.replace(/\s+/g, ' ').trim(), max);
}

/**
 * The first `end` UTF-16 units of `text`, one fewer when the cut would fall
 * inside an emoji. Half a surrogate pair is not valid text, and Telegram
 * rejects a message carrying one.
 */
function sliceWhole(text: string, end: number): string {
  const last = text.charCodeAt(end - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end);
}

/**
 * The reply as a collapsed quote. A quote holds plain text only, so markdown
 * markers go rather than show up as stray asterisks, backticks and hashes. A
 * reply longer than `max` is cut at a line or word, followed by `rest` — by
 * default, naming /recap, which shows the reply whole, formatted. One message
 * per line of the result.
 */
export function replyQuote(
  reply: string,
  max: number = MARKER_REPLY_LEN,
  rest: string | null = 'The rest of the reply is in /recap.',
): EntityMessage[] {
  const text = reply
    .replace(/^\s*```.*$/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const collapsed = (body: string) => new EntityText().quote(body, true).build();
  if (text.length <= max) return [collapsed(text)];

  const cut = sliceWhole(text, max);
  const end = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '));
  return [
    collapsed(`${(end > 0 ? cut.slice(0, end) : cut).trimEnd()} …`),
    ...(rest ? [plain(rest)] : []),
  ];
}

/**
 * Proactively DM the fork offer to the user as soon as it lands, without
 * waiting for them to type something into the target bot.
 *
 * Implementation: poll the mtime of pending-forks-<botId>.json every few
 * seconds. On change (and once at startup), scan for entries where
 * `offered` is unset and the userId is allowed (`.env` or the roster). For each, try
 * bot.api.sendMessage(userId, …) — in a Telegram DM, chat_id == user_id,
 * so this hits the user's existing conversation with this bot. On success,
 * stamp `offered: true` so we don't re-send on the next file change.
 *
 * If the send fails (user has never DM'd this bot — "chat not found"),
 * leave the entry unoffered and let the lazy in-message path handle it
 * whenever the user does message the bot.
 */
export function startPendingForkWatcher(bot: Bot): void {
  const filePath = pendingForksPathFor(BOT_ID);
  let lastMtimeMs = 0;
  let scanInFlight = false;

  const tick = async (): Promise<void> => {
    if (scanInFlight) return;
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(filePath).mtimeMs;
    } catch {
      return; // file doesn't exist yet — nothing to do
    }
    if (mtimeMs === lastMtimeMs) return;
    lastMtimeMs = mtimeMs;

    scanInFlight = true;
    try {
      await scanAndOffer(bot);
    } finally {
      scanInFlight = false;
    }
  };

  // Startup scan: there may already be unoffered forks waiting from a
  // crash/restart while a fork was sitting unsent.
  void tick();

  setInterval(() => { void tick(); }, 2_000).unref();
}

async function scanAndOffer(bot: Bot): Promise<void> {
  const entries = listPendingForks(BOT_ID);
  for (const [userIdStr, fork] of Object.entries(entries)) {
    if (fork.offered) continue;
    const userId = Number.parseInt(userIdStr, 10);
    if (!Number.isFinite(userId)) continue;
    if (!isAllowedUser(userId)) continue;

    const offer = buildForkOffer(fork, 'proactive');
    try {
      await sendFormatted(bot.api, userId, offer.text, { reply_markup: offer.keyboard });
      markForkOffered(BOT_ID, userId);
    } catch (err) {
      // 403 "bot can't initiate conversation with a user" / "chat not found"
      // is expected when the user has never DM'd this bot. Leave the fork
      // unoffered so the lazy in-message path picks it up next time the
      // user messages this bot.
      const msg = err instanceof Error ? err.message : String(err);
      console.debug(`[Fork] Proactive offer to ${userIdStr} failed (will retry via lazy path): ${msg}`);
    }
  }
}
