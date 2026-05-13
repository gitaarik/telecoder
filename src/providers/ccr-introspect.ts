import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { config } from '../config.js';

const CCR_LOG_DIR = path.join(os.homedir(), '.claude-code-router', 'logs');

export type CcrRouteSource = 'log' | 'config';

export interface CcrRoute {
  provider: string;
  model: string;
  source: CcrRouteSource;
}

// Read this many bytes from the tail of the latest CCR log. Plenty to
// contain at least one full response chunk (largest observed ~5KB) without
// having to slurp megabytes when the log grows.
const TAIL_BYTES = 32 * 1024;

let cachedLatestLog: string | undefined;
let cachedLatestLogMtime = 0;

function findLatestLog(): string | undefined {
  if (!fs.existsSync(CCR_LOG_DIR)) return undefined;
  let best: { name: string; mtime: number } | undefined;
  for (const entry of fs.readdirSync(CCR_LOG_DIR)) {
    if (!entry.endsWith('.log')) continue;
    const full = path.join(CCR_LOG_DIR, entry);
    try {
      const stat = fs.statSync(full);
      if (!best || stat.mtimeMs > best.mtime) {
        best = { name: full, mtime: stat.mtimeMs };
      }
    } catch {
      // ignore unreadable entries
    }
  }
  return best?.name;
}

function readTail(filePath: string, bytes: number): string {
  const stat = fs.statSync(filePath);
  const size = stat.size;
  if (size === 0) return '';
  const start = Math.max(0, size - bytes);
  const length = size - start;
  const buf = Buffer.alloc(length);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, buf, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }
  return buf.toString('utf-8');
}

/**
 * Best-effort: scan the most recent CCR log for the actual provider+model
 * that served the last response. Returns undefined if no CCR log exists or
 * no usable entry is found.
 *
 * Caveat: in a multi-user/multi-client setup the most recent log entry may
 * not belong to the caller. For Claudegram's single-user case it's fine.
 */
function getLastCcrRouteFromLog(): { provider: string; model: string } | undefined {
  try {
    const latest = findLatestLog();
    if (!latest) return undefined;

    // Quick mtime check — if the file hasn't changed since last call we
    // could skip work, but we want freshness here, so always re-read tail.
    const stat = fs.statSync(latest);
    cachedLatestLog = latest;
    cachedLatestLogMtime = stat.mtimeMs;

    const tail = readTail(latest, TAIL_BYTES);
    const lines = tail.split('\n');

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line || !line.includes('"provider"')) continue;
      try {
        const obj = JSON.parse(line);
        const resp = obj?.response;
        if (resp && typeof resp.provider === 'string' && typeof resp.model === 'string') {
          return { provider: resp.provider, model: resp.model };
        }
      } catch {
        // Tail can start mid-line; skip malformed entries.
      }
    }
    return undefined;
  } catch (err) {
    console.debug('[CCR] log introspection failed:', err instanceof Error ? err.message : err);
    return undefined;
  }
}

// Cache CCR's /api/config briefly so /status / /statusline don't hammer it
// on rapid-fire calls; refresh is cheap (a few ms) but adds up.
interface CachedConfig {
  router: Record<string, string> | undefined;
  fetchedAt: number;
}
const CONFIG_TTL_MS = 60_000;
let cachedCcrConfig: CachedConfig | undefined;

async function fetchCcrConfig(): Promise<Record<string, string> | undefined> {
  if (cachedCcrConfig && Date.now() - cachedCcrConfig.fetchedAt < CONFIG_TTL_MS) {
    return cachedCcrConfig.router;
  }
  try {
    const url = `${config.CCR_BASE_URL.replace(/\/$/, '')}/api/config`;
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) {
      cachedCcrConfig = { router: undefined, fetchedAt: Date.now() };
      return undefined;
    }
    const data = (await res.json()) as { Router?: Record<string, string> };
    cachedCcrConfig = { router: data.Router, fetchedAt: Date.now() };
    return data.Router;
  } catch {
    cachedCcrConfig = { router: undefined, fetchedAt: Date.now() };
    return undefined;
  }
}

function parseRoute(spec: string | undefined): { provider: string; model: string } | undefined {
  if (!spec || !spec.includes(',')) return undefined;
  const idx = spec.indexOf(',');
  const provider = spec.substring(0, idx).trim();
  const model = spec.substring(idx + 1).trim();
  if (!provider || !model) return undefined;
  return { provider, model };
}

/**
 * Resolve which provider+model CCR routed the last response to.
 *
 * Strategy:
 *   1. Read CCR's log tail (authoritative — what *actually* served).
 *   2. Fall back to CCR's `/api/config` `Router.default` (a prediction —
 *      what would serve a typical chat turn, accurate for most cases).
 *
 * Returns undefined when neither source is available (CCR down, logs off,
 * unreachable proxy). Callers should treat undefined as "show CCR tag but
 * keep the SDK alias as the model name".
 */
export async function getCcrRoute(): Promise<CcrRoute | undefined> {
  const fromLog = getLastCcrRouteFromLog();
  if (fromLog) return { ...fromLog, source: 'log' };

  const router = await fetchCcrConfig();
  const fromConfig = parseRoute(router?.default);
  if (fromConfig) return { ...fromConfig, source: 'config' };

  return undefined;
}

/** Convenience: synchronous log-only check (no /api/config fallback). */
export function getLastCcrRoute(): { provider: string; model: string } | undefined {
  return getLastCcrRouteFromLog();
}
