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
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { BOT_ID, config } from '../../config.js';
import { getSessionKeyFromCtx } from '../../utils/session-key.js';
import { messageOffsets, countJsonlLines } from '../../claude/message-offsets.js';
import { FORK_KEYBOARD } from '../../telegram/message-sender.js';
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
import { sessionJsonlPath, lastAssistantTurnText, lastExchangeIn } from '../../claude/session-jsonl.js';
import { sessionManager } from '../../claude/session-manager.js';
import { clearConversation } from '../../providers/provider-router.js';
import { isAllowedUser } from '../../utils/user-roster.js';
import { escapeMarkdownV2 as esc, buildExpandableSyntax } from '../../telegram/markdown.js';
import { restoreTopicAndRefreshBotName } from './command.handler.js';
import { getSessionTopic } from './command.handler.js';
import { sessionDisplayName } from './command/shared.js';

const BOT_NAME = config.BOT_NAME;

interface ForkOfferTexts {
  text: string;
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
 * the way /resume and `claudegram_ask_user` list their options. Cancel keeps
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
      description: BOT_NAME,
      callbackData: `fork:to:${BOT_ID}:${anchorMsgId}`,
    },
    ...listSiblingBots(BOT_ID).map((b) => ({
      label: b.name,
      callbackData: `fork:to:${b.botId}:${anchorMsgId}`,
    })),
  ];

  return {
    lines: letteredOptionLines(targets).map((line) => esc(line)),
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
  const topicLine = fork.topic ? `\n*Topic:* ${esc(fork.topic)}` : '';
  const previewLine = fork.assistantPreview
    ? `\n\n_Last assistant message:_\n${esc(fork.assistantPreview.substring(0, 200))}`
    : '';

  const tail = mode === 'lazy'
    ? `\n\n_Your message was held back so it doesn't get attached to the wrong context\\. Re\\-send it after deciding\\._`
    : '';

  return {
    text:
      `📦 *Fork received from ${esc(fork.fromBotName)}*\n\n` +
      `Project: *${esc(projectLabel)}*${topicLine}${previewLine}\n\n` +
      `Accepting will replace this bot's current conversation \\(saved to /resume history\\)\\. Decline to discard the fork\\.${tail}`,
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

  await ctx.answerCallbackQuery();

  const projectLabel = path.basename(offset.projectPath);

  const picker = buildTargetPicker(msgId);
  await ctx.reply(
    `🍴 *Fork conversation*\n\nFrom this point in *${esc(projectLabel)}* — pick where to branch it:\n\n` +
      picker.lines.join('\n'),
    {
      parse_mode: 'MarkdownV2',
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
  const target = findBotById(targetBotId);
  if (!target) {
    await ctx.answerCallbackQuery({ text: 'Target bot not found.' });
    return;
  }

  await ctx.answerCallbackQuery();

  const projectLabel = path.basename(offset.projectPath);
  const isSelf = targetBotId === BOT_ID;
  const text = isSelf
    ? `🍴 *Branch into a new conversation?*\n\n` +
      `This copies *${esc(projectLabel)}* up to that point into a fresh conversation on this bot\\. ` +
      `Your current conversation is saved to /resume history, and you continue from the branch point\\.`
    : `🍴 *Fork to ${esc(target.name)}?*\n\n` +
      `This will copy the conversation in *${esc(projectLabel)}* up to that point and hand it off to *${esc(target.name)}*\\.\n\n` +
      `When you open *${esc(target.name)}* and send any message, you'll get a prompt to accept the fork\\. ` +
      `Accepting replaces *${esc(target.name)}*'s current conversation \\(saved to its /resume history\\)\\.`;

  try {
    await ctx.editMessageText(text, {
      parse_mode: 'MarkdownV2',
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
  const target = findBotById(targetBotId);
  if (!target) {
    await ctx.answerCallbackQuery({ text: 'Target bot not found.' });
    return;
  }

  // Read source JSONL and slice to the recorded line count
  const sourceJsonl = sessionJsonlPath(offset.projectPath, offset.claudeSessionId);
  if (!fs.existsSync(sourceJsonl)) {
    await ctx.answerCallbackQuery({ text: 'Source transcript no longer on disk.' });
    return;
  }

  let truncated: string;
  try {
    const raw = fs.readFileSync(sourceJsonl, 'utf-8');
    const lines = raw.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const sliced = lines.slice(0, offset.lineCount);
    truncated = sliced.join('\n') + (sliced.length > 0 ? '\n' : '');
  } catch (err) {
    console.error('[Fork] Failed to read source JSONL:', err);
    await ctx.answerCallbackQuery({ text: 'Could not read source transcript.' });
    return;
  }

  const topic = getSessionTopic(keyInfo.sessionKey);
  // The reply the fork was taken from, read out of the cut transcript. The
  // chat's stored preview is its latest reply, which a fork taken from any
  // earlier message doesn't contain.
  const assistantPreview = lastAssistantTurnText(truncated)?.substring(0, 200);

  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.answerCallbackQuery({ text: 'Could not identify user.' });
    return;
  }

  const fork: PendingFork = {
    fromBotName: BOT_NAME,
    fromBotId: BOT_ID,
    fromChatId: ctx.chat?.id,
    projectPath: offset.projectPath,
    jsonl: truncated,
    topic,
    assistantPreview,
    createdAt: new Date().toISOString(),
  };

  // Self-fork: branch within this same bot/chat. The pending-fork handoff
  // (and its accept/decline prompt) only exists to cross bots — here the
  // source and target are the same conversation, so load the branch right
  // now. loadFork saves the current conversation to /resume history first.
  if (targetBotId === BOT_ID) {
    await loadFork(ctx, keyInfo.sessionKey, fork);
    await ctx.answerCallbackQuery({ text: 'Branched.' });
    return;
  }

  // Key the pending fork by Telegram user id, not sessionKey: each bot has
  // its own DM with the user with a different chatId, so the target bot
  // can't find the fork by chatId-based key. User id is constant across
  // bots; the offer will land in whichever chat the user next messages
  // the target bot in.
  putPendingFork(target.botId, userId, fork);

  await ctx.answerCallbackQuery({ text: 'Forked.' });

  const projectLabel = path.basename(offset.projectPath);
  try {
    await ctx.editMessageText(
      `✅ *Forked to ${esc(target.name)}*\n\n` +
        `Open *${esc(target.name)}* and send any message — you'll get the option to accept the forked conversation \\(${esc(projectLabel)}\\)\\.\n\n` +
        `_This conversation carries on here unchanged\\._`,
      { parse_mode: 'MarkdownV2', reply_markup: FORK_KEYBOARD },
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
  await ctx.reply(offer.text, {
    parse_mode: 'MarkdownV2',
    reply_markup: offer.keyboard,
  });
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

  const projectLabel = path.basename(session.workingDirectory);

  const picker = buildTargetPicker(anchorMsgId);
  await ctx.reply(
    `🍴 *Fork conversation*\n\nFrom the current state of *${esc(projectLabel)}* — pick where to branch it:\n\n` +
      picker.lines.join('\n'),
    {
      parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: picker.keyboard },
    },
  );
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
 */
async function loadFork(ctx: Context, sessionKey: string, fork: PendingFork): Promise<void> {
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
  const projectChanged = !existing || existing.workingDirectory !== fork.projectPath;
  if (existing && existing.workingDirectory === fork.projectPath) {
    sessionManager.startNewConversation(sessionKey);
  } else {
    sessionManager.setWorkingDirectory(sessionKey, fork.projectPath);
  }
  sessionManager.setClaudeSessionId(sessionKey, newSessionId);

  // Sever any live process bound to the old session. In PTY mode a long-lived
  // `claude` process is reused as long as its cwd is unchanged (see
  // PtyProvider._getOrCreateSession) — so a same-project fork would otherwise
  // keep serving the pre-fork session and silently ignore the branch we just
  // loaded. Tearing it down (exactly what /clear does) forces the next turn to
  // respawn with `--resume <newSessionId>` onto the forked transcript. Order
  // matters: this must run AFTER setClaudeSessionId, since clearConversation
  // leaves sessionManager's session id untouched — only the live process and
  // in-memory provider state are dropped.
  clearConversation(sessionKey);

  // Restore the source topic AND (if the project changed) refresh the bot's
  // Telegram display name so the user sees the new project reflected in the
  // bot name on the next message. restoreTopicAndRefreshBotName handles both
  // the topic write and the rate-limited setMyName call internally.
  if (projectChanged || fork.topic) {
    await restoreTopicAndRefreshBotName(ctx, sessionKey, fork.topic);
  }

  // The marker is where the branch starts in this chat, so it carries a
  // 🍴 Fork button of its own. Forking the same point again — to another bot,
  // or into another branch here — then doesn't mean scrolling back to the
  // message this fork was first taken from. Like that message's button, it
  // forks the transcript as it was at that point, whatever the conversation
  // has done since.
  //
  // A marker Telegram won't parse still has to land in plain text: left
  // unedited, the message would go on offering Accept and Decline for a fork
  // that is already loaded.
  const marker = buildForkMarker(fork);
  const plain = plainMarker(marker);
  try {
    let anchorId: number | undefined;
    if (ctx.callbackQuery) {
      await ctx.editMessageText(marker, { parse_mode: 'MarkdownV2', reply_markup: FORK_KEYBOARD })
        .catch(() => ctx.editMessageText(plain, { reply_markup: FORK_KEYBOARD }));
      anchorId = ctx.callbackQuery.message?.message_id;
    } else {
      const sent = await ctx.reply(marker, { parse_mode: 'MarkdownV2', reply_markup: FORK_KEYBOARD })
        .catch(() => ctx.reply(plain, { reply_markup: FORK_KEYBOARD }));
      anchorId = sent.message_id;
    }
    if (anchorId) {
      messageOffsets.record(sessionKey, anchorId, {
        claudeSessionId: newSessionId,
        projectPath: fork.projectPath,
        lineCount: loadedLineCount,
        conversationId: sessionManager.getSession(sessionKey)?.conversationId,
      });
    }
  } catch { /* ignore */ }
}

/** A line heavy enough to read as a break in the chat, short enough for a phone. */
const MARKER_RULE = '━'.repeat(16);

/** How far the prompt a fork picks up after may run on its one line. */
const MARKER_PROMPT_LEN = 120;

/**
 * How much of the reply a fork picks up after its marker holds. Telegram caps
 * a message at 4096 characters, and the rest of the banner has to fit too.
 */
const MARKER_REPLY_LEN = 3000;

/**
 * The message a loaded fork leaves in its chat, in MarkdownV2: a banner where
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
export function buildForkMarker(fork: PendingFork): string {
  const isBranch = fork.fromBotId === BOT_ID;
  const title = isBranch ? '🌱 New branch' : `🍴 Forked from ${fork.fromBotName}`;
  const name = sessionDisplayName({ projectName: path.basename(fork.projectPath), topic: fork.topic });
  const exchange = lastExchangeIn(fork.jsonl);
  const above = isBranch
    ? "What's above is the conversation you branched from — it's in /resume."
    : "What's above is this bot's previous conversation — it's in /resume.";

  return [
    MARKER_RULE,
    `*${esc(title)}*`,
    MARKER_RULE,
    esc(name),
    '',
    ...(exchange
      ? [
          esc('A new conversation starts here. It picks up after:'),
          `*You:* ${esc(oneLine(exchange.user, MARKER_PROMPT_LEN))}`,
          ...replyQuote(exchange.assistant),
        ]
      : [esc('A new conversation starts here.')]),
    '',
    `_${esc(above)}_`,
  ].join('\n');
}

/** `text` flattened onto one line and cut at `max` characters. */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/**
 * The reply as a collapsed quote. A quote holds plain text only, so markdown
 * markers go rather than show up as stray asterisks, backticks and hashes. A
 * reply too long for the message is cut at a line or word, and names /recap —
 * which shows the reply whole, formatted — for the rest.
 */
function replyQuote(reply: string): string[] {
  const text = reply
    .replace(/^\s*```.*$/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length <= MARKER_REPLY_LEN) return [buildExpandableSyntax(text)];

  const cut = text.slice(0, MARKER_REPLY_LEN);
  const end = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '));
  return [
    buildExpandableSyntax(`${cut.slice(0, end > 0 ? end : MARKER_REPLY_LEN).trimEnd()} …`),
    esc('The rest of the reply is in /recap.'),
  ];
}

/**
 * The marker as plain text, for when Telegram won't parse it: markup dropped
 * and escapes undone. esc() escapes every marker character in the content, so
 * only the markup's own bare `*`, `_`, `>` and `||` match here.
 */
function plainMarker(marker: string): string {
  return marker
    .replace(/^\*\*>|^>/gm, '')
    .replace(/(?<!\\)\|\|$/gm, '')
    .replace(/(?<!\\)[*_]/g, '')
    .replace(/\\(.)/g, '$1');
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
      await bot.api.sendMessage(userId, offer.text, {
        parse_mode: 'MarkdownV2',
        reply_markup: offer.keyboard,
      });
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

function rewriteJsonlSessionId(jsonl: string, newSessionId: string): string {
  if (!jsonl.trim()) return jsonl;
  const lines = jsonl.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (!line) { out.push(line); continue; }
    try {
      const rec = JSON.parse(line) as Record<string, unknown>;
      if (typeof rec.sessionId === 'string') rec.sessionId = newSessionId;
      out.push(JSON.stringify(rec));
    } catch {
      // Pass through anything we can't parse — better than corrupting the file.
      out.push(line);
    }
  }
  return out.join('\n');
}
