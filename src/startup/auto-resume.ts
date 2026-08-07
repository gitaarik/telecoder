/**
 * Auto-resume after /rebuildbot or /restartbot.
 *
 * The restarting worker (or the launcher, for a restart-all) leaves a reload
 * marker on disk. Finding a *fresh* one here is what distinguishes a
 * user-initiated restart from a crash respawn or a plain pm2 restart, so only
 * this path posts the "Reloaded and session restored" recap.
 */

import type { Bot } from 'grammy';
import * as fs from 'fs';
import * as path from 'path';
import { getReloadMarkerPath } from '../config.js';
import { sessionManager } from '../claude/session-manager.js';
import { sessionHistory } from '../claude/session-history.js';
import { clearConversation } from '../providers/provider-router.js';
import { parseSessionKey } from '../utils/session-key.js';
import { setSessionTopic } from '../bot/handlers/command/topic-store.js';
import { getEffortLabel } from '../bot/handlers/command.handler.js';
import { isBotNameEnabled, rateLimitedSetMyName, notifyBotNameBlockToChat } from '../telegram/botname-settings.js';
import { splitMessage, escapeMarkdownV2 } from '../telegram/markdown.js';
import { allowedChatIds, threadOpts, sendBlockWithPlainFallback } from './shared.js';

const RELOAD_MARKER_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Restore sessions flagged by a fresh reload marker.
 *
 * Returns whether a fresh marker was found and consumed — the caller uses that
 * to decide whether the restart itself warrants a confirmation message.
 */
