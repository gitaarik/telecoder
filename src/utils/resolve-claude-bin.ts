import { createRequire } from 'node:module';
import { config } from '../config.js';

const require = createRequire(import.meta.url);

let cachedBundled: string | null | undefined;

/**
 * Resolve the executable path TeleCoder would normally hand to the SDK.
 * Mirrors the precedence in `src/claude/agent.ts`:
 *   1. If CLAUDE_USE_BUNDLED_EXECUTABLE=false, use CLAUDE_EXECUTABLE_PATH.
 *   2. Else, prefer the matching-libc bundled binary.
 *   3. Fall back to CLAUDE_EXECUTABLE_PATH (or `claude` on PATH).
 */
export function resolveActiveClaudeExecutable(): string {
  if (!config.CLAUDE_USE_BUNDLED_EXECUTABLE) {
    return config.CLAUDE_EXECUTABLE_PATH;
  }
  return resolveBundledClaudeBin() ?? config.CLAUDE_EXECUTABLE_PATH;
}

function isMuslLibc(): boolean {
  // On glibc systems, process.report.header includes glibcVersionRuntime.
  // On musl (Alpine etc.), that field is absent.
  const header = (process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header;
  return !header?.glibcVersionRuntime;
}

/**
 * Resolve the bundled Claude Code binary for the current Linux libc.
 *
 * The SDK's own auto-detection (sdk.mjs `N7`) tries the musl package first
 * and only falls back when require.resolve throws. Both packages are
 * installed as optional deps, so it always picks musl — which fails to
 * spawn on glibc systems with a misleading "binary not found" error.
 *
 * Returns undefined on non-Linux platforms (SDK detection works correctly
 * there) or when the matching package isn't installed.
 */
export function resolveBundledClaudeBin(): string | undefined {
  if (process.platform !== 'linux') return undefined;
  if (cachedBundled !== undefined) return cachedBundled ?? undefined;

  const variant = isMuslLibc() ? `linux-${process.arch}-musl` : `linux-${process.arch}`;
  const pkg = `@anthropic-ai/claude-agent-sdk-${variant}/claude`;
  try {
    cachedBundled = require.resolve(pkg);
    return cachedBundled;
  } catch {
    cachedBundled = null;
    return undefined;
  }
}

/**
 * The executable a given transport actually runs, so anything that inspects
 * the CLI (its command list, its version) inspects the same build the user's
 * turns go through. The two can be different installs at different versions:
 * SDK mode prefers the binary bundled in node_modules, PTY mode spawns
 * CLAUDE_BIN — the same precedence `/context` already follows.
 */
export function resolveClaudeExecutableForMethod(method: 'sdk' | 'pty'): string {
  return method === 'pty'
    ? process.env.CLAUDE_BIN || config.CLAUDE_EXECUTABLE_PATH
    : resolveActiveClaudeExecutable();
}
