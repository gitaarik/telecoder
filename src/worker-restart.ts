/**
 * Restart requests from a worker to the launcher.
 *
 * Split out of index.ts so callers don't have to import the process entry
 * point to reach three message-posting helpers. The command handlers used to
 * do exactly that, via `await import('../../../index.js')` — a dynamic import
 * purely to dodge the cycle a static one would create. This module imports
 * nothing but `worker_threads`, so they can import it directly.
 *
 * Every function is a no-op returning false/failure in single-instance mode,
 * where there is no launcher to talk to.
 */

import { isMainThread, parentPort } from 'worker_threads';

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
