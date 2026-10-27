/**
 * /prompts — what you typed in a conversation, a line each, and a way back to
 * any point in it.
 *
 * The list answers "what was this conversation about?" without paying for the
 * replies again — that's the whole difference from /recap, which re-sends
 * every reply in full and buries the prompts you came back to read. It keys
 * each prompt by a letter the way /tree keys its points, and the buttons are
 * just the letters. A letter opens its prompt — the exchange it started — and
 * what can be done from where that exchange ended:
 *
 *   🌱 New branch from here   carry on just after that reply, in a new
 *                             conversation; this one stays in /resume
 *
 * which is the 🍴 Fork button under that reply, without scrolling up to it.
 * A prompt another branch already splits off at is marked 🌿, and 🌳 shows
 * the tree, where that branch can be carried on.
 *
 * Callback data has to fit in 64 bytes. A prompt is named by its record's
 * uuid, and its conversation by the first 8 characters of the session id:
 *
 *   prompts:l:<session8>:<n>          the list, of the last n prompts
 *   prompts:o:<session8>:<n>:<uuid>   open a prompt; n is for the way back
 *   prompts:b:<session8>:<uuid>       branch from the end of its exchange
 *
 * Every tap re-reads the transcript, which only ever grows, so a message sent
 * before the conversation moved on still finds each prompt where it was.
 */

import { Context } from 'grammy';
import * as fs from 'fs';
import * as path from 'path';
import { BOT_ID, config } from '../../config.js';
import { getSessionKeyFromCtx } from '../../utils/session-key.js';
import { sanitizeError } from '../../utils/sanitize.js';
import { findHistoryOwners } from '../../claude/session-history.js';
import { isProcessing } from '../../claude/request-queue.js';
import {
  lastAssistantTurnText,
  lastExchangeIn,
  sessionJsonlPath,
  userPromptsIn,
  type UserPrompt,
} from '../../claude/session-jsonl.js';
import { splitsAlong, transcriptDir, treeOf, type ForkTree } from '../../claude/fork-tree.js';
import type { PendingFork } from '../../claude/pending-forks.js';
import { escapeMarkdownV2 as esc } from '../../telegram/markdown.js';
import { buildLetterKeyboard, optionLetter } from '../../telegram/lettered-options.js';
import { cutLabel, promptLabel } from '../../telegram/prompt-label.js';
import { getSessionTopic } from './command.handler.js';
import { formatTimeAgo, replyMd } from './command/shared.js';
import { NO_PROJECT_MESSAGE, whereChatIs } from './session-guard.js';
import { LEFT_ABOVE, loadFork, promptLine, replyQuote } from './fork.handler.js';
import { showTreeButton } from './tree.handler.js';
import { refuseWhileBusy, sendView, type Keyboard, type View } from './view.js';

// Most prompts are short (a median line of 72 characters across 40 recent
// sessions), so the default can reach well back: 15 fit in one message in all
// 40, about two phone screens. 25 fit in 35 of them, and the budget below cuts
// the rest oldest-first, so a higher cap would mostly buy a "trimmed" note.
// Past 300 characters a prompt shows by its start and its end, as /tree and
// the status line show one.
const PROMPTS_MAX_CHARS = 300;
const PROMPTS_DEFAULT_N = 15;
const PROMPTS_MAX_N = 25;
// Telegram's hard cap is 4096 chars per message. Budget below it for the
// lines, leaving room for the header, the legend and the newlines.
const PROMPTS_BUDGET_CHARS = 3800;

/**
 * How much of the reply a prompt's view shows: as much as a /tree point's
 * view. It's a menu, read before choosing, and the whole reply is up in the
 * chat.
 */
const PROMPT_REPLY_LEN = 1200;

/** A prompt as /prompts shows it: one that was a turn of the conversation. */
interface Prompt extends UserPrompt {
  /** What was asked, cleaned of what got wrapped around it. */
  label: string;
  /** Whether another branch of the conversation splits off during its exchange. */
  branched: boolean;
}

/** A conversation as /prompts reads it. */
export interface Conversation {
  projectPath: string;
  sessionId: string;
  /** The transcript, as read. */
  raw: string;
  /** Its prompts, oldest first. */
  prompts: Prompt[];
  /** The tree it's part of, once it has been forked. */
  tree?: ForkTree;
}

