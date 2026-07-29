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
import * as os from 'os';
import { fileURLToPath } from 'url';
import { stripJsonComments, expandName } from './utils/instance-config.js';

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
const envPath = process.env.CLAUDEGRAM_ENV_PATH || path.join(projectRoot, '.env');
loadEnv({ path: envPath });

const instances = loadInstancesConfig(configPath);

console.log(`\ud83d\ude80 Launching ${instances.length} bot instance(s)...`);

// Resolve the worker entry point (compiled JS or tsx for dev)
const workerEntry = existsSync(path.join(projectRoot, 'dist', 'index.js'))
  ? path.join(projectRoot, 'dist', 'index.js')
  : path.join(projectRoot, 'src', 'index.ts');

const isTsx = workerEntry.endsWith('.ts');

const workers: Map<string, Worker> = new Map();
const pendingRestarts = new Set<string>();
const lastHeartbeat = new Map<string, number>();
// Per-worker "start restarting this one" callbacks, owned by spawnWorker so the
// exit/backstop bookkeeping stays with the worker it belongs to. Every restart
// path (self, sibling, all, missed heartbeat) goes through these rather than
// calling terminate() directly.
const restarters = new Map<string, () => void>();

function restartWorker(name: string): void {
  const begin = restarters.get(name);
  if (!begin) {
    console.warn(`[Launcher] restart requested for ${name} but it has no live worker — skipping`);
    return;
  }
  begin();
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
const CLAUDEGRAM_DIR = path.join(os.homedir(), '.claudegram');

function writeReloadMarkerForToken(token: string, instanceName?: string): void {
  let botId = '';
  try {
    botId = token.split(':')[0];
    if (!botId) {
      console.warn(`[Launcher] writeReloadMarkerForToken (${instanceName ?? '?'}) called with malformed token (no colon) — skipping`);
      return;
    }
    const markerPath = path.join(CLAUDEGRAM_DIR, `pending-reload-${botId}.json`);
    mkdirSync(CLAUDEGRAM_DIR, { recursive: true });
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
  env.CLAUDEGRAM_INSTANCE_NAME = inst.name;

  // Workers use this to enumerate sibling bots (e.g. for /fork). Mirrors the
  // launcher's own --config resolution so a custom config path still works.
  env.CLAUDEGRAM_INSTANCES_CONFIG = configPath;

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

    setTimeout(() => {
      if (exited) return;
      console.error(`[Launcher] ${inst.name} still alive ${Math.round(RESTART_WEDGED_ESCALATION_MS / 1000)}s after a restart was requested — the thread is wedged in native code and terminate() cannot reach it. Exiting the launcher so the process manager restarts every instance.`);
      process.exit(1);
    }, RESTART_WEDGED_ESCALATION_MS).unref();
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
    } else if (msg?.type === 'restart_all') {
      console.log(`[Launcher] ${inst.name} requested restart of ALL instances${msg.autoResume ? ' (with auto-resume)' : ''} — ${instances.length} configured, ${workers.size} live`);
      const liveNames = new Set(workers.keys());
      const missingFromWorkers = instances.filter(i => !liveNames.has(i.name)).map(i => i.name);
      if (missingFromWorkers.length > 0) {
        console.warn(`[Launcher] restart_all: configured instances with no live worker (won't be respawned by terminate): ${missingFromWorkers.join(', ')}`);
      }
      for (const i of instances) {
        pendingRestarts.add(i.name);
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

    if (pendingRestarts.has(inst.name)) {
      // Planned restart — respawn after a short delay
      pendingRestarts.delete(inst.name);
      console.log(`[Launcher] Respawning ${inst.name} in 1s...`);
      setTimeout(() => {
        const newWorker = spawnWorker(inst);
        workers.set(inst.name, newWorker);
        console.log(`[Launcher] ✓ ${inst.name} respawned`);
      }, 1000);
    } else {
      console.warn(`[Launcher] ${inst.name} exited without a pending restart — not respawning (sessions for this bot won't be auto-resumed)`);
      workers.delete(inst.name);
      if (workers.size === 0) {
        console.log('All workers exited. Shutting down launcher.');
        process.exit(code ?? 0);
      }
    }
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
  if (sinceLastCheck > HEARTBEAT_CHECK_MS + HEARTBEAT_STALL_SLACK_MS) {
    console.warn(`[Launcher] heartbeat monitor stalled for ${Math.round(sinceLastCheck / 1000)}s (expected ${Math.round(HEARTBEAT_CHECK_MS / 1000)}s) — host was likely frozen; skipping this round to let workers recover`);
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
    // Clear pending restarts so workers don't respawn during shutdown
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
