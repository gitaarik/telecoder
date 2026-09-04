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
 * In-memory only — if the bot restarts mid-question, the pending entries
 * are lost and the tool will time out (10 min default), at which point the
 * agent receives a "user did not respond" result and can move on.
 */

import * as crypto from 'crypto';

export interface AskUserAnswer {
  /** The label of the option the user selected. */
  label: string;
  /** Zero-based index into the options array. */
  index: number;
}

export interface AskUserOption {
  label: string;
  description?: string;
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
 * How wide a button's text may render before Telegram clips it. An inline
 * button is a single line the client ellipsises with no way to expand it, so
 * text past roughly this many characters is simply lost to the reader. That is
 * why every option is also written into the message body, keyed by letter, and
 * why a keyboard whose labels don't fit drops to bare letters instead of
 * showing a column of half-sentences.
 */
const MAX_BUTTON_TEXT_LEN = 30;

/** Separator between an option's letter and its label on a button. */
const BUTTON_SEP = ' · ';

/** Bare-letter buttons per row, once a keyboard has gone compact. */
const LETTERS_PER_ROW = 4;

/**
 * The key an option is known by: `A`, `B`, `C`, … It prefixes the option both
 * in the message body and on its button, so a letter-only button still points
 * at the full text above it. Past `Z` it falls back to the 1-based index;
 * callers cap at 8 options, so that is defensive only.
 */
export function optionLetter(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
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
 *   A. Label — description  ← every option, keyed by {@link optionLetter}
 *
 * The `context` block is the fix for the "user is asked to choose before the
 * explanation is shown" bug: prose the model emits *before* calling ask_user
 * isn't delivered until end-of-turn (after the tap), so decision-relevant
 * information must ride inside the question message itself.
 */
export function buildAskUserMessageText(
  question: string,
  options: AskUserOption[],
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
  options.forEach((o, idx) => {
    const desc = o.description?.trim();
    lines.push(`${optionLetter(idx)}. ${o.label}${desc ? ` — ${desc}` : ''}`);
  });

  return lines.join('\n');
}

/**
 * The inline keyboard for a question, shared by SDK mode (mcp-tools.ts) and
 * PTY/IPC mode (mcp-bridge.ts) so both render identically.
 *
 * A label rides on its own button while it fits — `A · Patch the regex` reads
 * fine and saves a glance at the body. The moment one option is too wide,
 * every button in that keyboard falls back to its bare letter and they pack
 * four to a row: a keyboard that is half labels and half mystery letters is
 * harder to read than one that is uniformly keyed, and the body above it
 * already spells out what each letter stands for.
 */
export function buildAskUserKeyboard(
  id: string,
  options: AskUserOption[],
): { text: string; callback_data: string }[][] {
  const labelled = options.map((o, idx) => `${optionLetter(idx)}${BUTTON_SEP}${o.label}`);

  if (labelled.every((text) => text.length <= MAX_BUTTON_TEXT_LEN)) {
    return labelled.map((text, idx) => [{ text, callback_data: `q:${id}:${idx}` }]);
  }

  const rows: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < options.length; i += LETTERS_PER_ROW) {
    rows.push(
      options.slice(i, i + LETTERS_PER_ROW).map((_, j) => ({
        text: optionLetter(i + j),
        callback_data: `q:${id}:${i + j}`,
      })),
    );
  }
  return rows;
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
  if (!original) return null;
  const footer = `\n\n✅ Answered: ${label}`;
  if (original.length + footer.length > MAX_MESSAGE_LEN) return null;
  return original + footer;
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

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

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
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
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
