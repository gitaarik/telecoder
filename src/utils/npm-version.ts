/**
 * The npm side of /version and /update, for a package install (see
 * utils/install-mode.ts). A checkout asks git instead (utils/version-check.ts).
 *
 * `npm view` goes to the registry, so its answer is cached in the state
 * directory and only asked for on demand — never on the way up.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getStateDir } from './json-store.js';
import { atomicWriteFileSync } from './atomic-write.js';
import type { PackageRunner } from './install-mode.js';

export const PACKAGE_NAME = 'telecoder';
const VIEW_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_FILE = 'npm-latest.json';

export type NpmCheck =
  | { kind: 'unknown'; installed: string | null }
  | { kind: 'current'; installed: string; latest: string }
  | { kind: 'behind'; installed: string; latest: string }
  /** A prerelease or a local build ahead of what's published. */
  | { kind: 'ahead'; installed: string; latest: string };

/** -1, 0 or 1, comparing the numeric x.y.z parts; a prerelease sorts below its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.trim().replace(/^v/, '').split('-', 2);
    return { nums: core.split('.').map((n) => parseInt(n, 10) || 0), pre: pre ?? null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** What `npm view telecoder version` answers, or null when it can't be asked. */
export function fetchLatestVersion(timeout = VIEW_TIMEOUT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('npm', ['view', PACKAGE_NAME, 'version'], { timeout }, (error, stdout) => {
      if (error) {
        console.debug(`[Version] npm view failed (${error.code ?? error.signal})`);
        resolve(null);
        return;
      }
      const version = stdout.trim().split('\n').pop()?.trim() ?? '';
      resolve(/^\d+\.\d+\.\d+/.test(version) ? version : null);
    });
  });
}

interface CacheEntry {
  version: string;
  checkedAt: number;
}

function cachePath(): string {
  return path.join(getStateDir(), CACHE_FILE);
}

function readCache(now: number): string | null {
  try {
    const entry = JSON.parse(fs.readFileSync(cachePath(), 'utf-8')) as CacheEntry;
    if (typeof entry.version !== 'string' || typeof entry.checkedAt !== 'number') return null;
    return now - entry.checkedAt < CACHE_TTL_MS ? entry.version : null;
  } catch {
    return null;
  }
}

function writeCache(version: string, now: number): void {
  try {
    fs.mkdirSync(path.dirname(cachePath()), { recursive: true, mode: 0o700 });
    atomicWriteFileSync(cachePath(), JSON.stringify({ version, checkedAt: now }), { mode: 0o600 });
  } catch {
    // A cache that can't be written only costs the next caller a registry call.
  }
}

/** The latest published version, from the cache when it's fresh. */
export async function getLatestVersion(
  { fresh = false, fetch = fetchLatestVersion, now = Date.now() }:
  { fresh?: boolean; fetch?: () => Promise<string | null>; now?: number } = {},
): Promise<string | null> {
  if (!fresh) {
    const cached = readCache(now);
    if (cached) return cached;
  }
  const latest = await fetch();
  if (latest) writeCache(latest, now);
  return latest;
}

export function compareInstalled(installed: string | null, latest: string | null): NpmCheck {
  if (!installed || !latest) return { kind: 'unknown', installed };
  const order = compareVersions(installed, latest);
  if (order === 0) return { kind: 'current', installed, latest };
  return order < 0 ? { kind: 'behind', installed, latest } : { kind: 'ahead', installed, latest };
}

/** The command that updates this install, as a person would type it. */
export function updateCommand(runner: PackageRunner): string {
  switch (runner) {
    case 'global':
      return `npm install -g ${PACKAGE_NAME}@latest`;
    case 'npx':
      return `npx ${PACKAGE_NAME}@latest start`;
    case 'local':
      return `npm install ${PACKAGE_NAME}@latest`;
  }
}

export function describeNpmCheck(check: NpmCheck, runner: PackageRunner): string {
  switch (check.kind) {
    case 'unknown':
      return check.installed
        ? `❓ Couldn't ask npm for the latest version, so v${check.installed} may or may not be current.`
        : "❓ Couldn't tell which version this is.";
    case 'current':
      return `✅ v${check.installed} is the latest release.`;
    case 'ahead':
      return `⬆️ v${check.installed} is newer than the latest release (v${check.latest}).`;
    case 'behind':
      return runner === 'global'
        ? `⚠️ v${check.latest} is out (this is v${check.installed}). /update installs it.`
        : `⚠️ v${check.latest} is out (this is v${check.installed}). Update with: ${updateCommand(runner)}`;
  }
}

/** Run `npm install -g telecoder@latest`. Resolves with npm's output, rejects with its error. */
export function installLatestGlobally(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'npm',
      ['install', '-g', `${PACKAGE_NAME}@latest`],
      { timeout: 300_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error((stderr || error.message || 'npm install failed').trim()));
          return;
        }
        resolve((stdout || stderr || '').trim());
      },
    );
  });
}
