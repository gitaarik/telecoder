import { createRequire } from 'node:module';
import { config } from '../config.js';
import { resolveBin } from './resolve-bin.js';

const require = createRequire(import.meta.url);

let cachedBundled: string | null | undefined;

function isMuslLibc(): boolean {
  // On glibc systems, process.report.header includes glibcVersionRuntime.
  // On musl (Alpine etc.), that field is absent.
  const header = (process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header;
  return !header?.glibcVersionRuntime;
}

/**
 * Resolve the bundled Claude Code binary for the current Linux libc: the
 * `claude` the Haiku side calls run through (side-call-options.ts). The ptys
 * spawn resolvePtyClaudeBin below instead.
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
 * The `claude` the ptys run: CLAUDE_BIN, else the CLI found on PATH with
 * ~/.local/bin searched first (see resolve-bin.ts). A path, not a bare name:
 * node-pty execs the name as given, in the service's PATH, and a systemd user
 * unit gets the bare default without ~/.local/bin, which is where the native
 * installer puts the CLI. That failure is silent in the worst way: execvp
 * writes "No such file or directory" into the pty and exits, so the bot sees a
 * session that produced nothing and reports that the input box never appeared.
 */
export function resolvePtyClaudeBin(): string {
  return process.env.CLAUDE_BIN || resolveBin('claude');
}
