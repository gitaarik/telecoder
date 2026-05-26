/**
 * In-memory store for prompt suggestions awaiting a button tap.
 *
 * When Claude Code surfaces a speculative next-prompt at end-of-turn, the
 * UI layer attaches an inline button to the response with a callback like
 * `sgt:<id>`. The suggestion text itself is too long to fit in Telegram's
 * 64-byte callback_data, so we keep the text here and map it to a short id.
 *
 * Entries expire after TTL_MS so stale buttons from yesterday's conversation
 * can't accidentally resurrect old prompts long after the context has moved
 * on. The store is single-use: a successful consume removes the entry.
 */

import { randomBytes } from 'crypto';

interface SuggestionEntry {
  text: string;
  sessionKey: string;
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

export function storeSuggestion(sessionKey: string, text: string): string {
  pruneExpired();
  const id = randomBytes(6).toString('base64url');
  store.set(id, { text, sessionKey, createdAt: Date.now() });
  return id;
}

export function consumeSuggestion(id: string): { text: string; sessionKey: string } | null {
  const entry = store.get(id);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > TTL_MS) {
    store.delete(id);
    return null;
  }
  store.delete(id);
  return { text: entry.text, sessionKey: entry.sessionKey };
}
