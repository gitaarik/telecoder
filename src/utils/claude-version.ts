import { execFile } from 'node:child_process';

/**
 * Cached `claude --version` probe.
 *
 * Used to decide which `--model` aliases are safe to offer. An alias the CLI
 * doesn't recognise isn't rejected at spawn — it's forwarded to the API as a
 * literal model name and fails at request time, mid-turn. Probing lets /model
 * hide aliases the installed binary predates instead of handing the user a
 * choice that breaks their next message.
 */

export interface ClaudeVersion {
  major: number;
  minor: number;
  patch: number;
  raw: string;
}

/** `claude --version` prints e.g. "2.1.226 (Claude Code)". */
export function parseClaudeVersion(output: string): ClaudeVersion | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    raw: match[0],
  };
}

/** True when `version` is at or above `[major, minor, patch]`. */
export function isAtLeast(
  version: ClaudeVersion | undefined,
  [major, minor, patch]: readonly [number, number, number],
): boolean {
  if (!version) return false;
  if (version.major !== major) return version.major > major;
  if (version.minor !== minor) return version.minor > minor;
  return version.patch >= patch;
}

// Keyed by binary path — PTY mode spawns CLAUDE_BIN while SDK mode usually
// spawns the SDK's bundled binary, and the two are often different releases.
const cache = new Map<string, Promise<ClaudeVersion | undefined>>();

export async function getClaudeVersion(bin: string): Promise<ClaudeVersion | undefined> {
  const cached = cache.get(bin);
  if (cached) return cached;

  const probe = new Promise<ClaudeVersion | undefined>((resolve) => {
    execFile(bin, ['--version'], { timeout: 10_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error) {
        console.debug('[ClaudeVersion] probe failed:', error.message);
        resolve(undefined);
        return;
      }
      resolve(parseClaudeVersion(stdout));
    });
  });

  cache.set(bin, probe);
  return probe;
}

/** Test seam — drops memoised probes so a fresh binary is re-read. */
export function clearClaudeVersionCache(): void {
  cache.clear();
}
