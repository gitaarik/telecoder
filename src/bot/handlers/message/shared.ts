/**
 * Helpers shared by every message-handling entry point.
 *
 * These sit below the domain modules rather than inside any one of them:
 * `handleMessage`, the ForceReply handlers and the turn runner all need
 * them, so putting them in a domain module would make the other two import
 * across domains for a two-line helper.
 */

import { Context } from 'grammy';
import * as path from 'path';
import { config } from '../../../config.js';
import { sessionManager } from '../../../claude/session-manager.js';
import { queueRequest } from '../../../claude/request-queue.js';
import { summarizeTopicWithHaiku } from '../../../claude/auto-topic-haiku.js';
import { readLastAiTitle } from '../../../claude/session-jsonl.js';
import { namesThread } from '../../../telegram/thread-titles.js';
import { userPreferences } from '../../../providers/user-preferences.js';
import { parseSessionKey } from '../../../utils/session-key.js';
import { resolveShareableFile } from '../../file-access.js';
import { getSessionTopic, setSessionTopic } from '../command.handler.js';
import { getMsSinceTopicSet } from '../command/topic-store.js';
import { requireSession } from '../session-guard.js';
import { turnErrorReply } from '../../../claude/claude-auth.js';

export { requireSession } from '../session-guard.js';

export async function replyFeatureDisabled(ctx: Context, feature: string): Promise<void> {
  await ctx.reply(`⚠️ ${feature} feature is disabled in configuration.`);
}

/**
 * Fire-and-forget topic update via a parallel Haiku call. Runs alongside
 * the main agent turn so the status line and the thread name reflect the new
 * topic almost immediately, without depending on the main agent calling
 * telecoder_set_topic.
 */
export function fireAutoTopic(ctx: Context, sessionKey: string, userMessage: string): void {
  if (!config.AUTO_TOPIC_HAIKU) return;
  // Fire if the topic will be visible somewhere — the status line or the
  // thread's name. Skipping when nothing displays it avoids wasted Haiku calls.
  const { chatId } = parseSessionKey(sessionKey);
  const wantsTopic = userPreferences.getShowTopicInStatusLine(chatId)
    || namesThread(sessionKey);
  if (!wantsTopic) return;
  void (async () => {
    try {
      const previousTopic = getSessionTopic(sessionKey);
      const startedAt = Date.now();
      const workingDirectory = sessionManager.getSession(sessionKey)?.workingDirectory;
      let topic = await summarizeTopicWithHaiku(
        userMessage,
        previousTopic,
        workingDirectory ? path.basename(workingDirectory) : undefined,
      );
      // The agent (or the user's /topic) set one while Haiku was thinking:
      // that topic is newer and deliberate, and Haiku's guess, made from the
      // topic before it, would otherwise land a few seconds later on top.
      const setSince = getMsSinceTopicSet(sessionKey);
      if (setSince !== undefined && setSince < Date.now() - startedAt) return;
      // If Haiku failed AND we have no prior topic at all, seed from Claude
      // Code's aiTitle so the status line shows *something* instead of staying
      // blank until the next turn succeeds. With a prior topic we keep it.
      if (!topic && !previousTopic) {
        const session = sessionManager.getSession(sessionKey);
        if (session?.claudeSessionId) {
          topic = readLastAiTitle(session.workingDirectory, session.claudeSessionId);
        }
      }
      if (!topic) return;
      // Topic lives in the status line and the thread name, not the Telegram
      // bot name, so no setMyName call.
      setSessionTopic(sessionKey, topic);
    } catch (err) {
      console.debug('[AutoTopic] Side-call update failed:', err instanceof Error ? err.message : err);
    }
  })();
}


/**
 * Resolve a user-typed file path against the active session, enforcing the
 * file-access rules (see bot/file-access.ts: the credential denylist for
 * everyone, the project directory for guests, the workspace for admins) and
 * that the target is an existing regular file.
 *
 * Every rejection is reported to the chat and returns null, so callers only
 * need to early-return. Shared by the /file and /telegraph reply handlers —
 * they used to carry identical copies of these three checks, which meant a
 * tightening of the containment rule could reach one and miss the other.
 */
export async function resolveUserFilePath(
  ctx: Context,
  sessionKey: string,
  filePath: string,
): Promise<string | null> {
  const session = await requireSession(ctx, sessionKey);
  if (!session) return null;

  return resolveShareableFile(ctx, session.workingDirectory, filePath);
}

/**
 * Queue a turn and turn any failure into a user-facing error.
 *
 * "Queue cleared" is the normal signal that a newer message superseded this
 * one, so it exits quietly. Anything else is logged as well as reported —
 * three of the four call sites this replaces only replied to the chat, which
 * left failures in the plan/explore, suggestion-tap and throttle-retry paths
 * invisible from the server side.
 */
export async function runQueuedTurn(
  ctx: Context,
  sessionKey: string,
  message: string,
  label: string,
  run: () => Promise<void>,
): Promise<void> {
  try {
    await queueRequest(sessionKey, message, run);
  } catch (error) {
    if ((error as Error).message === 'Queue cleared') return;
    console.error(`[${label}] Turn failed:`, error);
    // An auth failure gets a reply saying how to sign in rather than the
    // CLI's own "Please run /login", which nobody can do from a phone.
    await ctx.reply(turnErrorReply(error));
  }
}
