/**
 * Does this tool call reach outside the projects the bot was shared for?
 *
 * The permission gate's pattern list answers "is this command destructive".
 * It has nothing to say about `cat ~/.ssh/id_rsa`, or an edit to a project
 * nobody was invited to, because neither is destructive — they are simply out
 * of bounds. This module answers that second question.
 *
 * It is a supervision layer, not a sandbox. Claude still runs as the bot's Unix
 * user with permissions bypassed, so anything here can be defeated by a command
 * written to avoid naming its path. The point is that the ordinary way to reach
 * out of scope — naming the path — surfaces as an approval prompt, and the
 * ordinary way to work inside scope never does.
 *
 * That balance is why the rules below are shaped the way they are. A guest's
 * session reads from `/usr`, `/etc` and the language toolchains all day; making
 * those prompt would train everyone to tap Allow without reading. So system
 * paths are readable, credential directories never are, and everything else is
 * judged against the configured roots.
 */

import * as os from 'os';
import * as path from 'path';
import { config } from '../config.js';
import { getWorkspaceRoot } from '../utils/workspace-guard.js';

export type ScopeVerdict =
  | { outOfScope: false }
  | { outOfScope: true; reason: string; offender: string };

/** Tools whose input names a path we can check directly. */
const PATH_FIELDS: Record<string, string[]> = {
  Read: ['file_path'],
  Write: ['file_path'],
  Edit: ['file_path'],
  NotebookEdit: ['notebook_path'],
  Glob: ['path'],
  Grep: ['path'],
};

/**
 * Directories whose contents are credentials, and the bot's own state. Always
 * prompt, even when they sit inside an allowed root — which they do the moment
 * someone points WORKSPACE_DIR at a home directory.
 *
 * Matched on path segments, so `~/.ssh` catches `/home/x/.ssh/id_rsa` without
 * also catching `/srv/app/ssh-helper`.
 */
const SENSITIVE_SEGMENTS = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.docker',
  '.claude',
  '.claudegram',
  '.telecoder',
  '.password-store',
  '.mozilla',
  '.thunderbird',
];

/** Credential files, matched on basename. */
const SENSITIVE_FILES = [
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  '.pgpass',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'shadow',
  'sudoers',
];

/** `~/.config/<name>` holding credentials rather than preferences. */
const SENSITIVE_CONFIG_SUBDIRS = ['gcloud', 'gh', 'op', 'doctl', 'fly', 'rclone'];

/**
 * Readable without a prompt: the operating system and the language toolchains.
 * Reading these is background noise in any real session, and a prompt for each
 * one would be a prompt nobody reads.
 */
const SYSTEM_READ_PREFIXES = [
  '/usr', '/etc', '/opt', '/bin', '/sbin', '/lib', '/lib64',
  '/proc', '/sys', '/var/log', '/var/lib', '/snap', '/nix',
  '/home/linuxbrew', '/Library', '/System', '/Applications',
];

/** Same idea, under the bot user's home. Deliberately excludes `.config`. */
const HOME_READ_SUFFIXES = [
  '.nvm', '.npm', '.cargo', '.rustup', '.pyenv', '.rbenv', '.sdkman',
  '.cache', '.local/lib', '.local/bin', '.bun', '.deno',
];

/** True when the scope guard runs at all. Follows the gate unless overridden. */
export function isScopeGuardEnabled(gateEnabled: boolean): boolean {
  if (config.SCOPE_GUARD === 'on') return true;
  if (config.SCOPE_GUARD === 'off') return false;
  return gateEnabled;
}

/**
 * The directories a session may work in without asking. `/tmp` is included
 * because every toolchain writes there and nothing durable lives there.
 */
export function getAllowedRoots(): string[] {
  const roots = [getWorkspaceRoot(), os.tmpdir(), '/tmp', ...config.SCOPE_ALLOWED_PATHS];
  return dedupe(roots.map((r) => path.resolve(r)));
}

/**
 * Inspect a tool call for paths outside the allowed roots.
 *
 * `cwd` is the session's working directory, used to resolve relative paths —
 * without it a `../../..` climb reads as harmless.
 */
export function checkToolScope(
  toolName: string,
  toolInput: Record<string, unknown>,
  cwd: string,
): ScopeVerdict {
  const roots = getAllowedRoots();

  const fields = PATH_FIELDS[toolName];
  if (fields) {
    for (const field of fields) {
      const raw = toolInput[field];
      if (typeof raw !== 'string' || !raw) continue;
      const verdict = classify(raw, cwd, roots);
      if (verdict.outOfScope) return verdict;
    }
    return { outOfScope: false };
  }

  if (toolName === 'Bash') {
    const command = typeof toolInput.command === 'string' ? toolInput.command : '';
    for (const token of extractPathTokens(command)) {
      const verdict = classify(token, cwd, roots);
      if (verdict.outOfScope) return verdict;
    }
  }

  return { outOfScope: false };
}

