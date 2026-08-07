/**
 * The two startup messages that aren't about restoring a session: warning a
 * chat that its task was cut off mid-run, and confirming a user-initiated
 * restart actually landed.
 *
 * Both consult the `notified` set the session-restore paths fill in, so a chat
 * that already heard from us this startup doesn't get piled on.
 */

import type { Bot } from 'grammy';
import { config } from '../config.js';
import { sessionManager } from '../claude/session-manager.js';
import { sessionHistory } from '../claude/session-history.js';
import { consumeAllInFlight } from '../claude/in-flight-tracker.js';
import { parseSessionKey } from '../utils/session-key.js';
import { allowedChatIds, threadOpts, sendBlockWithPlainFallback } from './shared.js';

/**
 * If a task was running when the bot exited (clean or crash), surface that
 * to the affected chat so the user knows their last prompt may not have
 * completed. Also ensures the session is restored in memory so the next
 * message arrives at a live session.
 */
export async function notifyInterruptedSessions(bot: Bot, notified: Set<string>): Promise<void> {
  const interrupted = consumeAllInFlight();
  if (interrupted.length === 0) return;

  const allowedIds = allowedChatIds();

  for (const entry of interrupted) {
    const { chatId, threadId } = parseSessionKey(entry.sessionKey);
    if (!allowedIds.has(chatId)) continue;

    // Make sure the session is live in memory so the user can immediately reply.
    if (!sessionManager.getSession(entry.sessionKey)) {
      sessionManager.resumeLastSession(entry.sessionKey);
    }

    const opts = threadOpts(threadId);
    const text =
      `⚠️ I was interrupted while running a task\\. The last action may not have completed\\.`;
    try {
      await bot.api.sendMessage(chatId, text, { parse_mode: 'MarkdownV2', ...opts });
      notified.add(entry.sessionKey);
    } catch (err) {
      console.error(`[InFlight] Failed to notify ${entry.sessionKey}:`, err);
    }

    // Deliver the interrupted prompt as its own chunked block so long prompts
    // survive intact rather than getting clipped into the header.
    if (entry.messagePreview) {
      try {
        await bot.api.sendMessage(chatId, '📝 Last prompt:', opts);
        await sendBlockWithPlainFallback(bot, chatId, opts, entry.messagePreview, 'InFlight');
      } catch (err) {
        console.error(`[InFlight] Failed to deliver prompt for ${entry.sessionKey}:`, err);
      }
    }
  }
}

/**
 * Confirm a user-initiated restart in Telegram.
 *
 * Only the session-driven paths speak on startup, and each has its own
 * cutoff — nothing fresh enough to resume, a session already prompted for the
 * same activity timestamp, or one older than the 7d prompt window all leave the
 * chat silent. After an explicit /rebuildbot or /restartbot that reads as "did
 * my restart even land?", especially for `all`, where five sibling instances
 * restart with no visible sign either way.
 *
 * Sends to the most recently active chat this instance serves, and only when
 * that chat heard nothing else this startup — so a chat that already got the
 * resume recap, the interrupted-task warning, or the continue/fresh prompt
 * doesn't get a redundant second message.
 *
 * Gated on the caller having seen a fresh reload marker, so crash-loop
 * respawns and plain pm2 restarts stay quiet.
 */
export async function notifyRestartComplete(bot: Bot, notified: Set<string>): Promise<void> {
  const allowedIds = allowedChatIds();

  // getAllActiveSessions is keyed in insertion order, not recency — pick the
  // genuinely most-recent chat, since that's the one the user most plausibly
  // ran the command from.
  let target: string | undefined;
  let newest = -Infinity;
  for (const [sessionKey, entry] of sessionHistory.getAllActiveSessions()) {
    const { chatId } = parseSessionKey(sessionKey);
    if (!allowedIds.has(chatId)) continue;
    const lastActivity = new Date(entry.lastActivity).getTime();
    if (!Number.isFinite(lastActivity) || lastActivity <= newest) continue;
    newest = lastActivity;
    target = sessionKey;
  }

  if (!target) {
    console.log('[Restart] No active chat to notify — skipping restart confirmation');
    return;
  }
  if (notified.has(target)) {
    console.log(`[Restart] ${target} already heard from us this startup — skipping restart confirmation`);
    return;
  }

  const { chatId, threadId } = parseSessionKey(target);
  const opts = threadOpts(threadId);
  try {
    // Plain text, no parse_mode: BOT_NAME is user-supplied and would otherwise
    // need escaping to survive the MarkdownV2 parser.
    await bot.api.sendMessage(chatId, `✅ ${config.BOT_NAME} restarted and is ready.`, opts);
    console.log(`[Restart] Confirmed restart to ${target}`);
  } catch (err) {
    console.error(`[Restart] Failed to confirm restart to ${target}:`, err);
  }
}
