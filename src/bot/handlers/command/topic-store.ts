/**
 * Session topic — the state and the mutators.
 *
 * The topic is ephemeral per-session state (persisted only through
 * sessionHistory) that several other command domains read and reset — project
 * switches, /clear, and resume all touch it. It shows in the status line and
 * names the thread; the bot's display name is static (see `/botname`).
 *
 * This module is deliberately kept below the provider layer, so that code
 * under it can read and set the topic without closing an import cycle through
 * the command barrel. Nothing here may import `./shared.js` or anything under
 * `providers/`. The /topic *command* lives in `topic.ts`, which is free to.
 */

import * as path from 'path';
import { sessionManager } from '../../../claude/session-manager.js';
import { sessionHistory } from '../../../claude/session-history.js';
import { readLastAiTitle } from '../../../claude/session-jsonl.js';
import { syncThreadTitle } from '../../../telegram/thread-titles.js';
import { isHomeProject } from '../../../utils/home-project.js';

// Per-session topic (ephemeral — not persisted across restarts)
const sessionTopics: Map<string, string> = new Map();
// Per-session timestamp of last setSessionTopic call. Used by the auto-topic
// reminder hook to skip the per-turn nudge when the topic was just updated.
const lastTopicSetAt: Map<string, number> = new Map();

/**
 * Clear the session topic. Called whenever the conversation context is wiped
 * (clear, reset, project switch).
 */
export function clearTopic(sessionKey: string): void {
  setSessionTopic(sessionKey, '');
}

/**
 * Restore the session topic from the saved value (or clear if absent). Called
 * when resuming/continuing a previous conversation.
 *
 * When no persisted topic exists, fall back to Claude Code's `aiTitle` from the
 * session JSONL — better a stale session label than a blank topic line on resume.
 */
export function restoreTopic(sessionKey: string, topic: string | undefined): void {
  if (!topic) {
    const session = sessionManager.getSession(sessionKey);
    if (session?.claudeSessionId) {
      topic = readLastAiTitle(session.workingDirectory, session.claudeSessionId);
    }
  }
  setSessionTopic(sessionKey, topic || '');
}

/** Set the session topic programmatically (used by the MCP tool and auto-resume). */
export function setSessionTopic(sessionKey: string, topic: string): void {
  if (topic) {
    sessionTopics.set(sessionKey, topic);
  } else {
    sessionTopics.delete(sessionKey);
  }
  lastTopicSetAt.set(sessionKey, Date.now());
  // Persist so topic survives restarts
  sessionHistory.updateTopic(sessionKey, topic || undefined);
  // In a private chat's thread, the topic is the thread's name too, with the
  // project in front unless it's the one the bot is named after.
  const workingDirectory = sessionManager.getSession(sessionKey)?.workingDirectory;
  const project = workingDirectory && !isHomeProject(workingDirectory) ? path.basename(workingDirectory) : undefined;
  syncThreadTitle(sessionKey, topic, project);
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
