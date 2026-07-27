import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { config } from '../config.js';

const CCR_PID_PATH = path.join(os.homedir(), '.claude-code-router', '.claude-code-router.pid');

const PROBE_TIMEOUT_MS = 1500;
const START_POLL_INTERVAL_MS = 250;
const START_TIMEOUT_MS = 8000;

export type EnsureResult =
  | { status: 'ok' }
  | { status: 'not_running'; message: string }
  | { status: 'started' }
  | { status: 'start_failed'; message: string };

export async function isCcrRunning(timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  try {
    const url = `${config.CCR_BASE_URL.replace(/\/$/, '')}/api/config`;
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function clearStalePidfile(): void {
  try {
    if (!fs.existsSync(CCR_PID_PATH)) return;
    const raw = fs.readFileSync(CCR_PID_PATH, 'utf-8').trim();
    const pid = parseInt(raw, 10);
    if (!Number.isFinite(pid) || !isPidAlive(pid)) {
      fs.unlinkSync(CCR_PID_PATH);
      console.log(`[CCR] Removed stale pidfile (pid ${raw} not running)`);
    }
  } catch (err) {
    console.warn('[CCR] Failed to inspect pidfile:', err instanceof Error ? err.message : err);
  }
}

async function waitUntilUp(deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    if (await isCcrRunning(800)) return true;
    await new Promise((resolve) => setTimeout(resolve, START_POLL_INTERVAL_MS));
  }
  return false;
}

async function startCcrProcess(): Promise<{ ok: true } | { ok: false; message: string }> {
  clearStalePidfile();

  return new Promise((resolve) => {
    let resolved = false;
    const finish = (result: { ok: true } | { ok: false; message: string }) => {
      if (!resolved) {
        resolved = true;
        resolve(result);
      }
    };

    try {
      const child = spawn(config.CCR_BINARY, ['start'], {
        detached: true,
        stdio: 'ignore',
      });
      child.on('error', (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        finish({ ok: false, message: `failed to spawn \`${config.CCR_BINARY} start\`: ${msg}` });
      });
      child.unref();
      // Give spawn a brief moment to surface ENOENT before declaring success.
      setTimeout(() => finish({ ok: true }), 100);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      finish({ ok: false, message: `failed to spawn \`${config.CCR_BINARY} start\`: ${msg}` });
    }
  });
}

/**
 * Preflight check used by the CCR provider before each query.
 *
 * Strategy:
 *   - Probe the proxy. If up, return `ok` immediately.
 *   - If down and autostart is disabled, return `not_running` with a
 *     user-facing message telling them how to start CCR.
 *   - If down and autostart is enabled, attempt `ccr start`, poll until the
 *     proxy responds, and return `started` on success or `start_failed`
 *     with the underlying reason otherwise.
 */
export async function ensureCcrRunning(): Promise<EnsureResult> {
  if (await isCcrRunning()) return { status: 'ok' };

  if (!config.CCR_AUTOSTART) {
    return {
      status: 'not_running',
      message: `CCR proxy isn't reachable at ${config.CCR_BASE_URL}. Start it with \`ccr start\`, or set \`CCR_AUTOSTART=true\` to let TeleCoder start it on demand.`,
    };
  }

  console.log('[CCR] Proxy unreachable — attempting autostart');
  const spawnResult = await startCcrProcess();
  if (!spawnResult.ok) {
    return {
      status: 'start_failed',
      message: `CCR autostart failed: ${spawnResult.message}. Start it manually with \`ccr start\`.`,
    };
  }

  const up = await waitUntilUp(Date.now() + START_TIMEOUT_MS);
  if (up) {
    console.log('[CCR] Proxy is up after autostart');
    return { status: 'started' };
  }
  return {
    status: 'start_failed',
    message: `CCR autostart launched but the proxy didn't come up within ${Math.round(START_TIMEOUT_MS / 1000)}s. Check \`ccr status\` and \`~/.claude-code-router/logs/\`.`,
  };
}
