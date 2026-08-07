/**
 * Session topic and Telegram bot display name — the state and the mutators.
 *
 * The topic is ephemeral per-session state (persisted only through
 * sessionHistory) that several other command domains read and reset — project
 * switches, /clear, and resume all touch it.
 *
 * This module is deliberately kept below the provider layer: `agent.ts` and
 * `mcp-tools.ts` both need to read and set the topic, and importing it from
 * the command barrel closed an import cycle (barrel -> command/shared.ts ->
 * claude-provider -> sdk-provider -> agent -> back to the barrel). Nothing
 * here may import `./shared.js` or anything under `providers/`. The /topic and
 * /botname *commands* live in `topic.ts`, which is free to.
 */

import { Context } from 'grammy';
import * as path from 'path';
import { config } from '../../../config.js';
import { sessionManager } from '../../../claude/session-manager.js';
import { sessionHistory } from '../../../claude/session-history.js';
import { readLastAiTitle } from '../../../claude/session-jsonl.js';
import {
  isBotNameEnabled,
  rateLimitedSetMyName,
  notifyBotNameBlock,
} from '../../../telegram/botname-settings.js';

// Per-session topic (ephemeral — not persisted across restarts)
const sessionTopics: Map<string, string> = new Map();
// Per-session timestamp of last setSessionTopic call. Used by the auto-topic
// reminder hook to skip the per-turn nudge when the topic was just updated.
const lastTopicSetAt: Map<string, number> = new Map();

/** Build the bot display name from base name and project. Topic now lives in the status line. */
export function buildBotDisplayName(sessionKey: string): string {
  const session = sessionManager.getSession(sessionKey);
  const project = session?.workingDirectory ? path.basename(session.workingDirectory) : '';
  const parts: string[] = [config.BOT_NAME];
  if (project) parts.push(project);
  return parts.join(' — ').slice(0, 64);
}

/**
 * Push a display name to Telegram (rate-limited) and surface any block notice.
 * Swallows errors — a failed name update should never break the calling flow.
 * `context` is used only for the debug log so failures are attributable.
 */
export async function pushBotName(ctx: Context, name: string, context: string): Promise<void> {
  try {
    const result = await rateLimitedSetMyName(ctx.api, (n) => ctx.api.setMyName(n), name);
    await notifyBotNameBlock(ctx, result);
  } catch (err) {
    console.debug(`[Bot] Failed to set bot name (${context}):`, err instanceof Error ? err.message : err);
  }
}

/**
 * Clear the session topic and refresh the bot display name accordingly.
 * Called whenever the conversation context is wiped (clear, reset, project switch).
 */
export async function clearTopicAndRefreshBotName(ctx: Context, sessionKey: string): Promise<void> {
  setSessionTopic(sessionKey, '');
  if (!isBotNameEnabled(sessionKey)) return;
  await pushBotName(ctx, buildBotDisplayName(sessionKey), 'topic clear');
}

/**
 * Restore the session topic from the saved value (or clear if absent) and refresh
 * the bot display name. Called when resuming/continuing a previous conversation.
 *
 * When no persisted topic exists, fall back to Claude Code's `aiTitle` from the
 * session JSONL — better a stale session label than a blank topic line on resume.
 */
export async function restoreTopicAndRefreshBotName(ctx: Context, sessionKey: string, topic: string | undefined): Promise<void> {
  if (!topic) {
    const session = sessionManager.getSession(sessionKey);
    if (session?.claudeSessionId) {
      topic = readLastAiTitle(session.workingDirectory, session.claudeSessionId);
    }
  }
  setSessionTopic(sessionKey, topic || '');
  if (!isBotNameEnabled(sessionKey)) return;
  await pushBotName(ctx, buildBotDisplayName(sessionKey), 'topic restore');
}

/**
 * Set the session topic programmatically (used by MCP tool and auto-resume).
 * Returns the new display name string.
 */
export function setSessionTopic(sessionKey: string, topic: string): string {
  if (topic) {
    sessionTopics.set(sessionKey, topic);
  } else {
    sessionTopics.delete(sessionKey);
  }
  lastTopicSetAt.set(sessionKey, Date.now());
  // Persist so topic survives restarts
  sessionHistory.updateTopic(sessionKey, topic || undefined);
  return buildBotDisplayName(sessionKey);
}

/** Get the current session topic. */
export function getSessionTopic(sessionKey: string): string | undefined {
  return sessionTopics.get(sessionKey);
}

/** Milliseconds since the last setSessionTopic call (or undefined if never). */
export function getMsSinceTopicSet(sessionKey: string): number | undefined {
  const at = lastTopicSetAt.get(sessionKey);
  return at !== undefined ? Date.now() - at : undefined;
}
