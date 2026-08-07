/**
 * Helpers shared by every message-handling entry point.
 *
 * These sit below the domain modules rather than inside any one of them:
 * `handleMessage`, the ForceReply handlers and the turn runner all need
 * them, so putting them in a domain module would make the other two import
 * across domains for a two-line helper.
 */

import { Context } from 'grammy';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../../../config.js';
import { sessionManager } from '../../../claude/session-manager.js';
import { queueRequest } from '../../../claude/request-queue.js';
import { summarizeTopicWithHaiku } from '../../../claude/auto-topic-haiku.js';
import { readLastAiTitle } from '../../../claude/session-jsonl.js';
import { escapeMarkdownV2 as esc } from '../../../telegram/markdown.js';
import { isBotNameEnabled } from '../../../telegram/botname-settings.js';
import { userPreferences } from '../../../providers/user-preferences.js';
import { parseSessionKey } from '../../../utils/session-key.js';
import { getWorkspaceRoot, isPathWithinRoot } from '../../../utils/workspace-guard.js';
import { getSessionTopic, setSessionTopic } from '../command.handler.js';
import { requireSession } from '../session-guard.js';

export { requireSession } from '../session-guard.js';

export async function replyFeatureDisabled(ctx: Context, feature: string): Promise<void> {
  await ctx.reply(`⚠️ ${feature} feature is disabled in configuration.`, { parse_mode: undefined });
}

/**
 * Fire-and-forget topic update via a parallel Haiku call. Runs alongside
 * the main agent turn so the bot name reflects the new topic almost
 * immediately, without depending on the main agent calling claudegram_set_topic.
 */
export function fireAutoTopic(ctx: Context, sessionKey: string, userMessage: string): void {
  if (!config.AUTO_TOPIC_HAIKU) return;
  // Fire if the topic will be visible somewhere — either the bot name or the
  // status line. Skipping when nothing displays it avoids wasted Haiku calls.
  const { chatId } = parseSessionKey(sessionKey);
  const wantsTopic = isBotNameEnabled(sessionKey) || userPreferences.getShowTopicInStatusLine(chatId);
  if (!wantsTopic) return;
  void (async () => {
    try {
      const previousTopic = getSessionTopic(sessionKey);
      let topic = await summarizeTopicWithHaiku(userMessage, previousTopic);
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
      // Topic lives in the status line, not the Telegram bot name. Updating
      // the topic doesn't change buildBotDisplayName, so no setMyName call —
      // we don't want to burn Telegram's bot-name rate limit on a no-op.
      setSessionTopic(sessionKey, topic);
    } catch (err) {
      console.debug('[AutoTopic] Side-call update failed:', err instanceof Error ? err.message : err);
    }
  })();
}


/**
 * Resolve a user-typed file path against the active session, enforcing the
 * workspace boundary and that the target is an existing regular file.
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
  const trimmedPath = filePath.trim();

  const session = await requireSession(ctx, sessionKey);
  if (!session) return null;

  const fullPath = trimmedPath.startsWith('/')
    ? trimmedPath
    : path.join(session.workingDirectory, trimmedPath);
  const workspaceRoot = getWorkspaceRoot();

  if (!isPathWithinRoot(workspaceRoot, fullPath)) {
    await ctx.reply(
      `❌ File path must be within workspace root: \`${esc(workspaceRoot)}\``,
      { parse_mode: 'MarkdownV2' }
    );
    return null;
  }

  if (!fs.existsSync(fullPath)) {
    await ctx.reply(
      `❌ File not found: \`${esc(trimmedPath)}\``,
      { parse_mode: 'MarkdownV2' }
    );
    return null;
  }

  if (fs.statSync(fullPath).isDirectory()) {
    await ctx.reply(
      `❌ That's a directory, not a file: \`${esc(trimmedPath)}\``,
      { parse_mode: 'MarkdownV2' }
    );
    return null;
  }

  return fullPath;
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
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[${label}] Turn failed:`, error);
    await ctx.reply(`❌ Error: ${esc(errorMessage)}`, { parse_mode: 'MarkdownV2' });
  }
}
