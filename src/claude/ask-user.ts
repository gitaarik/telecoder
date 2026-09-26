/**
 * Pending-question registry for claudegram_ask_user MCP tool.
 *
 * When Claude calls claudegram_ask_user, the MCP tool body:
 *   1. Calls createPendingQuestion() → gets { id, promise }
 *   2. Sends a Telegram message with an inline keyboard whose buttons have
 *      callback_data = `q:<id>:<optionIndex>`
 *   3. Awaits the promise
 *
 * When the user taps a button, the bot's callback dispatcher routes to
 * resolvePendingQuestion(id, ...), which fulfils the awaited promise so the
 * agent loop continues with the user's choice.
 *
 * A question nobody answers times out after QUESTION_TIMEOUT_MINUTES (10 by
 * default): the agent receives a "user did not respond" result and moves on,
 * and the caller closes the message (closeExpiredQuestion) so its keyboard
 * doesn't outlive the wait.
 *
 * In-memory only — a restart forgets every open question without touching its
 * message. The first tap on one of those gets the expired answer, and the tap
 * handler takes the dead keyboard down then.
 */

import * as crypto from 'crypto';
import type { Api } from 'grammy';
import type { MessageEntity } from 'grammy/types';
import { config } from '../config.js';
import {
  type LetteredOption,
  buildLetteredKeyboard,
  letteredOptionLines,
} from '../telegram/lettered-options.js';

export interface AskUserAnswer {
  /** The label of the option the user selected. */
  label: string;
  /** Zero-based index into the options array. */
  index: number;
}

/**
 * Max characters of `context` we render into the question message. Keeps the
 * whole message comfortably under Telegram's 4096-char limit even alongside a
 * long question and eight annotated options; overflow is clipped with an
 * ellipsis rather than letting sendMessage 400 on us.
 */
const MAX_CONTEXT_LEN = 3500;

/** Telegram's hard cap on a text message / message edit. */
const MAX_MESSAGE_LEN = 4096;

/**
 * How long a question waits for a tap: QUESTION_TIMEOUT_MINUTES, 10 by
 * default. One clock for everything a turn stops to ask — claudegram_ask_user,
 * claudegram_poll_user, a relayed Claude Code dialog. Permission prompts and
 * held messages keep their own, PERMISSION_PROMPT_TIMEOUT_MINUTES.
 */
export function questionTimeoutMinutes(): number {
  const minutes = config.QUESTION_TIMEOUT_MINUTES;
  return Number.isFinite(minutes) && minutes > 0 ? minutes : 10;
}

export function questionTimeoutMs(): number {
  return questionTimeoutMinutes() * 60 * 1000;
}

/**
 * Build the plain-text body for an ask_user Telegram message, shared by SDK
 * mode (mcp-tools.ts) and PTY/IPC mode (mcp-bridge.ts) so both render
 * identically.
 *
 * Layout:
 *   ❓ <question>
 *
 *   <context>              ← only when provided; the model's decision rationale
 *
 *   A. Label — description  ← every option, keyed by its letter
 *
 * The `context` block is the fix for the "user is asked to choose before the
 * explanation is shown" bug: prose the model emits *before* calling ask_user
 * isn't delivered until end-of-turn (after the tap), so decision-relevant
 * information must ride inside the question message itself.
 */
export function buildAskUserMessageText(
  question: string,
  options: LetteredOption[],
  context?: string,
): string {
  const lines: string[] = [`❓ ${question}`];

  const ctx = context?.trim();
  if (ctx) {
    const clipped = ctx.length > MAX_CONTEXT_LEN ? ctx.slice(0, MAX_CONTEXT_LEN - 1) + '…' : ctx;
    lines.push('');
    lines.push(clipped);
  }

  // Every option, always — not just the ones that came with a description.
  // A button is not a reliable place to read a label from: Telegram clips a
  // long one and offers no way to see the rest, so the body is where an
  // option's full text lives and the letter is how its button points back at
  // it.
  lines.push('');
  lines.push(...letteredOptionLines(options));

  return lines.join('\n');
}

/**
 * The inline keyboard for a question, shared by SDK mode (mcp-tools.ts) and
 * PTY/IPC mode (mcp-bridge.ts) so both render identically — and with every
 * other lettered picker, through {@link buildLetteredKeyboard}.
 */
