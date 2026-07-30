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
import { setMonitorRelayBot } from './claude/monitor-relay.js';
import { setUpdateBannerRelayBot } from './claude/update-banner-relay.js';
import { startPendingForkWatcher } from './bot/handlers/fork.handler.js';
import { parseSessionKey } from './utils/session-key.js';
import { setSessionTopic, getEffortLabel } from './bot/handlers/command.handler.js';
import { isBotNameEnabled, rateLimitedSetMyName, notifyBotNameBlockToChat, syncBotNameOnStartup } from './telegram/botname-settings.js';
import { splitMessage, escapeMarkdownV2, processMessageForTelegram } from './telegram/markdown.js';
import type { Bot } from 'grammy';

// When running as a worker thread (multi-instance mode), prefix all console
// output with the instance name so logs from different bots are distinguishable.
const instanceName = process.env.TELECODER_INSTANCE_NAME;
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

// How long a graceful shutdown may take before we exit regardless.
const SHUTDOWN_TIMEOUT_MS = 5_000;

async function autoResumeAfterReload(bot: Bot): Promise<boolean> {
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
  const allowedIds = new Set([
    ...config.ALLOWED_USER_IDS,
    ...config.ALLOWED_GROUP_IDS,
  ]);
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
      const threadOpts = threadId !== undefined ? { message_thread_id: threadId } : {};

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
        await bot.api.sendMessage(chatId, header, { parse_mode: 'MarkdownV2', ...threadOpts });
      } catch {
        // Markdown parser rejected — fall back to plain text without escapes.
        const plain = header.replace(/\\(.)/g, '$1');
        for (const chunk of splitMessage(plain)) {
          await bot.api.sendMessage(chatId, chunk, threadOpts);
        }
      }

      // Last prompt: deliver the full stored prompt as its own message
      // (chunked if long). User input is treated as literal text — escape
      // rather than re-render as markdown so a literal `*` or `_` doesn't
      // become formatting noise.
      if (entry.lastMessagePreview) {
        await bot.api.sendMessage(chatId, '📝 Last prompt:', threadOpts);
        const escaped = escapeMarkdownV2(entry.lastMessagePreview);
        let mdFailed = false;
        for (const part of splitMessage(escaped)) {
          if (mdFailed) break;
          try {
            await bot.api.sendMessage(chatId, part, { parse_mode: 'MarkdownV2', ...threadOpts });
          } catch (error) {
            console.error('[AutoResume] MarkdownV2 send failed for prompt, falling back to plain text:', error);
            mdFailed = true;
            for (const chunk of splitMessage(entry.lastMessagePreview)) {
              await bot.api.sendMessage(chatId, chunk, threadOpts);
            }
          }
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
  return true;
}

// ---------------------------------------------------------------------------
// Cold-start auto-continue
// ---------------------------------------------------------------------------

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
 * Skipped when the reload-marker path already handled startup, or when the
 * session is already live in memory (notifyInterruptedSessions restored it).
 */
async function autoContinueOnStartup(bot: Bot): Promise<void> {
  const activeSessions = sessionHistory.getAllActiveSessions();
  const allowedIds = new Set([
    ...config.ALLOWED_USER_IDS,
    ...config.ALLOWED_GROUP_IDS,
  ]);

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
    const threadOpts = threadId !== undefined ? { message_thread_id: threadId } : {};
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
              ...threadOpts,
              reply_markup: replyMarkup,
            });
            sessionHistory.markStartupPrompted(sessionKey, sent.message_id);
            prompted++;
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
        ...threadOpts,
        reply_markup: replyMarkup,
      });
      sessionHistory.markStartupPrompted(sessionKey, sent.message_id);
      prompted++;
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
    const text =
      `⚠️ I was interrupted while running a task\\. The last action may not have completed\\.`;
    try {
      await bot.api.sendMessage(chatId, text, { parse_mode: 'MarkdownV2', ...threadOpts });
    } catch (err) {
      console.error(`[InFlight] Failed to notify ${entry.sessionKey}:`, err);
    }

    // Deliver the interrupted prompt as its own chunked block so long prompts
    // survive intact rather than getting clipped into the header.
    if (entry.messagePreview) {
      try {
        await bot.api.sendMessage(chatId, '📝 Last prompt:', threadOpts);
        const escaped = escapeMarkdownV2(entry.messagePreview);
        let mdFailed = false;
        for (const part of splitMessage(escaped)) {
          if (mdFailed) break;
          try {
            await bot.api.sendMessage(chatId, part, { parse_mode: 'MarkdownV2', ...threadOpts });
          } catch (error) {
            console.error(`[InFlight] MarkdownV2 send failed for prompt, falling back to plain text:`, error);
            mdFailed = true;
            for (const chunk of splitMessage(entry.messagePreview)) {
              await bot.api.sendMessage(chatId, chunk, threadOpts);
            }
          }
        }
      } catch (err) {
        console.error(`[InFlight] Failed to deliver prompt for ${entry.sessionKey}:`, err);
      }
    }
  }
}

