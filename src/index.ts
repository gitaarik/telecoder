/**
 * Process entry point.
 *
 * Everything here is bootstrap: environment fixups that must land before any
 * provider spawns, then `main()` — build the bot, run the startup routines in
 * order, arm the background services, and hold the process open until the
 * runner stops.
 *
 * The startup routines themselves live in `./startup/`, and the worker-to-
 * launcher restart requests in `./worker-restart.ts`, re-exported below
 * because they were part of this module's public surface.
 */

import { run } from '@grammyjs/runner';
import { isMainThread, parentPort } from 'worker_threads';
import { createBot } from './bot/bot.js';
import { config, BOT_ID } from './config.js';
import { preventSleep, allowSleep } from './utils/caffeinate.js';
import { stopCleanup } from './telegram/deduplication.js';
import { sessionHistory } from './claude/session-history.js';
import { listAdmitted } from './utils/user-roster.js';
import { startScheduledRunner } from './claude/scheduled-runner.js';
import { setMonitorRelayBot } from './claude/monitor-relay.js';
import { setUpdateBannerRelayBot } from './claude/update-banner-relay.js';
import { startPendingForkWatcher } from './bot/handlers/fork.handler.js';
import { initPrefsSync } from './providers/prefs-sync.js';
import { stripParentClaudeSession } from './utils/claude-env.js';
import { syncBotNameOnStartup } from './telegram/botname-settings.js';
import { autoResumeAfterReload } from './startup/auto-resume.js';
import { autoContinueOnStartup } from './startup/auto-continue.js';
import { notifyInterruptedSessions, notifyRestartComplete } from './startup/notices.js';
import { tickWasStalled } from './utils/host-stall.js';

export { requestRestart, requestSiblingRestart, requestRestartAll } from './worker-restart.js';

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

// Drop any Claude Code session markers we inherited before a provider spawns
// anything. Restarting the bot from inside a claude session (which is how it
// happens here — the bot's own session runs `pm2 start`) otherwise leaves every
// claude we spawn believing it's a nested session, with transcript persistence
// off and no session log for us to read replies from. See utils/claude-env.ts.
const strippedClaudeVars = stripParentClaudeSession();
if (strippedClaudeVars.length > 0) {
  console.warn(
    `[Env] Bot was launched from inside a Claude Code session; dropped inherited markers so spawned sessions persist normally: ${strippedClaudeVars.join(', ')}`,
  );
}

// Log unhandled rejections — prevents silent failures where the process stays
// alive but functionality is broken (e.g. fire-and-forget async calls that fail).
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled promise rejection:', reason);
});

// How long a graceful shutdown may take before we exit regardless.
const SHUTDOWN_TIMEOUT_MS = 5_000;

