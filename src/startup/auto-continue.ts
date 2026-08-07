/**
 * Cold-start auto-continue.
 *
 * Unlike auto-resume this runs on every startup, marker or not — auto-resume
 * only restores sessions idle under an hour, so after a /rebuildbot with
 * nothing fresh enough this is the only path that says anything at all.
 */

import type { Bot } from 'grammy';
import * as path from 'path';
import { sessionManager } from '../claude/session-manager.js';
import { sessionHistory } from '../claude/session-history.js';
import { parseSessionKey } from '../utils/session-key.js';
import { escapeMarkdownV2 } from '../telegram/markdown.js';
import { allowedChatIds, threadOpts } from './shared.js';

// Sessions idle less than this are silently restored in memory on startup.
// Matches the default `sessionManager.getOrRestoreSession` cutoff so the eager
// restore here has the same "is this the same conversation" semantics as the
// lazy restore on next message.
const STARTUP_SILENT_RESTORE_MS = 60 * 60 * 1000; // 1h
// Sessions idle between the silent cutoff and this get a Telegram prompt asking
// whether to continue or start fresh. Anything older is left untouched — the
// user can still /continue explicitly if they want it.
const STARTUP_PROMPT_CUTOFF_MS = 7 * 24 * 60 * 60 * 1000; // 7d

// Telegram returns this when editMessageText is called with text identical to
// what's already shown (e.g. a restart inside the same "Xh ago" bucket). It's a
// harmless no-op, distinct from a genuine edit failure like a deleted message.
function isMessageNotModified(err: unknown): boolean {
  const desc = (err as { description?: string; message?: string })?.description
    ?? (err as { message?: string })?.message
    ?? '';
  return typeof desc === 'string' && desc.includes('message is not modified');
}

function formatRelativeIdle(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

/**
 * Cold-start auto-continue. For every chat with a prior session belonging to
 * this instance:
 *   - idle < 1h          → silently restore in memory (no chat noise)
 *   - 1h ≤ idle ≤ 7d     → post a Telegram prompt with Continue / Start fresh
 *   - idle > 7d          → skip (user can /continue manually)
 *
 * Sessions already live in memory are skipped — that covers both the ones
 * autoResumeAfterReload just restored (they got the fuller "Reloaded and
 * session restored" recap) and the ones notifyInterruptedSessions revived, so
 * neither path can end up double-messaging a chat.
 */
export async function autoContinueOnStartup(bot: Bot, notified: Set<string>): Promise<void> {
  const activeSessions = sessionHistory.getAllActiveSessions();
  const allowedIds = allowedChatIds();

  let silent = 0;
  let prompted = 0;
  let refreshed = 0;
  const skipped: Record<string, number> = { notAllowed: 0, alreadyLive: 0, noClaudeSessionId: 0, tooOld: 0, alreadyPrompted: 0, threw: 0 };

  for (const [sessionKey, entry] of activeSessions) {
    const { chatId, threadId } = parseSessionKey(sessionKey);

    if (!allowedIds.has(chatId)) {
      skipped.notAllowed++;
      continue;
    }
    if (sessionManager.getSession(sessionKey)) {
      skipped.alreadyLive++;
      continue;
    }
    if (!entry.claudeSessionId) {
      skipped.noClaudeSessionId++;
      continue;
    }

    const idleMs = Date.now() - new Date(entry.lastActivity).getTime();
    if (idleMs < 0) {
      skipped.tooOld++;
      continue;
    }

    if (idleMs < STARTUP_SILENT_RESTORE_MS) {
      try {
        sessionManager.resumeLastSession(sessionKey);
        silent++;
      } catch (err) {
        console.error(`[AutoContinue] Silent restore failed for ${sessionKey}:`, err);
        skipped.threw++;
      }
      continue;
    }

    if (idleMs > STARTUP_PROMPT_CUTOFF_MS) {
      skipped.tooOld++;
      continue;
    }

    const projectName = entry.projectName || path.basename(entry.projectPath || '');
    const relative = formatRelativeIdle(idleMs);
    const opts = threadOpts(threadId);
    const text =
      `🔄 Previous session for *${escapeMarkdownV2(projectName)}* — last active ${escapeMarkdownV2(relative)}\\.\n` +
      `Continue where you left off, or start fresh?`;
    const replyMarkup = {
      inline_keyboard: [[
        { text: '▶️ Continue', callback_data: 'startup:continue' },
        { text: '🆕 Start fresh', callback_data: 'startup:fresh' },
      ]],
    };

    // Already handled the prompt for this exact activity timestamp? A previous
    // restart asked and we haven't seen a new turn since — don't stack a second
    // prompt. The earlier message's buttons stay live across restarts.
    if (entry.startupPromptedAt === entry.lastActivity) {
      if (!entry.startupPromptMessageId) {
        // User already answered — stay quiet.
        skipped.alreadyPrompted++;
        continue;
      }
      // Prompt still standing: refresh its now-stale "last active Xh ago" text
      // in place rather than posting a fresh one. Buttons are preserved.
      try {
        await bot.api.editMessageText(chatId, entry.startupPromptMessageId, text, {
          parse_mode: 'MarkdownV2',
          reply_markup: replyMarkup,
        });
        refreshed++;
      } catch (err) {
        if (isMessageNotModified(err)) {
          // Same hour bucket as last restart — text unchanged, nothing to do.
          refreshed++;
        } else {
          // Original prompt was deleted or is too old to edit — post a new one.
          try {
            const sent = await bot.api.sendMessage(chatId, text, {
              parse_mode: 'MarkdownV2',
              ...opts,
              reply_markup: replyMarkup,
            });
            sessionHistory.markStartupPrompted(sessionKey, sent.message_id);
            prompted++;
            notified.add(sessionKey);
          } catch (err2) {
            console.error(`[AutoContinue] Failed to re-prompt ${sessionKey}:`, err2);
            skipped.threw++;
          }
        }
      }
      continue;
    }

    try {
      const sent = await bot.api.sendMessage(chatId, text, {
        parse_mode: 'MarkdownV2',
        ...opts,
        reply_markup: replyMarkup,
      });
      sessionHistory.markStartupPrompted(sessionKey, sent.message_id);
      prompted++;
      notified.add(sessionKey);
    } catch (err) {
      console.error(`[AutoContinue] Failed to prompt ${sessionKey}:`, err);
      skipped.threw++;
    }
  }

  const skipSummary = Object.entries(skipped)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}=${n}`)
    .join(', ');
  console.log(
    `[AutoContinue] silent=${silent}, prompted=${prompted}, refreshed=${refreshed}, total=${activeSessions.size}` +
    (skipSummary ? `, skipped(${skipSummary})` : '')
  );
}