/** The first 8 characters of a session id: enough to find it among one project's transcripts. */
const session8Of = (conversation: Conversation) => conversation.sessionId.slice(0, 8);

// ── Reading ──────────────────────────────────────────────────────────────

function readConversation(projectPath: string, sessionId: string): Conversation | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(sessionJsonlPath(projectPath, sessionId), 'utf-8');
  } catch {
    return undefined;
  }

  // A /compact and the records it leaves aren't prompts, and would each take
  // one of the n lines.
  const turns = userPromptsIn(raw).flatMap((p) => {
    const label = promptLabel(p.text);
    return label ? [{ ...p, label }] : [];
  });

  // A branch splitting off anywhere between one prompt and the next splits off
  // during the first one's exchange.
  const tree = treeOf(projectPath, sessionId);
  const forked = tree && tree.transcripts.size > 1 ? tree : undefined;
  const splits = forked ? splitsAlong(forked, sessionId) : [];
  const prompts = turns.map((p, i) => {
    const next = turns[i + 1]?.line ?? Infinity;
    return { ...p, branched: splits.some((s) => s.line >= p.line && s.line < next) };
  });

  return { projectPath, sessionId, raw, prompts, tree: forked };
}

/**
 * The conversation a button names by `session8`, in the chat's project — the
 * chat's own when its id starts that way — holding the prompt `uuid` when one
 * is named.
 */
function findConversation(
  projectPath: string,
  session8: string,
  chatSessionId?: string,
  uuid?: string,
): Conversation | undefined {
  const holds = (c: Conversation | undefined) => c && (!uuid || c.prompts.some((p) => p.uuid === uuid));
  if (chatSessionId?.startsWith(session8)) {
    const conversation = readConversation(projectPath, chatSessionId);
    if (holds(conversation)) return conversation;
  }

  let names: string[] = [];
  try {
    names = fs.readdirSync(transcriptDir(projectPath));
  } catch { /* nothing has run in this project */ }
  for (const name of names) {
    if (!name.startsWith(session8) || !name.endsWith('.jsonl')) continue;
    const sessionId = name.slice(0, -'.jsonl'.length);
    if (sessionId === chatSessionId) continue;
    const conversation = readConversation(projectPath, sessionId);
    if (holds(conversation)) return conversation;
  }
  return undefined;
}

/** The topic of the history that last had the conversation open, in any bot. */
function lastTopicOf(sessionId: string): string | undefined {
  return [...findHistoryOwners([sessionId], BOT_ID).values()].flat()
    .sort((a, b) => b.entry.lastActivity.localeCompare(a.entry.lastActivity))[0]?.entry.topic;
}

/** The transcript up to the end of `prompt`'s exchange: what a branch from just after its reply starts with. */
function cutAfter(conversation: Conversation, prompt: Prompt): string {
  return conversation.raw.split('\n').slice(0, prompt.endLine).join('\n') + '\n';
}

// ── Views ────────────────────────────────────────────────────────────────

const timeOf = (prompt: Prompt) => (prompt.timestamp ? formatTimeAgo(new Date(prompt.timestamp)) : 'earlier');

/** A prompt's line in the list. Its marks sit by the time, where a long prompt doesn't bury them. */
function listLine(prompt: Prompt, letter: string): string {
  const marks = `${prompt.branched ? ' 🌿' : ''}${prompt.pending ? ' ⏳' : ''}`;
  return `*${esc(letter)}* · _${esc(timeOf(prompt))}_${marks} — ${esc(cutLabel(prompt.label, PROMPTS_MAX_CHARS))}`;
}

/**
 * The prompts the list shows: the last `n`, less the oldest of them when they
 * won't all fit in one message.
 *
 * The budget is spent newest-first: 25 pasted prompts can exceed one Telegram
 * message, and when something has to go it should be the oldest, not the one
 * you just sent. Every letter is one character, so measuring each line as `A`
 * measures it as whichever letter it ends up with.
 */
function listed(conversation: Conversation, n: number): Prompt[] {
  const recent = conversation.prompts.slice(-n);
  let from = recent.length;
  let used = 0;
  while (from > 0) {
    const length = listLine(recent[from - 1]!, 'A').length + 1;
    if (from < recent.length && used + length > PROMPTS_BUDGET_CHARS) break;
    used += length;
    from--;
  }
  return recent.slice(from);
}

