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
import { clearConversation } from './providers/provider-router.js';
import { parseSessionKey } from './utils/session-key.js';
import { setSessionTopic, getEffortLabel } from './bot/handlers/command.handler.js';
import { isBotNameEnabled, rateLimitedSetMyName } from './telegram/botname-settings.js';
import { splitMessage } from './telegram/markdown.js';
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

/** Ask the launcher to restart a sibling worker by name. */
export function requestSiblingRestart(name: string): Promise<{ success: boolean; name?: string; reason?: string }> {
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
    pp.postMessage({ type: 'restart_sibling', name });
    // Timeout in case the launcher never responds
    const timer = setTimeout(() => {
      pp.off('message', handler);
      resolve({ success: false, reason: 'timeout' });
    }, 5000);
  });
}

/** Ask the launcher to restart ALL workers. Returns false if not in worker mode. */
export function requestRestartAll(): boolean {
  if (!isMainThread && parentPort) {
    parentPort.postMessage({ type: 'restart_all' });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Auto-resume after /rebuild or /restartbot
// ---------------------------------------------------------------------------

const RELOAD_MARKER_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

async function autoResumeAfterReload(bot: Bot): Promise<void> {
  const markerFile = getReloadMarkerPath();
  if (!fs.existsSync(markerFile)) return;

  let marker: { timestamp: string };
  try {
    const raw = fs.readFileSync(markerFile, 'utf-8');
    marker = JSON.parse(raw);
  } catch {
    try { fs.unlinkSync(markerFile); } catch {}
    return;
  }

  // Validate timestamp freshness
  const age = Date.now() - new Date(marker.timestamp).getTime();
  if (age > RELOAD_MARKER_MAX_AGE_MS || age < 0) {
    console.log('[AutoResume] Stale marker file, ignoring');
    try { fs.unlinkSync(markerFile); } catch {}
    return;
  }

  // Delete marker immediately to prevent double-processing or crash loops
  try { fs.unlinkSync(markerFile); } catch {}

  // Resume all recent active sessions that belong to this instance
  const activeSessions = sessionHistory.getAllActiveSessions();
  const allowedIds = new Set([
    ...config.ALLOWED_USER_IDS,
    ...config.ALLOWED_GROUP_IDS,
  ]);
  let resumed = 0;

  for (const [sessionKey, entry] of activeSessions) {
    const { chatId, threadId } = parseSessionKey(sessionKey);

    // Only resume sessions belonging to this bot instance
    if (!allowedIds.has(chatId)) continue;

    // Only resume sessions with recent activity (within last hour)
    const lastActivity = new Date(entry.lastActivity).getTime();
    if (Date.now() - lastActivity > 60 * 60 * 1000) continue;

    // Only resume sessions that have a Claude session ID
    if (!entry.claudeSessionId) continue;

    try {
      const session = sessionManager.resumeLastSession(sessionKey);
      if (!session) continue;

      clearConversation(sessionKey);

      // Restore topic in memory and update bot name
      if (entry.topic && isBotNameEnabled(sessionKey)) {
        const displayName = setSessionTopic(sessionKey, entry.topic);
        try {
          await rateLimitedSetMyName(bot.api, (n) => bot.api.setMyName(n), displayName);
        } catch (e) {
          console.debug('[AutoResume] Failed to update bot name:', e instanceof Error ? e.message : e);
        }
      }

      const projectName = path.basename(session.workingDirectory);
      let msg = `✅ Reloaded and session restored: ${projectName}`;
      if (entry.topic) {
        msg += ` (topic: ${entry.topic})`;
      }
      const effortLabel = getEffortLabel(chatId);
      if (effortLabel) {
        msg += `\nEffort: ${effortLabel}`;
      }
      if (entry.lastMessagePreview) {
        msg += `\n\n📝 Last prompt:\n${entry.lastMessagePreview}`;
      }
      if (entry.lastAssistantPreview) {
        msg += `\n\n💬 Last response:\n${entry.lastAssistantPreview}`;
      }
      // The last response can span multiple Telegram messages — chunk so
      // it survives the 4096-char per-message limit instead of getting cut off.
      const chunks = splitMessage(msg);
      for (const chunk of chunks) {
        await bot.api.sendMessage(chatId, chunk, {
          ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
        });
      }
      resumed++;
    } catch (err) {
      console.error(`[AutoResume] Failed to resume ${sessionKey}:`, err);
    }
  }

  if (resumed > 0) {
    console.log(`[AutoResume] Restored ${resumed} session(s)`);
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

  // Auto-resume sessions after /rebuild or /restartbot
  try {
    await autoResumeAfterReload(bot);
  } catch (err) {
    console.error('[AutoResume] Failed:', err);
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
