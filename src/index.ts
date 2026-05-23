import { run } from '@grammyjs/runner';
import { isMainThread, parentPort } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';
import { createBot } from './bot/bot.js';
import { config, BOT_ID, getReloadMarkerPath } from './config.js';
import { preventSleep, allowSleep } from './utils/caffeinate.js';
import { stopCleanup } from './telegram/deduplication.js';
import { sessionManager } from './claude/session-manager.js';
import { sessionHistory } from './claude/session-history.js';
import { consumeAllInFlight } from './claude/in-flight-tracker.js';
import { clearConversation } from './providers/provider-router.js';
import { startScheduledRunner } from './claude/scheduled-runner.js';
import { parseSessionKey } from './utils/session-key.js';
import { setSessionTopic, getEffortLabel } from './bot/handlers/command.handler.js';
import { isBotNameEnabled, rateLimitedSetMyName, notifyBotNameBlockToChat } from './telegram/botname-settings.js';
import { splitMessage, escapeMarkdownV2, processMessageForTelegram } from './telegram/markdown.js';
import type { Bot } from 'grammy';

// When running as a worker thread (multi-instance mode), prefix all console
// output with the instance name so logs from different bots are distinguishable.
const instanceName = process.env.CLAUDEGRAM_INSTANCE_NAME;
if (instanceName) {
  const prefix = `[${instanceName}]`;
  const origLog = console.log.bind(console);
  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);
  console.log = (...args: unknown[]) => origLog(prefix, ...args);
  console.error = (...args: unknown[]) => origError(prefix, ...args);
  console.warn = (...args: unknown[]) => origWarn(prefix, ...args);
}

// Log unhandled rejections — prevents silent failures where the process stays
// alive but functionality is broken (e.g. fire-and-forget async calls that fail).
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled promise rejection:', reason);
});

// ---------------------------------------------------------------------------
// Multi-instance restart helpers (used by command handler)
// ---------------------------------------------------------------------------

/** Ask the launcher to restart this worker. Returns false if not in worker mode. */
export function requestRestart(): boolean {
  if (!isMainThread && parentPort) {
    parentPort.postMessage({ type: 'restart' });
    return true;
  }
  return false;
}

/** Ask the launcher to restart a sibling worker by name. When autoResume is
 * true, the launcher writes a reload marker for the sibling so it auto-
 * restores its sessions on respawn (the requesting worker can't write the
 * marker itself — it lives at a per-bot path keyed by the sibling's token). */
export function requestSiblingRestart(name: string, autoResume = false): Promise<{ success: boolean; name?: string; reason?: string }> {
  return new Promise((resolve) => {
    if (isMainThread || !parentPort) {
      return resolve({ success: false, reason: 'not in multi-instance mode' });
    }
    const pp = parentPort;
    const handler = (msg: { type?: string; success?: boolean; name?: string; reason?: string }) => {
      if (msg?.type === 'restart_sibling_result') {
        pp.off('message', handler);
        clearTimeout(timer);
        resolve({ success: !!msg.success, name: msg.name, reason: msg.reason });
      }
    };
    pp.on('message', handler);
    pp.postMessage({ type: 'restart_sibling', name, autoResume });
    // Timeout in case the launcher never responds
    const timer = setTimeout(() => {
      pp.off('message', handler);
      resolve({ success: false, reason: 'timeout' });
    }, 5000);
  });
}

/** Ask the launcher to restart ALL workers. When autoResume is true, the
 * launcher writes reload markers for every instance so all of them — not just
 * the one that initiated the command — restore their sessions on respawn. */
