/**
 * Which build this process is running, for the messages that follow a restart,
 * /botstatus and /version.
 *
 * Asking git at startup would answer a different question. HEAD is what's
 * checked out and the bot runs dist/, so after a commit and a plain /restartbot
 * the two differ, and the reply would name a fix that isn't live. Instead
 * `npm run build` stamps dist/ with what it compiled (scripts/stamp-build.mjs).
 *
 * The stamp is read once, on import, because it describes the code loaded then:
 * a later build replaces the file but not what this worker has in memory.
 */

import { readFileSync } from 'fs';
import { formatTimeAgo } from './format.js';

export interface BuildInfo {
  /** package.json's, the only name a build has outside a git checkout. */
  version: string;
  commit?: string;
  subject?: string;
  /** Built with uncommitted changes under src/. */
  dirty?: boolean;
  /** Of what the build compiled (scripts/source-hash.mjs). */
  sourceHash?: string;
  builtAt: string;
}

/** The stamp in `file`, or null when there's none that can be read. */
export function readBuildInfo(file: string | URL): BuildInfo | null {
  try {
    const stamp = JSON.parse(readFileSync(file, 'utf-8'));
    if (typeof stamp?.version !== 'string' || Number.isNaN(Date.parse(stamp?.builtAt))) return null;
    return stamp;
  } catch {
    return null;
  }
}

/** E.g. "63dcf45 feat: end /recap the way a turn ends (built 5m ago)". */
export function describeBuild(build: BuildInfo): string {
  const name = build.commit
    ? [build.commit, build.subject].filter(Boolean).join(' ') + (build.dirty ? ', plus uncommitted changes' : '')
    : `v${build.version}`;
  return `${name} (built ${formatTimeAgo(new Date(build.builtAt))})`;
}

// dist/utils/build-info.js finds dist/build-info.json. Run from source under
// tsx this looks in src/ and finds nothing, which is right: that code is the
// working tree, not any build.
const STAMP = new URL('../build-info.json', import.meta.url);
const runningBuild = readBuildInfo(STAMP);

/** The build this process loaded, or null when it isn't running a stamped one. */
export function getRunningBuild(): BuildInfo | null {
  return runningBuild;
}

/** The last build on disk, which this process hasn't loaded if it came after the start. */
export function getLatestBuild(): BuildInfo | null {
  return readBuildInfo(STAMP);
}

/** getRunningBuild, in words. */
export function describeRunningBuild(): string | null {
  return runningBuild && describeBuild(runningBuild);
}