export async function autoResumeAfterReload(bot: Bot, notified: Set<string>): Promise<boolean> {
  const markerFile = getReloadMarkerPath();
  if (!fs.existsSync(markerFile)) {
    console.log(`[AutoResume] No reload marker at ${markerFile} — skipping auto-resume`);
    return false;
  }

  let marker: { timestamp: string };
  try {
    const raw = fs.readFileSync(markerFile, 'utf-8');
    marker = JSON.parse(raw);
  } catch (err) {
    console.warn(`[AutoResume] Marker file ${markerFile} is unreadable, deleting:`, err instanceof Error ? err.message : err);
    try { fs.unlinkSync(markerFile); } catch {}
    return false;
  }

  // Validate timestamp freshness
  const age = Date.now() - new Date(marker.timestamp).getTime();
  if (age > RELOAD_MARKER_MAX_AGE_MS || age < 0) {
    console.log(`[AutoResume] Stale marker (age=${age}ms, max=${RELOAD_MARKER_MAX_AGE_MS}ms), ignoring`);
    try { fs.unlinkSync(markerFile); } catch {}
    return false;
  }

  console.log(`[AutoResume] Found fresh marker (age=${Math.round(age / 1000)}s), evaluating sessions for restore`);

  // Delete marker immediately to prevent double-processing or crash loops
  try { fs.unlinkSync(markerFile); } catch {}

  // Resume all recent active sessions that belong to this instance
  const activeSessions = sessionHistory.getAllActiveSessions();
  const allowedIds = allowedChatIds();
  console.log(`[AutoResume] ${activeSessions.size} candidate session(s) in history; allowlist size=${allowedIds.size}`);

  let resumed = 0;
  const skipped: Record<string, number> = { notAllowed: 0, idle: 0, noClaudeSessionId: 0, resumeReturnedUndefined: 0, threw: 0 };

  for (const [sessionKey, newest] of activeSessions) {
    const { chatId, threadId } = parseSessionKey(sessionKey);

    // Only resume sessions belonging to this bot instance
    if (!allowedIds.has(chatId)) {
      console.log(`[AutoResume] skip ${sessionKey}: chatId ${chatId} not in this bot's allowlist`);
      skipped.notAllowed++;
      continue;
    }

    // Resume the most recent entry that actually carries a claudeSessionId. The
    // newest entry can be a stub from a conversation that never finished init
    // (a query interrupted by the rebuild itself, an aborted /clear) — falling
    // back past it restores the healthy session sitting one slot back instead
    // of going silent on the whole chat.
    const entry = sessionHistory.getLastResumableSession(sessionKey);
    if (!entry) {
      console.log(`[AutoResume] skip ${sessionKey}: no history entry has a claudeSessionId (newest conversationId=${newest.conversationId}, project=${newest.projectName}) — no completed session to resume`);
      skipped.noClaudeSessionId++;
      continue;
    }

    // Only resume sessions with recent activity (within last hour). Measured
    // against the resumable entry, not a fresher stub, so we don't revive a
    // long-stale conversation just because an aborted one touched the chat.
    const lastActivity = new Date(entry.lastActivity).getTime();
    const idleMs = Date.now() - lastActivity;
    if (idleMs > 60 * 60 * 1000) {
      console.log(`[AutoResume] skip ${sessionKey}: idle for ${Math.round(idleMs / 60000)}min (cutoff=60min, lastActivity=${entry.lastActivity})`);
      skipped.idle++;
      continue;
    }

    try {
      const session = sessionManager.resumeSession(sessionKey, entry.conversationId);
      if (!session) {
        console.warn(`[AutoResume] skip ${sessionKey}: sessionManager.resumeSession returned undefined (history entry exists with claudeSessionId=${entry.claudeSessionId})`);
        skipped.resumeReturnedUndefined++;
        continue;
      }
      console.log(`[AutoResume] resuming ${sessionKey}: project=${entry.projectName}, claudeSessionId=${entry.claudeSessionId}, idle=${Math.round(idleMs / 1000)}s`);

      clearConversation(sessionKey);

      // Restore topic in memory and update bot name. Refresh the name even
      // when no topic was persisted — otherwise the bot keeps whatever name
      // was last sent (potentially for a different chat/project) after restart.
      if (isBotNameEnabled(sessionKey)) {
        const displayName = setSessionTopic(sessionKey, entry.topic || '');
        try {
          const result = await rateLimitedSetMyName(bot.api, (n) => bot.api.setMyName(n), displayName);
          await notifyBotNameBlockToChat(bot.api, chatId, result, threadId);
        } catch (e) {
          console.debug('[AutoResume] Failed to update bot name:', e instanceof Error ? e.message : e);
        }
      }

      const projectName = path.basename(session.workingDirectory);
      const opts = threadOpts(threadId);

      // Header: plain status text — escape for MarkdownV2 so any special chars
      // in topic/project names don't break the parser. Kept compact (no prompt
      // body) so a long stored prompt doesn't blow past the 4096-char limit;
      // the prompt is delivered in its own chunked block below.
      let header = `✅ Reloaded and session restored: ${escapeMarkdownV2(projectName)}`;
      if (entry.topic) {
        header += ` \\(topic: ${escapeMarkdownV2(entry.topic)}\\)`;
      }
      const effortLabel = getEffortLabel(chatId);
      if (effortLabel) {
        header += `\nEffort: ${escapeMarkdownV2(effortLabel)}`;
      }
      try {
        await bot.api.sendMessage(chatId, header, { parse_mode: 'MarkdownV2', ...opts });
      } catch {
        // Markdown parser rejected — fall back to plain text without escapes.
        const plain = header.replace(/\\(.)/g, '$1');
        for (const chunk of splitMessage(plain)) {
          await bot.api.sendMessage(chatId, chunk, opts);
        }
      }

      // Last prompt: deliver the full stored prompt as its own message
      // (chunked if long). User input is treated as literal text — escape
      // rather than re-render as markdown so a literal `*` or `_` doesn't
      // become formatting noise.
      if (entry.lastMessagePreview) {
        await bot.api.sendMessage(chatId, '📝 Last prompt:', opts);
        await sendBlockWithPlainFallback(bot, chatId, opts, entry.lastMessagePreview, 'AutoResume');
      }

      // Assistant preview: re-render with full MarkdownV2 formatting (mirrors
      // how messageSender.sendMessage delivers normal responses) so bold/code/
      // links survive the resume.
      if (entry.lastAssistantPreview) {
        await bot.api.sendMessage(chatId, '💬 Last response:', opts);
        await sendBlockWithPlainFallback(bot, chatId, opts, entry.lastAssistantPreview, 'AutoResume', 'render');
      }
      resumed++;
      notified.add(sessionKey);
    } catch (err) {
      console.error(`[AutoResume] Failed to resume ${sessionKey}:`, err);
      skipped.threw++;
    }
  }

  const skipSummary = Object.entries(skipped)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}=${n}`)
    .join(', ');
  console.log(
    `[AutoResume] Done: restored=${resumed}/${activeSessions.size}` +
    (skipSummary ? `, skipped(${skipSummary})` : '')
  );
  return true;
}