export function requestRestartAll(autoResume = false): boolean {
  if (!isMainThread && parentPort) {
    parentPort.postMessage({ type: 'restart_all', autoResume });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Auto-resume after /rebuildbot or /restartbot
// ---------------------------------------------------------------------------

const RELOAD_MARKER_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

async function autoResumeAfterReload(bot: Bot): Promise<void> {
  const markerFile = getReloadMarkerPath();
  if (!fs.existsSync(markerFile)) {
    console.log(`[AutoResume] No reload marker at ${markerFile} — skipping auto-resume`);
    return;
  }

  let marker: { timestamp: string };
  try {
    const raw = fs.readFileSync(markerFile, 'utf-8');
    marker = JSON.parse(raw);
  } catch (err) {
    console.warn(`[AutoResume] Marker file ${markerFile} is unreadable, deleting:`, err instanceof Error ? err.message : err);
    try { fs.unlinkSync(markerFile); } catch {}
    return;
  }

  // Validate timestamp freshness
  const age = Date.now() - new Date(marker.timestamp).getTime();
  if (age > RELOAD_MARKER_MAX_AGE_MS || age < 0) {
    console.log(`[AutoResume] Stale marker (age=${age}ms, max=${RELOAD_MARKER_MAX_AGE_MS}ms), ignoring`);
    try { fs.unlinkSync(markerFile); } catch {}
    return;
  }

  console.log(`[AutoResume] Found fresh marker (age=${Math.round(age / 1000)}s), evaluating sessions for restore`);

  // Delete marker immediately to prevent double-processing or crash loops
  try { fs.unlinkSync(markerFile); } catch {}

  // Resume all recent active sessions that belong to this instance
  const activeSessions = sessionHistory.getAllActiveSessions();
  const allowedIds = new Set([
    ...config.ALLOWED_USER_IDS,
    ...config.ALLOWED_GROUP_IDS,
  ]);
  console.log(`[AutoResume] ${activeSessions.size} candidate session(s) in history; allowlist size=${allowedIds.size}`);

  let resumed = 0;
  const skipped: Record<string, number> = { notAllowed: 0, idle: 0, noClaudeSessionId: 0, resumeReturnedUndefined: 0, threw: 0 };

  for (const [sessionKey, entry] of activeSessions) {
    const { chatId, threadId } = parseSessionKey(sessionKey);

    // Only resume sessions belonging to this bot instance
    if (!allowedIds.has(chatId)) {
      console.log(`[AutoResume] skip ${sessionKey}: chatId ${chatId} not in this bot's allowlist`);
      skipped.notAllowed++;
      continue;
    }

    // Only resume sessions with recent activity (within last hour)
    const lastActivity = new Date(entry.lastActivity).getTime();
    const idleMs = Date.now() - lastActivity;
    if (idleMs > 60 * 60 * 1000) {
      console.log(`[AutoResume] skip ${sessionKey}: idle for ${Math.round(idleMs / 60000)}min (cutoff=60min, lastActivity=${entry.lastActivity})`);
      skipped.idle++;
      continue;
    }

    // Only resume sessions that have a Claude session ID
    if (!entry.claudeSessionId) {
      console.log(`[AutoResume] skip ${sessionKey}: entry has no claudeSessionId (conversationId=${entry.conversationId}, project=${entry.projectName}) — likely a session that never completed init`);
      skipped.noClaudeSessionId++;
      continue;
    }

    try {
      const session = sessionManager.resumeLastSession(sessionKey);
      if (!session) {
        console.warn(`[AutoResume] skip ${sessionKey}: sessionManager.resumeLastSession returned undefined (history entry exists with claudeSessionId=${entry.claudeSessionId})`);
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
      const threadOpts = threadId !== undefined ? { message_thread_id: threadId } : {};

      // Header: plain status text — escape for MarkdownV2 so any special chars
      // in topic/project names don't break the parser.
      let header = `✅ Reloaded and session restored: ${escapeMarkdownV2(projectName)}`;
      if (entry.topic) {
        header += ` \\(topic: ${escapeMarkdownV2(entry.topic)}\\)`;
      }
      const effortLabel = getEffortLabel(chatId);
      if (effortLabel) {
        header += `\nEffort: ${escapeMarkdownV2(effortLabel)}`;
      }
      if (entry.lastMessagePreview) {
        header += `\n\n📝 Last prompt:\n${escapeMarkdownV2(entry.lastMessagePreview)}`;
      }
      try {
        await bot.api.sendMessage(chatId, header, { parse_mode: 'MarkdownV2', ...threadOpts });
      } catch {
        // Markdown parser rejected — fall back to plain text without escapes.
        const plain = header.replace(/\\(.)/g, '$1');
        for (const chunk of splitMessage(plain)) {
          await bot.api.sendMessage(chatId, chunk, threadOpts);
        }
      }

      // Assistant preview: re-render with full MarkdownV2 formatting (mirrors
      // how messageSender.sendMessage delivers normal responses) so bold/code/
      // links survive the resume.
      if (entry.lastAssistantPreview) {
        await bot.api.sendMessage(chatId, '💬 Last response:', threadOpts);
        const parts = processMessageForTelegram(entry.lastAssistantPreview);
        let mdFailed = false;
        for (const part of parts) {
          if (mdFailed) break;
          try {
            await bot.api.sendMessage(chatId, part, { parse_mode: 'MarkdownV2', ...threadOpts });
          } catch (error) {
            console.error('[AutoResume] MarkdownV2 send failed, falling back to plain text:', error);
            mdFailed = true;
            for (const chunk of splitMessage(entry.lastAssistantPreview)) {
              await bot.api.sendMessage(chatId, chunk, threadOpts);
            }
          }
        }
      }
      resumed++;
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
}

/**
 * If a task was running when the bot exited (clean or crash), surface that
 * to the affected chat so the user knows their last prompt may not have
 * completed. Also ensures the session is restored in memory so the next
 * message arrives at a live session.
 */
async function notifyInterruptedSessions(bot: Bot): Promise<void> {
  const interrupted = consumeAllInFlight();
  if (interrupted.length === 0) return;

  const allowedIds = new Set([
    ...config.ALLOWED_USER_IDS,
    ...config.ALLOWED_GROUP_IDS,
  ]);

  for (const entry of interrupted) {
    const { chatId, threadId } = parseSessionKey(entry.sessionKey);
    if (!allowedIds.has(chatId)) continue;

    // Make sure the session is live in memory so the user can immediately reply.
    if (!sessionManager.getSession(entry.sessionKey)) {
      sessionManager.resumeLastSession(entry.sessionKey);
    }

    const threadOpts = threadId !== undefined ? { message_thread_id: threadId } : {};
    const previewLine = entry.messagePreview
      ? `\n\n📝 Last prompt:\n${escapeMarkdownV2(entry.messagePreview)}`
      : '';
    const text =
      `⚠️ I was interrupted while running a task\\. The last action may not have completed\\.${previewLine}`;
    try {
      await bot.api.sendMessage(chatId, text, { parse_mode: 'MarkdownV2', ...threadOpts });
    } catch (err) {
      console.error(`[InFlight] Failed to notify ${entry.sessionKey}:`, err);
    }
  }
}

async function main() {
  console.log('🤖 Starting Claudegram...');
  console.log(`📋 Allowed users: ${config.ALLOWED_USER_IDS.join(', ')}`);
  console.log(`📝 Mode: ${config.STREAMING_MODE}`);

  // Scope session history to this bot instance so multi-bot setups don't cross-restore
  sessionHistory.initForBot(BOT_ID);

  // Prevent system sleep on macOS (only when running standalone, not as worker)
  if (isMainThread) preventSleep();

  const bot = await createBot();

  // Initialize bot (fetches bot info from Telegram)
  await bot.init();
  console.log(`✅ Bot started as @${bot.botInfo.username}`);
  console.log('📱 Send /start in Telegram to begin');

  // Start concurrent runner — updates are processed in parallel,
  // with per-chat ordering enforced by the sequentialize middleware in bot.ts.
  // This lets /cancel bypass the per-chat queue and interrupt running queries.
  const runner = run(bot);

  // Auto-resume sessions after /rebuildbot or /restartbot
  try {
    await autoResumeAfterReload(bot);
  } catch (err) {
    console.error('[AutoResume] Failed:', err);
  }

  // Notify any chats whose tasks were interrupted by an unexpected exit.
  try {
    await notifyInterruptedSessions(bot);
  } catch (err) {
    console.error('[InFlight] Failed:', err);
  }

  // Re-arm persisted scheduled tasks (/schedule). Runs after session
  // restore so the first scheduled fire can resolve the live session
  // instead of paying a cold-spawn tax.
  try {
    startScheduledRunner(bot);
  } catch (err) {
    console.error('[Scheduler] Failed to start:', err);
  }

  // Liveness heartbeat: periodically verify the bot can still reach the
  // Telegram API. If the runner has stopped or getMe fails repeatedly,
  // exit so PM2 can restart the process.
  const HEARTBEAT_INTERVAL_MS = 60_000;
  const MAX_HEARTBEAT_FAILURES = 3;
  let heartbeatFailures = 0;
  const heartbeatTimer = setInterval(async () => {
    if (!runner.isRunning()) {
      console.error('[HEARTBEAT] Runner is no longer running — exiting for restart');
      process.exit(1);
    }
    try {
      await bot.api.getMe();
      heartbeatFailures = 0;
    } catch (err) {
      heartbeatFailures++;
      console.error(`[HEARTBEAT] getMe failed (${heartbeatFailures}/${MAX_HEARTBEAT_FAILURES}):`, err);
      if (heartbeatFailures >= MAX_HEARTBEAT_FAILURES) {
        console.error('[HEARTBEAT] Too many consecutive failures — exiting for restart');
        process.exit(1);
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref(); // Don't prevent graceful shutdown

  // Graceful shutdown (guarded against duplicate signals)
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n👋 Shutting down...');
    clearInterval(heartbeatTimer);
    allowSleep();
    stopCleanup();
    await runner.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => { shutdown(); });
  process.on('SIGTERM', () => { shutdown(); });

  // When running as a worker thread, communicate with the launcher
  if (!isMainThread && parentPort) {
    parentPort.on('message', (msg: { type?: string }) => {
      if (msg?.type === 'shutdown') shutdown();
    });

    // Send periodic heartbeat so the launcher can detect stuck workers
    const pp = parentPort;
    const workerHeartbeat = setInterval(() => pp.postMessage({ type: 'heartbeat' }), 30_000);
    workerHeartbeat.unref();
  }

  // Keep alive until the runner stops (crash or explicit stop)
  await runner.task();
}

main().catch((error) => {
  console.error('Fatal error:', error);
  allowSleep();
  process.exit(1);
});