/** Judge one path string against the roots. Exported for tests. */
export function classify(raw: string, cwd: string, roots: string[]): ScopeVerdict {
  const resolved = resolvePath(raw, cwd);
  if (!resolved) return { outOfScope: false };

  if (isSensitive(resolved)) {
    return {
      outOfScope: true,
      reason: 'reads a credential or bot-state path',
      offender: display(resolved),
    };
  }

  if (roots.some((root) => within(root, resolved))) return { outOfScope: false };
  if (isSystemReadable(resolved)) return { outOfScope: false };

  return {
    outOfScope: true,
    reason: 'path outside the shared projects',
    offender: display(resolved),
  };
}

/**
 * Turn a raw path string into an absolute one, or undefined when it isn't a
 * path we can judge. Only strings that announce themselves as paths qualify —
 * a leading `/`, `~`, `$HOME`, `./` or `../` — which is what keeps `sed`'s
 * `s/a/b/` and a bare `npm` out of the results.
 */
export function resolvePath(raw: string, cwd: string): string | undefined {
  let value = raw.trim().replace(/^['"]+|['"]+$/g, '');
  if (!value) return undefined;

  // Home expansion runs before the glob trim, not after: `${HOME}` is braces
  // around a variable, and trimming at the first brace would leave a bare `$`.
  value = value.replace(/^\$\{HOME\}/, os.homedir()).replace(/^\$HOME\b/, os.homedir());
  if (value === '~') value = os.homedir();
  else if (value.startsWith('~/')) value = path.join(os.homedir(), value.slice(2));

  // Glob and brace metacharacters: keep the literal prefix, which is what
  // decides containment.
  const metaIdx = value.search(/[*?[\]{}]/);
  if (metaIdx === 0) return undefined;
  if (metaIdx > 0) value = value.slice(0, metaIdx);
  if (!value) return undefined;

  if (value.startsWith('/')) return path.resolve(value);
  if (value.startsWith('./') || value.startsWith('../') || value === '..') {
    return path.resolve(cwd, value);
  }
  return undefined;
}

/**
 * Pull path-looking tokens out of a shell command.
 *
 * Approximate by nature, and deliberately biased toward missing things rather
 * than inventing them: a false positive is a prompt for a command that was
 * fine, which is the cost that makes people stop reading prompts.
 */
export function extractPathTokens(command: string): string[] {
  const tokens: string[] = [];

  for (const rawToken of command.split(/[\s;|&()<>]+/)) {
    if (!rawToken) continue;

    // A URL is not a filesystem path; `//` after a scheme would resolve to one.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rawToken)) continue;

    // `--config=/path` and `-I/usr/include` carry a path after the flag.
    const candidates = [rawToken];
    const eq = rawToken.indexOf('=');
    if (eq > 0) candidates.push(rawToken.slice(eq + 1));
    if (/^-[A-Za-z]/.test(rawToken)) candidates.push(rawToken.replace(/^-+[A-Za-z]*/, ''));

    for (const candidate of candidates) {
      const stripped = candidate.replace(/^['"]+/, '');
      if (
        stripped.startsWith('/') ||
        stripped.startsWith('~') ||
        stripped.startsWith('$HOME') ||
        stripped.startsWith('${HOME}') ||
        stripped.startsWith('./') ||
        stripped.startsWith('../')
      ) {
        tokens.push(stripped);
      }
    }
  }

  return dedupe(tokens);
}

function isSensitive(resolved: string): boolean {
  const segments = resolved.split(path.sep).filter(Boolean);
  if (segments.some((s) => SENSITIVE_SEGMENTS.includes(s))) return true;

  const base = segments[segments.length - 1];
  if (base && SENSITIVE_FILES.includes(base)) return true;

  const configIdx = segments.indexOf('.config');
  if (configIdx >= 0) {
    const next = segments[configIdx + 1];
    if (next && SENSITIVE_CONFIG_SUBDIRS.includes(next)) return true;
  }

  // Any dotenv outside the allowed roots — the bot's own token file is one.
  if (base === '.env' || base?.startsWith('.env.')) return true;

  return false;
}

function isSystemReadable(resolved: string): boolean {
  if (SYSTEM_READ_PREFIXES.some((prefix) => within(prefix, resolved))) return true;

  const home = os.homedir();
  return HOME_READ_SUFFIXES.some((suffix) => within(path.join(home, suffix), resolved));
}

/**
 * Containment by path segment. Purely lexical on already-resolved paths: unlike
 * utils/workspace-guard this must judge paths that do not exist yet, which is
 * most of them at PreToolUse time.
 */
function within(root: string, target: string): boolean {
  const r = path.resolve(root);
  return target === r || target.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/** Shorten a home path for display, matching how the rest of the bot logs. */
function display(resolved: string): string {
  const home = os.homedir();
  return resolved === home || resolved.startsWith(home + path.sep)
    ? '~' + resolved.slice(home.length)
    : resolved;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