export function buildAskUserKeyboard(
  id: string,
  options: LetteredOption[],
): { text: string; callback_data: string }[][] {
  return buildLetteredKeyboard(
    options.map((o, idx) => ({ label: o.label, callbackData: `q:${id}:${idx}` })),
  );
}

/**
 * Rewrite an answered question's text so it no longer reads as unanswered once
 * the keyboard is stripped. Returns `null` when the footer won't fit (or there
 * is no original text to append to) — the caller should then drop the keyboard
 * on its own and let the separate confirmation message carry the answer.
 *
 * The length check is not theoretical: `context` may be up to
 * {@link MAX_CONTEXT_LEN} chars, so a long question plus annotated options can
 * sit close enough to Telegram's 4096-char ceiling that appending a footer
 * tips the edit into a 400 — which would leave a live-looking keyboard on a
 * question that has already been resolved.
 */
export function appendAnsweredFooter(original: string, label: string): string | null {
  return appendFooter(original, `✅ Answered: ${label}`);
}

/**
 * The counterpart of {@link appendAnsweredFooter} for a question nobody
 * answered: `note` says what happened instead. Same length rule, same `null`.
 */
export function appendExpiredFooter(original: string, note: string): string | null {
  return appendFooter(original, `⏱️ ${note}`);
}

function appendFooter(original: string, footer: string): string | null {
  if (!original) return null;
  const appended = `${original}\n\n${footer}`;
  return appended.length > MAX_MESSAGE_LEN ? null : appended;
}

/**
 * The line an ask_user question ends on once it expires — shared by SDK mode
 * and PTY/IPC mode, like the rest of the message.
 */
export function buildAskUserExpiredNote(): string {
  return `No answer within ${questionTimeoutMinutes()} min, so Claude carried on without one.`;
}

/**
 * Close a question nobody answered in time: take its keyboard down and say
 * what happened where the answer would have gone.
 *
 * A tap is the only other thing that strips a keyboard, so without this a
 * question that simply ran out of time kept buttons that looked as live as
 * the moment they were posted — and tapping one got nothing but a toast. Each
 * caller runs it once its wait comes back empty, with the text it sent and
 * the entities too, when it sent some: an edit that leaves them out drops the
 * formatting. They stay valid because the footer only appends.
 *
 * Best-effort, like the answered path in bot.ts. A footer that won't fit or an
 * edit Telegram refuses still gets the keyboard taken down on its own.
 */
export async function closeExpiredQuestion(
  api: Pick<Api, 'editMessageText' | 'editMessageReplyMarkup'>,
  message: { chat: { id: number }; message_id: number },
  text: string,
  note: string,
  entities?: MessageEntity[],
): Promise<void> {
  const chatId = message.chat.id;
  const closed = appendExpiredFooter(text, note);
  if (closed !== null) {
    try {
      await api.editMessageText(chatId, message.message_id, closed, entities ? { entities } : undefined);
      return;
    } catch {
      // Losing the note is cosmetic; a live keyboard on a closed question is
      // not — fall through and take the keyboard down on its own.
    }
  }
  try {
    await api.editMessageReplyMarkup(chatId, message.message_id);
  } catch (err) {
    // Nothing left to try here. A tap on it still gets the expired answer,
    // and the tap handler strips the keyboard then.
    console.warn('[AskUser] could not close an expired question:', err instanceof Error ? err.message : err);
  }
}

/**
 * The confirmation sent as its own message once a question is answered.
 *
 * Editing the question in place is silent and anonymous: Telegram raises no
 * notification for an edit, and the footer says nothing about who tapped. In a
 * group that means the rest of the chat never sees a decision was made. A
 * standalone message replying to the question puts the answer in the
 * conversation flow the way a typed reply would be, and names the person.
 */
export function buildAnswerConfirmation(
  label: string,
  opts: { isPrivate: boolean; who?: string },
): string {
  const who = opts.isPrivate ? 'You' : opts.who?.trim() || 'Someone';
  return `✅ ${who} picked: ${label}`;
}

interface PendingEntry {
  resolve: (answer: AskUserAnswer | null) => void;
  timer: NodeJS.Timeout;
  optionLabels: string[];
  sessionKey?: string;
  /**
   * When set, only these Telegram user ids may answer. Left undefined the
   * question is open to anyone the auth middleware already let in, which is
   * what an ordinary `claudegram_ask_user` wants — the whole point of a poll
   * in a group is that any member can answer it.
   *
   * The permission gate sets it, because a question guarding a destructive
   * command is not answered by whoever asked for the command.
   */
  allowedResponderIds?: number[];
}

