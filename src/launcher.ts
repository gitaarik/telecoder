/**
 * Multi-instance launcher — runs multiple bot instances in a single process
 * using worker threads. Each worker gets its own module scope + environment,
 * so the existing global config singleton works without any changes.
 *
 * Usage:
 *   npm run start:multi                     # uses instances.json
 *   npm run start:multi -- --config my.json # custom config path
 *   npx tsx src/launcher.ts                 # dev mode
 */

import { Worker, isMainThread } from 'worker_threads';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { config as loadEnv } from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { getStateDir } from './utils/json-store.js';
import { stripJsonComments, expandName } from './utils/instance-config.js';
import { legacyEnv } from './utils/legacy-env.js';
import { planRespawn } from './utils/respawn-backoff.js';
import { tickWasStalled, withinStallCooldown, shouldEscalateWedged } from './utils/host-stall.js';
import { fingerprintModuleGraph } from './utils/stale-launcher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

// Heartbeat: workers ping the launcher periodically. If a worker goes silent
// for too long, the launcher force-terminates and respawns it.
const HEARTBEAT_CHECK_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 90_000;
// If the monitor's own interval fires this much later than scheduled, the
// launcher's event loop was frozen (host stall) — every worker will look
// silent for that reason, so we skip the round instead of mass-restarting.
const HEARTBEAT_STALL_SLACK_MS = 30_000;
// When >1 worker is silent at once it's almost certainly the host, not the
// bots. Hold off this many consecutive checks before restarting them, so a
// transient stall doesn't trigger a fleet-wide thundering-herd respawn.
const HEARTBEAT_MASS_SILENCE_LIMIT = 3;
// How long a detected host stall keeps the monitor's hands off. The stall
// guard above only covers the tick that fired late; a freeze that starves the
// workers without delaying our own tick — or one that lifts a moment before
// the next tick — still leaves them looking silent through no fault of their
// own. Workers go quiet one at a time in that state, which slips past the
// mass-silence guard, so give the whole fleet a quiet period to check back in
// after any stall we saw.
const HEARTBEAT_STALL_COOLDOWN_MS = 180_000;

// While a wedged worker is being escalated, how often to re-check whether the
// host has recovered enough to tell "wedged" from "starved" apart, and how
// long to keep deferring before escalating anyway. A host that stalls every
// few minutes for hours would otherwise defer forever, leaving the instance
// offline for good — the outcome the escalation exists to prevent.
const RESTART_WEDGED_RECHECK_MS = 30_000;
const RESTART_WEDGED_MAX_DEFER_MS = 1_800_000;

// A worker asked to restart exits itself (see 'exit_for_restart' in index.ts),
// which unwinds cleanly. If it hasn't gone this long after being asked, fall
// back to terminating the thread.
const RESTART_GRACEFUL_EXIT_MS = 10_000;
// terminate() only takes effect when the worker next runs JS: a thread blocked
// in a synchronous native call ignores it indefinitely, so the exit event never
// fires and the respawn below never runs — that instance stays dead for good.
// Rather than leave a bot silently offline, take the launcher down and let the
// process manager bring every instance back. Comfortably longer than the
// longest legitimate block (/rebuildbot's 120s build cap) so a slow-but-alive
// worker is never punished.
const RESTART_WEDGED_ESCALATION_MS = 180_000;

// An unplanned worker exit — a crash, or a fatal error the bot exited on — used
// to drop that instance for good. Bring it back instead, backing off so an
// instance that cannot start (a revoked token, say) doesn't spin. One delay per
// attempt; running out of delays is what "give up" means.
const CRASH_RESPAWN_DELAYS_MS = [1_000, 5_000, 15_000, 60_000];
// Crashes only count as a streak while they cluster. An instance that stayed up
// this long before dying starts its retry budget over, so two unrelated crashes
// days apart don't add up to a give-up.
const CRASH_STREAK_RESET_MS = 300_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ResolvedInstance {
  name: string;
  token: string;
  overrides?: Record<string, string>;
}