/**
 * The last `n` prompts of a conversation in one message, oldest first so it
 * reads in the same order as the chat above it: a letter per prompt and a
 * button per letter, the way /tree draws its points.
 */
export function renderPrompts(conversation: Conversation, n: number): View {
  const shown = listed(conversation, n);
  const project = esc(path.basename(conversation.projectPath));
  if (shown.length === 0) return { text: `💬 *${project}* — no prompts yet\\.`, keyboard: [] };

  const noun = shown.length === 1 ? 'prompt' : 'prompts';
  const count = shown.length === conversation.prompts.length ? `${shown.length} ${noun}` : `last ${shown.length} ${noun}`;
  const dropped = Math.min(n, conversation.prompts.length) - shown.length;
  const legend = [
    ...(shown.some((p) => p.branched) ? ['🌿 a branch splits off here'] : []),
    ...(shown.some((p) => p.pending) ? ['⏳ no reply'] : []),
  ];

  const text = [
    `💬 *${project}* — ${esc(count)}${dropped > 0 ? esc(` (${dropped} older trimmed to fit)`) : ''}`,
    '',
    ...shown.map((p, i) => listLine(p, optionLetter(i))),
    '',
    ...(legend.length > 0 ? [`_${esc(legend.join(' · '))}_`] : []),
    esc('Tap a letter to open that prompt.'),
  ].join('\n');

  const keyboard: Keyboard = [
    ...buildLetterKeyboard(shown.map((p) => `prompts:o:${session8Of(conversation)}:${n}:${p.uuid}`)),
    ...(conversation.tree && shown.some((p) => p.branched) ? [[showTreeButton(conversation.tree)]] : []),
  ];
  return { text, keyboard };
}

/**
 * One prompt: the exchange it started, and what can be done from where that
 * exchange ended. `running` says the chat's reply to it is being written now.
 */
export function renderPrompt(conversation: Conversation, prompt: Prompt, n: number, running = false): View {
  // Its letter in the list as it stands now; one the conversation has since
  // moved past the last n of goes without.
  const index = listed(conversation, n).indexOf(prompt);
  const facts = [timeOf(prompt)];
  if (prompt.pending) facts.push(running ? 'being answered now' : 'no reply');
  const reply = prompt.pending ? undefined : lastExchangeIn(cutAfter(conversation, prompt))?.assistant;

  const text = [
    `💬 ${index >= 0 ? `*${esc(optionLetter(index))}* · ` : ''}${esc(facts.join(' · '))}`,
    ...(prompt.branched ? [esc('🌿 Another branch splits off here.')] : []),
    '',
    `*You:* ${esc(promptLine(prompt.text, PROMPTS_MAX_CHARS))}`,
    // Cut without pointing at /recap: that shows the last few exchanges, which
    // this one may not be among.
    ...(reply ? replyQuote(reply, PROMPT_REPLY_LEN, null) : []),
  ].join('\n');

  const keyboard: Keyboard = [
    // A prompt with no reply has no end to its exchange to branch from.
    ...(prompt.pending
      ? []
      : [[{ text: '🌱 New branch from here', callback_data: `prompts:b:${session8Of(conversation)}:${prompt.uuid}` }]]),
    ...(prompt.branched && conversation.tree ? [[showTreeButton(conversation.tree)]] : []),
    [{ text: '⬅️ Back to the prompts', callback_data: `prompts:l:${session8Of(conversation)}:${n}` }],
  ];
  return { text, keyboard };
}

// ── Commands and taps ────────────────────────────────────────────────────

/** `n` as the list takes it: the default when missing or not a count, never past the most. */
function countOf(arg: string | undefined): number | undefined {
  if (!arg) return PROMPTS_DEFAULT_N;
  const parsed = parseInt(arg, 10);
  return Number.isNaN(parsed) || parsed < 1 ? undefined : Math.min(parsed, PROMPTS_MAX_N);
}