async function main() {
  console.log('🤖 Starting TeleCoder...');
  console.log(`📋 Allowed users: ${config.ALLOWED_USER_IDS.join(', ')}`);
  // The roster is the other half of the allow-list, and the half that changed
  // while nobody was reading the log — worth naming at startup so "who can use
  // this bot" is answerable from the boot output alone.
  const admittedIds = listAdmitted().map((user) => user.id);
  if (admittedIds.length > 0) {
    console.log(`📋 Admitted from chat: ${admittedIds.join(', ')}`);
  }
  console.log(`📝 Mode: ${config.STREAMING_MODE}`);

  // Scope session history to this bot instance so multi-bot setups don't cross-restore
  sessionHistory.initForBot(BOT_ID);

  // Accept model/effort changes another instance chose to apply fleet-wide.
  initPrefsSync();

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
  // Reassigned when a polling conflict forces a fresh runner (see below).
  let runner = run(bot);

  // Chats that received a startup message, so the restart confirmation below
  // doesn't pile a second one on top.
  const notified = new Set<string>();

  // Auto-resume sessions after /rebuildbot or /restartbot
  let markerHandled = false;
  try {
    markerHandled = await autoResumeAfterReload(bot, notified);
  } catch (err) {
    console.error('[AutoResume] Failed:', err);
  }

  // Notify any chats whose tasks were interrupted by an unexpected exit.
  try {
    await notifyInterruptedSessions(bot, notified);
  } catch (err) {
    console.error('[InFlight] Failed:', err);
  }

  // Cold-start auto-continue. Runs even after a reload marker was consumed:
  // auto-resume only restores sessions idle < 1h, so on a /rebuildbot with
  // nothing fresh enough to restore this is the only path that says anything
  // at all. Chats that DID get the "Reloaded and session restored" recap are
  // live in memory by then and skip themselves via the alreadyLive guard, so
  // no chat can receive both.
  try {
    await autoContinueOnStartup(bot, notified);
  } catch (err) {
    console.error('[AutoContinue] Failed:', err);
  }

  // Confirm the restart itself, but only for a user-initiated one — a fresh
  // reload marker is what distinguishes /rebuildbot and /restartbot from a
  // crash respawn or a plain pm2 restart.
  if (markerHandled) {
    try {
      await notifyRestartComplete(bot, notified);
    } catch (err) {
      console.error('[Restart] Failed:', err);
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
  // Timeouts get a longer leash than errors. An error is Telegram answering
  // with a fault we can act on; a timeout is us not hearing back, which on a
  // host under memory pressure says more about the host than the bot — and
  // exiting there tears down every live Claude session to "fix" a machine
  // that's merely busy. Restarting doesn't cure a stall, so ride it out.
  const MAX_HEARTBEAT_TIMEOUTS = 10;
  // Same reasoning as the launcher's stall guard: an interval that fires far
  // later than scheduled means this thread wasn't running, so the round it
  // would have done tells us nothing about Telegram's reachability.
  const HEARTBEAT_STALL_SLACK_MS = 30_000;
  const isTimeoutError = (err: unknown): boolean =>
    err instanceof Error && /timed out after/i.test(err.message);
  let heartbeatFailures = 0;
  let heartbeatTimeouts = 0;
  let lastHeartbeatAt = Date.now();
  // True only while we're deliberately between runners, waiting out a polling
  // conflict. The check below would otherwise read that gap as a dead runner.
  let replacingRunner = false;
  const heartbeatTimer = setInterval(async () => {
    const now = Date.now();
    const sinceLast = now - lastHeartbeatAt;
    lastHeartbeatAt = now;
    if (tickWasStalled({ sinceLastTickMs: sinceLast, intervalMs: HEARTBEAT_INTERVAL_MS, slackMs: HEARTBEAT_STALL_SLACK_MS })) {
      console.warn(`[HEARTBEAT] tick fired ${Math.round(sinceLast / 1000)}s late (expected ${Math.round(HEARTBEAT_INTERVAL_MS / 1000)}s) — host was frozen, skipping this round`);
      heartbeatFailures = 0;
      heartbeatTimeouts = 0;
      return;
    }
    if (!replacingRunner && !runner.isRunning()) {
      console.error('[HEARTBEAT] Runner is no longer running — exiting for restart');
      process.exit(1);
    }
    try {
      await bot.api.getMe();
      heartbeatFailures = 0;
      heartbeatTimeouts = 0;
    } catch (err) {
      if (isTimeoutError(err)) {
        heartbeatTimeouts++;
        console.error(`[HEARTBEAT] getMe timed out (${heartbeatTimeouts}/${MAX_HEARTBEAT_TIMEOUTS}):`, err);
        if (heartbeatTimeouts >= MAX_HEARTBEAT_TIMEOUTS) {
          console.error('[HEARTBEAT] Telegram unreachable for too long — exiting for restart');
          process.exit(1);
        }
        return;
      }
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

  // Keep alive until the runner stops (crash or explicit stop).
  //
  // A 409 from getUpdates means something else is polling this same token —
  // nearly always our own predecessor, whose long poll Telegram hasn't dropped
  // yet during a restart. grammY's runner classes it as unrecoverable and stops
  // (throwIfUnrecoverable in @grammyjs/runner), but the condition clears itself
  // within a poll timeout. Exiting over it would tear down every live Claude
  // session this bot owns, so put a fresh runner on the same bot instead and
  // only give up if the conflict is still there after several tries — by then
  // it's a real second instance, not an overlap.
  const CONFLICT_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000];
  const isConflict = (err: unknown): boolean =>
    typeof err === 'object' && err !== null &&
    (err as { error_code?: unknown }).error_code === 409;

  for (let attempt = 0; ; attempt++) {
    try {
      await runner.task();
      return;
    } catch (err) {
      if (shuttingDown || !isConflict(err)) throw err;

      const delay = CONFLICT_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) {
        console.error(`[Conflict] getUpdates still conflicting after ${CONFLICT_RETRY_DELAYS_MS.length} retries — another instance is polling this token for real`);
        throw err;
      }

      console.warn(`[Conflict] Another poller holds this bot's token — retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${CONFLICT_RETRY_DELAYS_MS.length})`);
      replacingRunner = true;
      await new Promise(resolve => setTimeout(resolve, delay));
      if (shuttingDown) return;
      runner = run(bot);
      replacingRunner = false;
    }
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  allowSleep();
  process.exit(1);
});
