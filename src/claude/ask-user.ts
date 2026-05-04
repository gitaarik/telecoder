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

interface PendingEntry {
  resolve: (answer: AskUserAnswer | null) => void;
  timer: NodeJS.Timeout;
  optionLabels: string[];
}

const pending: Map<string, PendingEntry> = new Map();

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Register a new pending question. Returns a short id (hex) and a promise
 * that resolves with the user's selected option, or `null` on timeout.
 */
export function createPendingQuestion(
  optionLabels: string[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): { id: string; promise: Promise<AskUserAnswer | null> } {
  const id = crypto.randomBytes(4).toString('hex');
  let resolveFn!: (answer: AskUserAnswer | null) => void;
  const promise = new Promise<AskUserAnswer | null>((resolve) => {
    resolveFn = resolve;
  });

  const timer = setTimeout(() => {
    if (pending.delete(id)) {
      resolveFn(null);
    }
  }, timeoutMs);

  pending.set(id, { resolve: resolveFn, timer, optionLabels });
  return { id, promise };
}

/**
 * Resolve a pending question with the user's selection. Called by the
 * Telegram callback-query dispatcher on button tap.
 */
export function resolvePendingQuestion(id: string, optionIndex: number): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  pending.delete(id);
  clearTimeout(entry.timer);
  const label = entry.optionLabels[optionIndex];
  if (label === undefined) {
    entry.resolve(null);
    return true;
  }
  entry.resolve({ label, index: optionIndex });
  return true;
}