interface InstanceEntry {
  name: string;
  token?: string;    // single bot
  tokens?: string[]; // list = auto-template with sequential numbering
  overrides?: Record<string, string>;
}

interface InstancesConfig {
  defaults?: Record<string, string>;
  instances: InstanceEntry[];
}

// ---------------------------------------------------------------------------
// Load & expand instances config
// ---------------------------------------------------------------------------

function loadInstancesConfig(configPath: string): ResolvedInstance[] {
  if (!existsSync(configPath)) {
    console.error(`\u274c Instances config not found: ${configPath}`);
    console.error('  Copy instances.json.example to instances.json and configure your bots.');
    process.exit(1);
  }

  const raw = readFileSync(configPath, 'utf-8');
  const parsed: InstancesConfig = JSON.parse(stripJsonComments(raw));
  const defaults = parsed.defaults ?? {};
  const resolved: ResolvedInstance[] = [];

  for (const entry of parsed.instances ?? []) {
    const mergedOverrides = { ...defaults, ...entry.overrides };

    if (entry.tokens?.length) {
      // List of tokens → auto-template: expand name with {n}/{N}
      const total = entry.tokens.length;
      entry.tokens.forEach((token, i) => {
        resolved.push({
          name: expandName(entry.name, i + 1, total),
          token,
          overrides: mergedOverrides,
        });
      });
    } else if (entry.token) {
      // Single token → individual instance
      resolved.push({
        name: entry.name,
        token: entry.token,
        overrides: mergedOverrides,
      });
    } else {
      console.warn(`\u26a0\ufe0f Skipping instance "${entry.name}": no token or tokens provided`);
    }
  }

  if (resolved.length === 0) {
    console.error('\u274c No instances defined in config. Add instances with token or tokens.');
    process.exit(1);
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

if (!isMainThread) {
  console.error('launcher.ts must run on the main thread');
  process.exit(1);
}

// Parse --config flag
const args = process.argv.slice(2);
const configFlagIdx = args.indexOf('--config');
const configPath = configFlagIdx !== -1 && args[configFlagIdx + 1]
  ? path.resolve(args[configFlagIdx + 1])
  : path.join(projectRoot, 'instances.json');

// Load base .env so all env vars are available as defaults
const envPath = legacyEnv('ENV_PATH') || path.join(projectRoot, '.env');
loadEnv({ path: envPath });

const instances = loadInstancesConfig(configPath);

console.log(`\ud83d\ude80 Launching ${instances.length} bot instance(s)...`);

// Resolve the worker entry point (compiled JS or tsx for dev)
const workerEntry = existsSync(path.join(projectRoot, 'dist', 'index.js'))
  ? path.join(projectRoot, 'dist', 'index.js')
  : path.join(projectRoot, 'src', 'index.ts');

const isTsx = workerEntry.endsWith('.ts');

// The launcher's own code, as it was when this process loaded it. A rebuild
// replaces the file on disk and respawns every worker off the new one, but
// nothing can replace what this process is already running — so this value is
// taken once and never refreshed, and a later build that disagrees with it is
// a build the launcher hasn't picked up.
const launcherEntry = fileURLToPath(import.meta.url);
const launcherCodeAtStartup = fingerprintModuleGraph(launcherEntry);

const workers: Map<string, Worker> = new Map();
const pendingRestarts = new Set<string>();
const lastHeartbeat = new Map<string, number>();
// Per-worker "start restarting this one" callbacks, owned by spawnWorker so the
// exit/backstop bookkeeping stays with the worker it belongs to. Every restart
// path (self, sibling, all, missed heartbeat) goes through these rather than
// calling terminate() directly.
const restarters = new Map<string, () => void>();
// Consecutive unplanned exits per instance, used to pick a backoff delay and to
// decide when to stop trying. Reset by a planned restart or by an instance that
// stayed up longer than CRASH_STREAK_RESET_MS.
const crashStreaks = new Map<string, number>();
// Instances waiting out a respawn backoff. They have no entry in `workers`
// during the gap, so without this the "everything's gone" check below would
// fire mid-backoff and take the launcher down with it.
const respawning = new Set<string>();
// Set once a shutdown signal arrives. Workers exiting after that are supposed
// to be gone, so nothing should respawn them.
let shuttingDown = false;
// When the heartbeat monitor last caught its own event loop running late —
// proof the host froze. Both the monitor and the wedged-worker escalation
// consult it before concluding a worker is at fault.
let lastHostStallAt = 0;

/** How long ago the host was last seen frozen. Infinity if we've never seen it. */
function hostStalledAgoMs(): number {
  return lastHostStallAt === 0 ? Infinity : Date.now() - lastHostStallAt;
}

function restartWorker(name: string): void {
  const begin = restarters.get(name);
  if (!begin) {
    console.warn(`[Launcher] restart requested for ${name} but it has no live worker — skipping`);
    return;
  }
  begin();
}

function scheduleRespawn(inst: ResolvedInstance, delayMs: number): void {
  if (shuttingDown) return;
  respawning.add(inst.name);
  setTimeout(() => {
    respawning.delete(inst.name);
    if (shuttingDown) return;
    spawnWorker(inst);
    console.log(`[Launcher] ✓ ${inst.name} respawned`);
  }, delayMs);
}

function shutdownIfNothingLeft(code: number | null): void {
  if (workers.size > 0 || respawning.size > 0) return;
  // Every worker fired its exit event, so no thread is left to block teardown
  // and a plain exit is safe here — unlike hardExit()'s case below.
  console.log('All workers exited. Shutting down launcher.');
  process.exit(code ?? 0);
}

// process.exit() is not an escape hatch from a wedged worker. Node's teardown
// joins the worker threads on the way out, so the very thread stuck in a native
// call that defeated terminate() also blocks the exit: the process stops
// logging, never dies, and the process manager goes on reporting it healthy.
// SIGKILL is handled by the kernel and cannot be blocked by anything in-process.
// The brief delay is only to give the reason a chance to reach the log.
function hardExit(): void {
  setTimeout(() => process.kill(process.pid, 'SIGKILL'), 250);
}

// ---------------------------------------------------------------------------
// Worker lifecycle
// ---------------------------------------------------------------------------

interface WorkerMessage {
  type: string;
  name?: string;
  autoResume?: boolean;
}

// Mirrors getReloadMarkerPathForBotId in src/config.ts. We can't import config
// here because the launcher process has no TELEGRAM_BOT_TOKEN env var (only
// workers do), and config.ts validates it at import time.
const STATE_DIR = getStateDir();

function writeReloadMarkerForToken(token: string, instanceName?: string): void {
  let botId = '';
  try {
    botId = token.split(':')[0];
    if (!botId) {
      console.warn(`[Launcher] writeReloadMarkerForToken (${instanceName ?? '?'}) called with malformed token (no colon) — skipping`);
      return;
    }
    const markerPath = path.join(STATE_DIR, `pending-reload-${botId}.json`);
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(markerPath, JSON.stringify({ timestamp: new Date().toISOString() }));
    console.log(`[Launcher] Wrote reload marker for ${instanceName ?? botId} (botId=${botId}) at ${markerPath}`);
  } catch (err) {
    console.error(`[Launcher] Failed to write reload marker for ${instanceName ?? (botId || '?')}:`, err);
  }
}

function buildWorkerEnv(inst: ResolvedInstance): Record<string, string> {
  const env: Record<string, string> = {};

  // Copy base process.env (includes .env values)
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }

  // Apply instance overrides
  if (inst.overrides) {
    Object.assign(env, inst.overrides);
  }

  // Always set token and bot name
  env.TELEGRAM_BOT_TOKEN = inst.token;
  env.BOT_NAME = inst.name;

  // Tag for log prefixing inside the worker
  env.TELECODER_INSTANCE_NAME = inst.name;

  // Workers use this to enumerate sibling bots (e.g. for /fork). Mirrors the
  // launcher's own --config resolution so a custom config path still works.
  env.TELECODER_INSTANCES_CONFIG = configPath;

  // A pre-rename value inherited from the parent env would otherwise win the
  // fallback in utils/legacy-env.ts and point workers at a stale config.
  delete env.CLAUDEGRAM_INSTANCES_CONFIG;
  delete env.CLAUDEGRAM_INSTANCE_NAME;

  return env;
}

function spawnWorker(inst: ResolvedInstance): Worker {
  const env = buildWorkerEnv(inst);

  const workerOptions: ConstructorParameters<typeof Worker>[1] = {
    env,
    ...(isTsx ? {
      // When running .ts files directly, use tsx as the loader
      execArgv: ['--import', 'tsx'],
    } : {}),
  };

  const worker = new Worker(workerEntry, workerOptions);
  const spawnedAt = Date.now();
  lastHeartbeat.set(inst.name, Date.now());

  let exited = false;
  let restartBegun = false;

  // Drive this worker through a restart. Asking it to exit itself is the only
  // path that reliably works — terminate() is powerless against a thread stuck
  // in native code — so that comes first, with terminate() as a backstop and a
  // launcher-level bail-out if even that doesn't land.
  const beginRestart = (): void => {
    if (restartBegun || exited) return;
    restartBegun = true;
    pendingRestarts.add(inst.name);

    try {
      worker.postMessage({ type: 'exit_for_restart' });
    } catch (err) {
      console.warn(`[Launcher] Could not ask ${inst.name} to exit (${err instanceof Error ? err.message : err}) — terminating instead`);
      worker.terminate();
    }

    setTimeout(() => {
      if (exited) return;
      console.warn(`[Launcher] ${inst.name} did not exit within ${Math.round(RESTART_GRACEFUL_EXIT_MS / 1000)}s of being asked — terminating the thread`);
      worker.terminate();
    }, RESTART_GRACEFUL_EXIT_MS).unref();

    // A thread starved of CPU looks exactly like one wedged in native code:
    // both ignore terminate() and neither reaches the exit handler. Taking the
    // whole fleet down is the right answer only for the wedged one, so hold
    // off while the host is still frozen and re-check until it recovers.
    const restartAskedAt = Date.now();
    const escalationDueAt = restartAskedAt + RESTART_WEDGED_ESCALATION_MS;
    const escalateIfWedged = (): void => {
      if (exited) return;
      const stalledAgo = hostStalledAgoMs();
      const aliveFor = Math.round((Date.now() - restartAskedAt) / 1000);
      const escalate = shouldEscalateWedged({
        stalledAgoMs: stalledAgo,
        cooldownMs: HEARTBEAT_STALL_COOLDOWN_MS,
        deferredForMs: Date.now() - escalationDueAt,
        maxDeferMs: RESTART_WEDGED_MAX_DEFER_MS,
      });
      if (!escalate) {
        console.warn(`[Launcher] ${inst.name} hasn't exited ${aliveFor}s after being asked to restart, but the host stalled ${Math.round(stalledAgo / 1000)}s ago — a starved thread is indistinguishable from a wedged one, so re-checking in ${Math.round(RESTART_WEDGED_RECHECK_MS / 1000)}s instead of killing the launcher`);
        setTimeout(escalateIfWedged, RESTART_WEDGED_RECHECK_MS).unref();
        return;
      }
      console.error(`[Launcher] ${inst.name} still alive ${aliveFor}s after a restart was requested — the thread is wedged in native code and terminate() cannot reach it. Killing the launcher so the process manager restarts every instance.`);
      hardExit();
    };
    setTimeout(escalateIfWedged, RESTART_WEDGED_ESCALATION_MS).unref();
  };

  restarters.set(inst.name, beginRestart);

  worker.on('message', (msg: WorkerMessage) => {
    if (msg?.type === 'heartbeat') {
      lastHeartbeat.set(inst.name, Date.now());
    } else if (msg?.type === 'restart') {
      // Self-restart: this worker wants to be restarted
      console.log(`[Launcher] ${inst.name} requested self-restart`);
      beginRestart();
    } else if (msg?.type === 'restart_sibling') {
      // Cross-bot restart: restart a different worker by name
      const targetName = msg.name;
      if (!targetName) {
        worker.postMessage({ type: 'restart_sibling_result', success: false, name: targetName, reason: 'no name provided' });
        return;
      }

      const restartTarget = (resolvedName: string) => {
        const targetInst = instances.find(i => i.name === resolvedName);
        if (msg.autoResume && targetInst) {
          writeReloadMarkerForToken(targetInst.token, targetInst.name);
        }
        restartWorker(resolvedName);
      };

      const sibling = workers.get(targetName);
      if (!sibling) {
        // Try case-insensitive match
        const match = [...workers.keys()].find(k => k.toLowerCase() === targetName.toLowerCase());
        if (match) {
          console.log(`[Launcher] ${inst.name} requested restart of sibling ${match}`);
          restartTarget(match);
          worker.postMessage({ type: 'restart_sibling_result', success: true, name: match });
        } else {
          const available = [...workers.keys()].filter(k => k !== inst.name);
          worker.postMessage({
            type: 'restart_sibling_result', success: false, name: targetName,
            reason: available.length ? `not found (available: ${available.join(', ')})` : 'no other instances running',
          });
        }
      } else if (targetName === inst.name) {
        worker.postMessage({ type: 'restart_sibling_result', success: false, name: targetName, reason: 'use /restartbot without arguments to restart yourself' });
      } else {
        console.log(`[Launcher] ${inst.name} requested restart of sibling ${targetName}`);
        restartTarget(targetName);
        worker.postMessage({ type: 'restart_sibling_result', success: true, name: targetName });
      }
    } else if (msg?.type === 'launcher_stale') {
      // Answered from disk each time it's asked: the question only comes up
      // right after a build, and that build is what we're comparing against.
      const current = fingerprintModuleGraph(launcherEntry);
      const stale = !!launcherCodeAtStartup && !!current && current !== launcherCodeAtStartup;
      if (stale) {
        console.warn(`[Launcher] ${inst.name} rebuilt the launcher's own code — this process keeps running the copy it started with until it is restarted`);
      }
      worker.postMessage({ type: 'launcher_stale_result', stale });
    } else if (msg?.type === 'restart_all') {
      console.log(`[Launcher] ${inst.name} requested restart of ALL instances${msg.autoResume ? ' (with auto-resume)' : ''} — ${instances.length} configured, ${workers.size} live`);
      const liveNames = new Set(workers.keys());
      const missingFromWorkers = instances.filter(i => !liveNames.has(i.name)).map(i => i.name);
      if (missingFromWorkers.length > 0) {
        console.warn(`[Launcher] restart_all: configured instances with no live worker (won't be respawned by terminate): ${missingFromWorkers.join(', ')}`);
      }
      for (const i of instances) {
        // Only instances we're about to restart get the flag. Setting it for one
        // that has no worker leaves it stuck there with nothing to consume it,
        // and the next exit of that instance — whenever it comes back — reads as
        // planned, clearing its crash streak and skipping the backoff.
        if (liveNames.has(i.name)) pendingRestarts.add(i.name);
        // The marker still goes to everyone: an instance mid-backoff should
        // auto-resume when it does come up.
        if (msg.autoResume) {
          writeReloadMarkerForToken(i.token, i.name);
        }
      }
      // Stagger restarts to avoid port conflicts on respawn
      let delay = 0;
      for (const name of workers.keys()) {
        const scheduledAt = delay;
        setTimeout(() => {
          console.log(`[Launcher] restart_all: restarting ${name} (scheduled +${scheduledAt}ms)`);
          restartWorker(name);
        }, delay);
        delay += 200;
      }
    }
  });

  worker.on('error', (err) => {
    console.error(`[${inst.name}] Worker error:`, err);
  });

  worker.on('exit', (code) => {
    console.log(`[${inst.name}] Worker exited with code ${code}`);
    exited = true;
    lastHeartbeat.delete(inst.name);
    restarters.delete(inst.name);
    // Drop it now, in every path: the heartbeat monitor keys off `workers`, and
    // leaving a dead entry there makes it chase an instance that no longer has
    // a restarter to drive.
    workers.delete(inst.name);

    if (pendingRestarts.has(inst.name)) {
      // Planned restart — respawn after a short delay
      pendingRestarts.delete(inst.name);
      crashStreaks.delete(inst.name);
      console.log(`[Launcher] Respawning ${inst.name} in 1s...`);
      scheduleRespawn(inst, 1000);
      return;
    }

    // Unplanned exit. Whatever took it down — a fatal error, a 409 from a
    // predecessor's long poll that hadn't been dropped yet — this bot is now
    // silently offline and nothing else will notice, because the heartbeat
    // monitor only watches instances that still have a worker. Respawn it.
    const aliveMs = Date.now() - spawnedAt;
    const { streak, delayMs: delay } = planRespawn({
      aliveMs,
      previousStreak: crashStreaks.get(inst.name) ?? 0,
      delays: CRASH_RESPAWN_DELAYS_MS,
      streakResetMs: CRASH_STREAK_RESET_MS,
    });
    crashStreaks.set(inst.name, streak);

    if (delay === null) {
      console.error(`[Launcher] ${inst.name} exited unexpectedly ${streak} times in a row — giving up on it (restart the launcher to bring it back)`);
      shutdownIfNothingLeft(code);
      return;
    }

    console.warn(`[Launcher] ${inst.name} exited unexpectedly (code ${code}) after ${Math.round(aliveMs / 1000)}s up — respawning in ${Math.round(delay / 1000)}s (attempt ${streak}/${CRASH_RESPAWN_DELAYS_MS.length})`);
    scheduleRespawn(inst, delay);
  });

  workers.set(inst.name, worker);
  return worker;
}

// ---------------------------------------------------------------------------
// Spawn all instances
// ---------------------------------------------------------------------------

for (const inst of instances) {
  spawnWorker(inst);
  console.log(`  \u2713 ${inst.name}`);
}

// ---------------------------------------------------------------------------
// Heartbeat monitor — detect stuck workers and auto-respawn them
// ---------------------------------------------------------------------------

let lastHeartbeatCheck = Date.now();
let consecutiveMassSilence = 0;
setInterval(() => {
  const now = Date.now();
  const sinceLastCheck = now - lastHeartbeatCheck;
  lastHeartbeatCheck = now;

  // Guard 1 — self-stall: if our own interval fired far later than scheduled,
  // the launcher's event loop was frozen (host memory/CPU stall). Every
  // worker's "silence" is an artifact of that freeze, not a hung worker, and
  // their lastHeartbeat baselines haven't had a fair chance to update. Skip
  // this round and re-baseline so workers get a grace tick to check back in.
  if (tickWasStalled({ sinceLastTickMs: sinceLastCheck, intervalMs: HEARTBEAT_CHECK_MS, slackMs: HEARTBEAT_STALL_SLACK_MS })) {
    console.warn(`[Launcher] heartbeat monitor stalled for ${Math.round(sinceLastCheck / 1000)}s (expected ${Math.round(HEARTBEAT_CHECK_MS / 1000)}s) — host was likely frozen; skipping this round to let workers recover`);
    lastHostStallAt = now;
    consecutiveMassSilence = 0;
    return;
  }

  const silent: string[] = [];
  for (const inst of instances) {
    if (!workers.get(inst.name)) continue;
    // A restart is already in flight for this one — it stopped beating because
    // it's on its way out, and beginRestart() owns the escalation from here.
    // Re-requesting every tick would just log the same line forever.
    if (pendingRestarts.has(inst.name)) continue;
    const last = lastHeartbeat.get(inst.name) ?? 0;
    if (now - last > HEARTBEAT_TIMEOUT_MS) silent.push(inst.name);
  }

  if (silent.length === 0) {
    consecutiveMassSilence = 0;
    return;
  }

  // Guard 1b — stall cooldown: our own loop ran on time, but the host was
  // frozen recently enough that this silence is far more likely to be the
  // tail of that freeze than a hung bot. Restarting now would kill a live
  // session to fix a problem the worker doesn't have.
  const stalledAgo = hostStalledAgoMs();
  if (withinStallCooldown({ stalledAgoMs: stalledAgo, cooldownMs: HEARTBEAT_STALL_COOLDOWN_MS })) {
    console.warn(`[Launcher] ${silent.length} worker(s) silent (${silent.join(', ')}) but the host stalled ${Math.round(stalledAgo / 1000)}s ago — holding off restarts for another ${Math.round((HEARTBEAT_STALL_COOLDOWN_MS - stalledAgo) / 1000)}s`);
    // Ticks spent inside the cooldown aren't evidence of a hung fleet, so the
    // mass-silence tally starts over once the host is trusted again.
    consecutiveMassSilence = 0;
    return;
  }

  // Guard 2 — mass silence: more than one worker silent in the same tick is
  // almost always a host-level problem, not independent per-bot hangs.
  // Restarting them all at once loses every session and dumps respawn load
  // onto an already-struggling host. Hold off a few rounds first; only if it
  // persists do we restart, and then staggered to avoid a thundering herd.
  if (silent.length > 1) {
    consecutiveMassSilence++;
    if (consecutiveMassSilence < HEARTBEAT_MASS_SILENCE_LIMIT) {
      console.error(`[Launcher] ${silent.length} workers silent simultaneously (${silent.join(', ')}) — likely a host-level stall (load/memory); holding off ${consecutiveMassSilence}/${HEARTBEAT_MASS_SILENCE_LIMIT} before restarting`);
      return;
    }
    console.error(`[Launcher] ${silent.length} workers still silent after ${consecutiveMassSilence} checks — restarting them staggered`);
    let delay = 0;
    for (const name of silent) {
      setTimeout(() => restartWorker(name), delay);
      delay += 1000;
    }
    consecutiveMassSilence = 0;
    return;
  }

  // Single worker silent — genuinely stuck, restart just that one.
  consecutiveMassSilence = 0;
  const name = silent[0];
  const last = lastHeartbeat.get(name) ?? 0;
  console.error(`[Launcher] ${name} missed heartbeat (${Math.round((now - last) / 1000)}s silent) — force-restarting`);
  restartWorker(name);
}, HEARTBEAT_CHECK_MS).unref();

// ---------------------------------------------------------------------------
// Forward signals to all workers for graceful shutdown
// ---------------------------------------------------------------------------

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n\ud83d\udc4b Received ${signal}, stopping all instances...`);
    // Stop every respawn path: the planned one keys off pendingRestarts, the
    // crash-backoff one off this flag.
    shuttingDown = true;
    pendingRestarts.clear();
    for (const [name, worker] of workers) {
      console.log(`  Stopping ${name}...`);
      worker.postMessage({ type: 'shutdown' });
    }
    // Give workers 5 seconds to shut down gracefully
    setTimeout(() => {
      console.log('Force-terminating remaining workers...');
      for (const worker of workers.values()) {
        worker.terminate();
      }
      process.exit(0);
    }, 5000).unref();
  });
}
