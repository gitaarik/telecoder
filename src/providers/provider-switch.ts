/**
 * Provider-switch orchestration.
 *
 * A Claude session is bound to the chat, not the backend — each turn resumes
 * the same Claude Code session id, and the "provider" (claude / ccr / opencode)
 * is just a per-turn executable choice. That means a session whose thinking
 * blocks were minted by DeepSeek-via-CCR (placeholder signatures) cannot be
 * replayed against the real Anthropic API without a `400 Invalid signature in
 * thinking block`.
 *
 * So switching provider mid-conversation starts a *fresh* session on the new
 * backend, optionally seeded with a plain-text summary of the prior
 * conversation (thinking/tool blocks stripped, so it's backend-agnostic). This
 * gives continuity of context without continuity of session.
 */

import { sessionManager } from '../claude/session-manager.js';
import { readRecentExchanges } from '../claude/session-jsonl.js';
import { setPendingCarryOver } from '../claude/agent.js';
import {
  setActiveProvider,
  getActiveProviderName,
  clearConversation,
} from './provider-router.js';
import type { ProviderName } from './types.js';

// How many recent exchanges to carry over, and how much of each turn to keep.
const CARRY_OVER_EXCHANGES = 6;
const CARRY_OVER_TURN_CHARS = 800;

/** Provider that owns the session currently active for `sessionKey`, if any. */
export function getSessionOwnerProvider(sessionKey: string): ProviderName | undefined {
  const session = sessionManager.getSession(sessionKey);
  return session?.ownerProvider as ProviderName | undefined;
}

/**
 * True if switching `sessionKey` to `target` would abandon a live session that
 * a *different* backend owns — i.e. the switch is destructive and worth a
 * confirmation prompt. A session with no established Claude session id (nothing
 * sent yet) or one already owned by `target` switches transparently.
 */
export function switchRequiresConfirm(sessionKey: string, target: ProviderName): boolean {
  const session = sessionManager.getSession(sessionKey);
  if (!session?.claudeSessionId) return false; // nothing to lose
  const owner = session.ownerProvider;
  // Unknown owner (legacy/restart): treat as a different backend to be safe.
  return owner !== target;
}

function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

/**
 * Build a plain-text recap of the recent conversation for `sessionKey`, or
 * undefined if there's nothing to carry over. Reads the prior session's JSONL
 * (thinking/tool blocks already stripped by readRecentExchanges).
 */
export function buildCarryOverPreamble(sessionKey: string): string | undefined {
  const session = sessionManager.getSession(sessionKey);
  if (!session?.claudeSessionId) return undefined;

  const exchanges = readRecentExchanges(
    session.workingDirectory,
    session.claudeSessionId,
    CARRY_OVER_EXCHANGES,
  );
  if (exchanges.length === 0) return undefined;

  const transcript = exchanges
    .map(
      (ex) =>
        `User: ${truncate(ex.user, CARRY_OVER_TURN_CHARS)}\n` +
        `Assistant: ${truncate(ex.assistant, CARRY_OVER_TURN_CHARS)}`,
    )
    .join('\n\n');

  return (
    '[The previous conversation ran on a different model backend and could not ' +
    'be resumed directly, so it was summarized below for continuity. Treat it ' +
    'as prior context and continue from where it left off.]\n\n' +
    '--- Previous conversation ---\n' +
    transcript +
    '\n--- End of previous conversation ---'
  );
}

/**
 * Switch `sessionKey`/`chatId` to `target`, starting a fresh session. When
 * `carryOver` is true (default) the prior conversation is summarized and queued
 * as a preamble for the next turn. Safe to call even when no session is active.
 */
export async function switchProvider(
  sessionKey: string,
  chatId: number,
  target: ProviderName,
  carryOver: boolean = true,
): Promise<void> {
  if (carryOver) {
    const preamble = buildCarryOverPreamble(sessionKey);
    if (preamble) setPendingCarryOver(sessionKey, preamble);
  }

  // Sever the old session BEFORE flipping the provider: drop in-memory
  // session ids/history, then mint a new conversation with no claudeSessionId
  // so the next turn starts clean on the new backend.
  clearConversation(sessionKey);
  sessionManager.startNewConversation(sessionKey);

  await setActiveProvider(chatId, target);
}

/** Resolve the provider that would be active after a no-op (current). */
export function currentProvider(chatId: number): ProviderName {
  return getActiveProviderName(chatId);
}
