/**
 * In-memory store for prompt suggestions awaiting a button tap.
 *
 * When Claude Code surfaces a speculative next-prompt at end-of-turn, the
 * UI layer offers it with a callback like `sgt:<id>` — on a button under the
 * response when it is short, on a card of its own when it is not. Either way
 * the suggestion text itself may exceed Telegram's 64-byte callback_data, so
 * we keep the text here and map it to a short id.
 *
 * Entries expire after TTL_MS so stale buttons from yesterday's conversation
 * can't accidentally resurrect old prompts long after the context has moved
 * on. The store is single-use: a successful consume removes the entry.
 */

import { randomBytes } from 'crypto';

/**
 * How the suggestion was offered — which decides what a tap should do to the
 * message the button sits on.
 *   - `button` — the text is on the button, under the assistant's reply; the
 *     tap echoes it so the chat records what was sent.
 *   - `card`   — the text is in its own message above the button; the tap
 *     rewrites that message instead, since echoing would just repeat it.
 */
export type SuggestionPresentation = 'button' | 'card';

interface SuggestionEntry {
  text: string;
  sessionKey: string;
  presentation: SuggestionPresentation;
  createdAt: number;
}

const store = new Map<string, SuggestionEntry>();
const TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 256;

function pruneExpired(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, entry] of store) {
    if (entry.createdAt < cutoff) store.delete(id);
  }
  // Hard cap as a safety net — high-traffic chats could otherwise grow the
  // map without bound between TTL sweeps. Drop the oldest first.
  if (store.size > MAX_ENTRIES) {
    const sorted = [...store.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
    const drop = sorted.slice(0, store.size - MAX_ENTRIES);
    for (const [id] of drop) store.delete(id);
  }
}

export function storeSuggestion(
  sessionKey: string,
  text: string,
  presentation: SuggestionPresentation = 'button',
): string {
  pruneExpired();
  const id = randomBytes(6).toString('base64url');
  store.set(id, { text, sessionKey, presentation, createdAt: Date.now() });
  return id;
}

export function consumeSuggestion(
  id: string,
): { text: string; sessionKey: string; presentation: SuggestionPresentation } | null {
  const entry = store.get(id);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > TTL_MS) {
    store.delete(id);
    return null;
  }
  store.delete(id);
  return { text: entry.text, sessionKey: entry.sessionKey, presentation: entry.presentation };
}
