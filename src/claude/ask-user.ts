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
 * Build the plain-text body for an ask_user Telegram message, shared by SDK
 * mode (mcp-tools.ts) and PTY/IPC mode (mcp-bridge.ts) so both render
 * identically.
 *
 * Layout:
 *   ❓ <question>
 *
 *   <context>              ← only when provided; the model's decision rationale
 *
 *   • Label — description  ← only options that carry a per-option description
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

  const annotated = options.filter((o) => o.description);
  if (annotated.length > 0) {
    lines.push('');
    for (const o of options) {
      if (o.description) lines.push(`• ${o.label} — ${o.description}`);
    }
  }

  return lines.join('\n');
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
}

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

  pending.set(id, { resolve: resolveFn, timer, optionLabels, sessionKey });
  if (sessionKey) {
    pendingBySession.set(sessionKey, (pendingBySession.get(sessionKey) ?? 0) + 1);
  }
  return { id, promise };
}

/**
 * Resolve a pending question with the user's selection. Called by the
 * Telegram callback-query dispatcher on button tap.
 */
export function resolvePendingQuestion(id: string, optionIndex: number): boolean {
  const entry = clearPending(id);
  if (!entry) return false;
  const label = entry.optionLabels[optionIndex];
  if (label === undefined) {
    entry.resolve(null);
    return true;
  }
  entry.resolve({ label, index: optionIndex });
  return true;
}

/**
 * True when there's an outstanding ask-user question for this sessionKey.
 * The agent watchdog uses this to pause its timeouts so legitimate waits
 * for a button tap don't get force-closed as a "stale tool".
 */
export function hasPendingQuestionForSession(sessionKey: string): boolean {
  return (pendingBySession.get(sessionKey) ?? 0) > 0;
}
