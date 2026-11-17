/**
 * Everything posted to the chat *after* a turn's main response: the catch-up
 * relay that recovers prose the extractors dropped, the compaction notice,
 * and the status line that comes last. The usage footer isn't a message of its
 * own: it goes out at the bottom of the status line, see `sendStatusLine`.
 *
 * The notice consults the chat's verbosity settings itself, and the status
 * line the chat's /statusline ones, so callers fire both unconditionally via
 * `closeTurn`.
 */

import { Context } from 'grammy';
import { sessionManager } from '../../../claude/session-manager.js';
import { readLastAssistantTurnText } from '../../../claude/session-jsonl.js';
import { getPtyProvider } from '../../../providers/claude-provider.js';
import { getCachedUsage } from '../../../providers/provider-router.js';
import type { AgentResponse } from '../../../providers/types.js';
import { messageSender } from '../../../telegram/message-sender.js';
import { EntityText } from '../../../telegram/entities.js';
import { replyFormatted } from '../../../telegram/send.js';
import { bringCardDown } from '../../../telegram/background-activity-card.js';
import { resolveVerbosityFlags } from '../../../utils/verbosity.js';
import { fmtTokens } from '../../../utils/format.js';
import { sendStatusLine, type StatusLineOptions } from '../command/settings.js';

/**
 * After a turn's main response has been sent to Telegram, compare what we
 * relayed against the canonical assistant text in Claude Code's session JSONL.
 * If the JSONL has more prose than we sent — typical for the lossy extractor
 * paths (pure tool-call turns that returned empty, multi-block screen-scrape
 * dropping earlier blocks, early end-of-turn before JSONL flush) — post the
 * missing content as a follow-up. Updates the per-session tracker either way.
 *
 * Best-effort: any failure logs and swallows so a catch-up bug can never
 * break the primary relay path. Skips silently when the session has no
 * claudeSessionId yet, since there is no log to compare against.
 */
export async function relayCatchUpIfMissed(
  ctx: Context,
  sessionKey: string,
  relayedText: string,
): Promise<void> {
  try {
    const session = sessionManager.getSession(sessionKey);
    if (!session?.claudeSessionId) {
      sessionManager.setLastRelayedAssistantText(sessionKey, relayedText);
      return;
    }

    const jsonlText = readLastAssistantTurnText(session.workingDirectory, session.claudeSessionId) ?? '';
    if (!jsonlText) {
      sessionManager.setLastRelayedAssistantText(sessionKey, relayedText);
      return;
    }

    // 20-char slack absorbs trailing-whitespace / trim differences between
    // the screen-scrape and JSONL forms. Below that, treat as in sync.
    if (jsonlText.length <= relayedText.length + 20) {
      sessionManager.setLastRelayedAssistantText(sessionKey, jsonlText);
      return;
    }

    // If what we sent is a prefix of the canonical text (PTY happy path that
    // truncated mid-stream), post only the suffix. Otherwise post the full
    // canonical version — the texts come from different extractors and any
    // mid-string diff would risk dropping the actually-missing content.
    const missing = jsonlText.startsWith(relayedText) && relayedText.length > 0
      ? jsonlText.slice(relayedText.length).trim()
      : jsonlText;
    if (!missing) {
      sessionManager.setLastRelayedAssistantText(sessionKey, jsonlText);
      return;
    }

    await replyFormatted(ctx, new EntityText().add('📨 ').bold('Catch-up').add(' — recovered from session log').build());
    await messageSender.sendMessage(ctx, missing);
    sessionManager.setLastRelayedAssistantText(sessionKey, jsonlText);
  } catch (err) {
    console.error('[CatchUp] post-relay check failed:', err instanceof Error ? err.message : err);
  }
}

async function sendCompactionNotification(
  ctx: Context,
  compaction: { trigger: 'manual' | 'auto'; preTokens: number } | undefined,
): Promise<void> {
  if (!compaction) return;
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  if (!resolveVerbosityFlags(chatId).notifyCompaction) return;
  const c = compaction;
  console.log(`[Compaction] Sending notification: trigger=${c.trigger}, preTokens=${c.preTokens}`);
  const emoji = c.trigger === 'auto' ? '⚠️' : 'ℹ️';
  const triggerLabel = c.trigger === 'auto' ? 'Auto-compacted' : 'Manually compacted';
  try {
    // replyFormatted already retries unformatted if Telegram refuses the entities.
    await replyFormatted(ctx, new EntityText()
      .add(`${emoji} `).bold('Context Compacted').newline(2)
      .add(`${triggerLabel} — previous context was ${fmtTokens(c.preTokens)} tokens.\n`)
      .add('The agent now has a summarized version of your conversation.')
      .build());
  } catch (err) {
    console.error('[Compaction] Failed to send notification:', err);
  }
}

/**
 * What closes a turn, however it started: the compaction notice, then the
 * status line. A typed message, a voice note, an upload and a scheduled fire
 * all end here. Each used to write its own ending, and only the typed
 * message's had the status line, so a turn started any other way left the
 * chat on the tail of its reply with nothing to say where things stood.
 *
 * `prompt` is what the turn was sent, for a session whose log has no prompts
 * for the status line to list.
 */
export async function closeTurn(
  ctx: Context,
  sessionKey: string,
  response: Pick<AgentResponse, 'usage' | 'compaction'>,
  prompt: string,
  options?: StatusLineOptions,
): Promise<void> {
  await sendCompactionNotification(ctx, response.compaction);
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  // Not every response carries a usage: a cancelled turn's doesn't. The line
  // then shows what the session last had, rather than no model and no context.
  const usage = response.usage ?? getCachedUsage(sessionKey);
  await sendStatusLine(ctx, chatId, sessionKey, usage, prompt, options);
  // The reply buried the card; tasks still running get it back below.
  bringCardDown(sessionKey);
}

/**
 * The close of a turn claude started itself, when a background task reported
 * back. Its reply is often the answer the exchange was for, it tends to land
 * while the user is elsewhere, and no prompt of theirs sits above it, so it
 * closes with the status line like any other.
 *
 * Nothing ran that turn for us: there's no response to take the usage from,
 * and the cached figure is the one the turn before it left. The session log
 * has what this one left. The prompts come from the log as well, which lists
 * what the user sent and not what a task reported.
 */
export async function closeSelfStartedTurn(ctx: Context, sessionKey: string): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  await sendStatusLine(ctx, chatId, sessionKey, getPtyProvider().refreshUsage(sessionKey));
  bringCardDown(sessionKey);
}