export async function handlePromptsCommand(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;

  const n = countOf((ctx.message?.text || '').split(' ').slice(1).join(' ').trim());
  if (n === undefined) {
    await replyMd(ctx, `⚠️ Usage: \`/prompts [N]\` where N is the number of prompts \\(default ${PROMPTS_DEFAULT_N}, max ${PROMPTS_MAX_N}\\)\\.`);
    return;
  }

  // Read, never loaded: after a restart it's where the chat left off, as /tree draws it.
  const where = whereChatIs(keyInfo.sessionKey);
  if (!where) {
    await ctx.reply(NO_PROJECT_MESSAGE, { parse_mode: 'MarkdownV2' });
    return;
  }
  if (!where.sessionId) {
    await replyMd(ctx, 'ℹ️ This session has no recorded messages yet\\.');
    return;
  }
  const conversation = readConversation(where.projectPath, where.sessionId);
  if (!conversation || conversation.prompts.length === 0) {
    await replyMd(ctx, 'ℹ️ No prompts found in this session yet\\.');
    return;
  }

  await sendView(ctx, renderPrompts(conversation, n), 'reply');
}

export async function handlePromptsCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!data || !keyInfo) return;
  const { sessionKey } = keyInfo;
  const [, action, session8, ...rest] = data.split(':');
  const n = countOf(action === 'b' ? undefined : rest[0]) ?? PROMPTS_DEFAULT_N;
  const uuid = action === 'o' ? rest[1] : action === 'b' ? rest[0] : undefined;

  try {
    const where = whereChatIs(sessionKey);
    const conversation = where && session8 ? findConversation(where.projectPath, session8, where.sessionId, uuid) : undefined;
    if (!where || !conversation) {
      await ctx.answerCallbackQuery({ text: "That conversation isn't in this chat's project any more — send /prompts again." });
      return;
    }

    if (action === 'l') {
      await ctx.answerCallbackQuery();
      await sendView(ctx, renderPrompts(conversation, n), 'edit');
      return;
    }

    const prompt = conversation.prompts.find((p) => p.uuid === uuid);
    if (!prompt) {
      await ctx.answerCallbackQuery({ text: "That prompt isn't in the conversation any more — send /prompts again." });
      return;
    }
    // The chat is on this conversation: not a restart's leftover, which isn't loaded.
    const onIt = where.live && where.sessionId === conversation.sessionId;

    if (action === 'o') {
      await ctx.answerCallbackQuery();
      const running = onIt && isProcessing(sessionKey) && prompt === conversation.prompts.at(-1);
      await sendView(ctx, renderPrompt(conversation, prompt, n, running), 'edit');
    } else if (action === 'b') {
      await onBranch(ctx, sessionKey, conversation, prompt, onIt);
    } else {
      await ctx.answerCallbackQuery({ text: 'Unknown prompts action.' });
    }
  } catch (err) {
    console.error('[Prompts] callback failed:', sanitizeError(err));
    try {
      await ctx.answerCallbackQuery({ text: 'That failed — see bot logs.' });
    } catch { /* already answered */ }
  }
}

/**
 * Start a conversation in this chat from the transcript cut just after
 * `prompt`'s reply: a branch, loaded straight away, the way /tree branches
 * from a point and the 🍴 under a reply does.
 */
async function onBranch(
  ctx: Context,
  sessionKey: string,
  conversation: Conversation,
  prompt: Prompt,
  onIt: boolean,
): Promise<void> {
  if (prompt.pending) {
    await ctx.answerCallbackQuery({ text: 'That prompt has no reply to branch after.' });
    return;
  }
  if (await refuseWhileBusy(ctx, sessionKey)) return;

  const jsonl = cutAfter(conversation, prompt);
  const fork: PendingFork = {
    fromBotName: config.BOT_NAME,
    fromBotId: BOT_ID,
    fromChatId: ctx.chat?.id,
    projectPath: conversation.projectPath,
    jsonl,
    topic: onIt ? getSessionTopic(sessionKey) : lastTopicOf(conversation.sessionId),
    assistantPreview: lastAssistantTurnText(jsonl)?.substring(0, 200),
    createdAt: new Date().toISOString(),
  };
  // Above the banner is the conversation branched from, unless the chat had
  // moved on from it before the tap.
  await loadFork(ctx, sessionKey, fork, onIt ? {} : { above: LEFT_ABOVE });
  await ctx.answerCallbackQuery({ text: 'Branched.' });
}