/**
 * Outcome of a button tap.
 *   - `resolved`  — the waiting agent got its answer
 *   - `expired`   — no such question: already answered, or timed out
 *   - `forbidden` — this question is restricted and the tapper is not on the list
 */
export type ResolveOutcome = 'resolved' | 'expired' | 'forbidden';

const pending: Map<string, PendingEntry> = new Map();
// Per-sessionKey pending counter — read by the agent watchdog so it can
// pause its stale-tool/silence timeouts while we're legitimately waiting on
// the user. Counter (not boolean) supports rare overlapping asks per session.
const pendingBySession: Map<string, number> = new Map();

function clearPending(id: string): PendingEntry | undefined {
  const entry = pending.get(id);
  if (!entry) return undefined;
  pending.delete(id);
  clearTimeout(entry.timer);
  if (entry.sessionKey) {
    const next = (pendingBySession.get(entry.sessionKey) ?? 1) - 1;
    if (next <= 0) pendingBySession.delete(entry.sessionKey);
    else pendingBySession.set(entry.sessionKey, next);
  }
  return entry;
}

/**
 * Register a new pending question. Returns a short id (hex) and a promise
 * that resolves with the user's selected option, or `null` on timeout.
 */
export function createPendingQuestion(
  optionLabels: string[],
  timeoutMs: number = questionTimeoutMs(),
  sessionKey?: string,
  allowedResponderIds?: number[],
): { id: string; promise: Promise<AskUserAnswer | null> } {
  const id = crypto.randomBytes(4).toString('hex');
  let resolveFn!: (answer: AskUserAnswer | null) => void;
  const promise = new Promise<AskUserAnswer | null>((resolve) => {
    resolveFn = resolve;
  });

  const timer = setTimeout(() => {
    const entry = clearPending(id);
    if (entry) entry.resolve(null);
  }, timeoutMs);

  pending.set(id, {
    resolve: resolveFn,
    timer,
    optionLabels,
    sessionKey,
    ...(allowedResponderIds && allowedResponderIds.length > 0 ? { allowedResponderIds } : {}),
  });
  if (sessionKey) {
    pendingBySession.set(sessionKey, (pendingBySession.get(sessionKey) ?? 0) + 1);
  }
  return { id, promise };
}

/**
 * Resolve a pending question with the user's selection. Called by the
 * Telegram callback-query dispatcher on button tap.
 *
 * The responder check lives in here rather than at the call site on purpose:
 * a restricted question must be impossible to resolve without passing the id
 * of whoever tapped, so a future caller cannot forget the check and quietly
 * reopen the question to everyone.
 */
export function resolvePendingQuestion(
  id: string,
  optionIndex: number,
  responderId?: number,
): ResolveOutcome {
  const entry = pending.get(id);
  if (!entry) return 'expired';

  const allowed = entry.allowedResponderIds;
  // Fails closed: no responder id on a restricted question is a refusal, not
  // a pass. Unrestricted questions ignore the id entirely.
  if (allowed && (responderId === undefined || !allowed.includes(responderId))) {
    return 'forbidden';
  }

  clearPending(id);
  const label = entry.optionLabels[optionIndex];
  if (label === undefined) {
    entry.resolve(null);
    return 'resolved';
  }
  entry.resolve({ label, index: optionIndex });
  return 'resolved';
}

/**
 * The full label of one option on a pending question — what the model wrote,
 * not what its button shows. The two part company as soon as a keyboard goes
 * compact and the button is a bare `A`, and it is the model's text that
 * belongs in the answered footer and the confirmation message. Read it before
 * resolving; resolving drops the entry.
 */
export function getQuestionOptionLabel(id: string, index: number): string | undefined {
  return pending.get(id)?.optionLabels[index];
}

/**
 * The ids allowed to answer this question, or undefined when it is open to
 * everyone. Lets the callback handler tell the tapper who they are waiting on
 * instead of a bare refusal.
 */
export function getQuestionResponders(id: string): number[] | undefined {
  return pending.get(id)?.allowedResponderIds;
}

/**
 * True when there's an outstanding ask-user question for this sessionKey.
 * The agent watchdog uses this to pause its timeouts so legitimate waits
 * for a button tap don't get force-closed as a "stale tool".
 */
export function hasPendingQuestionForSession(sessionKey: string): boolean {
  return (pendingBySession.get(sessionKey) ?? 0) > 0;
}