async function main() {
  console.log('🤖 Starting TeleCoder...');
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
  let markerHandled = false;
  try {
    markerHandled = await autoResumeAfterReload(bot);
  } catch (err) {
    console.error('[AutoResume] Failed:', err);
  }

  // Notify any chats whose tasks were interrupted by an unexpected exit.
  try {
    await notifyInterruptedSessions(bot);
  } catch (err) {
    console.error('[InFlight] Failed:', err);
  }

  // Cold-start auto-continue. Skipped when a reload marker was just consumed
  // (those chats already saw the full "Reloaded and session restored" recap
  // and don't need a follow-up prompt).
  if (!markerHandled) {
    try {
      await autoContinueOnStartup(bot);
    } catch (err) {
      console.error('[AutoContinue] Failed:', err);
    }
  }

  // Reconcile the Telegram display name with BOT_NAME. Runs after the resume
  // paths above so a session restore — which pushes its own "BOT_NAME —
  // project" name — wins and this becomes a no-op; only a bot whose name
  // nobody claimed this startup gets rewritten.
  try {
    await syncBotNameOnStartup(bot.api);
  } catch (err) {
    console.debug('[BotName] Startup sync failed:', err instanceof Error ? err.message : err);
  }

  // Re-arm persisted scheduled tasks (/schedule). Runs after session
  // restore so the first scheduled fire can resolve the live session
  // instead of paying a cold-spawn tax.
  try {
    startScheduledRunner(bot);
  } catch (err) {
    console.error('[Scheduler] Failed to start:', err);
  }

  // Register the bot reference for the PTY-mode Monitor relay so Monitor
  // events that fire between user turns can be posted to Telegram.
  setMonitorRelayBot(bot);

  // And the update-banner relay, so claude code's "Update available" notice
  // (printed once at PTY startup) is forwarded to the user instead of being
  // silently consumed by the headless xterm.
  setUpdateBannerRelayBot(bot);

  // Watch for cross-bot fork handoffs landing in our pending-forks file and
  // proactively DM the user so they don't have to message us first to see
  // the offer.
  try {
    startPendingForkWatcher(bot);
  } catch (err) {
    console.error('[Fork] Failed to start pending-fork watcher:', err);
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
    // Don't let a stuck runner.stop() (e.g. a getUpdates call that never
    // settles) hold the exit open — the launcher is waiting on it to restart us.
    const exitWatchdog = setTimeout(() => {
      console.warn(`[Shutdown] Runner did not stop within ${Math.round(SHUTDOWN_TIMEOUT_MS / 1000)}s — exiting anyway`);
      process.exit(0);
    }, SHUTDOWN_TIMEOUT_MS);
    exitWatchdog.unref();
    await runner.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => { shutdown(); });
  process.on('SIGTERM', () => { shutdown(); });

  // When running as a worker thread, communicate with the launcher
  if (!isMainThread && parentPort) {
    parentPort.on('message', (msg: { type?: string }) => {
      // 'exit_for_restart' is the launcher answering a restart request: we exit
      // ourselves rather than waiting to be terminated. A worker.terminate()
      // only lands when the thread next runs JS, so a worker blocked in native
      // code would never die — and never be respawned.
      if (msg?.type === 'shutdown' || msg?.type === 'exit_for_restart') shutdown();
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
