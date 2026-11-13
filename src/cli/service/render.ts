/**
 * The service files `telecoder service install` writes, rendered from a
 * resolved spec. Pure: no fs, no environment — everything that varies by
 * machine is decided in ../commands/service.ts and handed in here, which is
 * what lets the tests pin the output line by line.
 */

import * as path from 'path';
import { EXIT_CONFIG, SERVICE_MANAGER_ENV } from '../../utils/exit-codes.js';
import { RESTART_EXIT_CODE } from '../../utils/systemd.js';

export const DEFAULT_SERVICE_NAME = 'telecoder';

/** Everything a unit or agent needs, with every path already absolute and real. */
export interface ServiceSpec {
  /** `telecoder`, or what --name gave — the unit is `<name>.service`. */
  name: string;
  /** Absolute path of the node binary. */
  nodePath: string;
  /** Absolute path of dist/cli.js. */
  cliPath: string;
  /** The config home: where the .env and instances.json are. */
  workingDirectory: string;
  /** PATH for the service; its manager's own is too bare for claude and git. */
  pathEnv: string;
  /** Other variables, in order (TELECODER_HOME and the like). Never secrets. */
  env: Array<[string, string]>;
}

export interface LaunchdSpec extends ServiceSpec {
  /** Where stdout and stderr go. */
  logFile: string;
}

// ── Names ───────────────────────────────────────────────────────

/**
 * Check a --name and strip a `.service` the user may have typed. Returns the
 * bare name, or an error message.
 */
export function normalizeServiceName(raw: string): { name: string } | { error: string } {
  const name = raw.trim().replace(/\.service$/, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) {
    return { error: `Invalid service name "${raw}": use letters, digits, ".", "_" and "-" (e.g. telecoder-work).` };
  }
  return { name };
}

export const systemdUnitName = (name: string): string => `${name}.service`;
export const launchdLabel = (name: string): string => `dev.telecoder.${name}`;

// ── PATH ────────────────────────────────────────────────────────

const DEFAULT_PATH: Record<'linux' | 'darwin', string[]> = {
  linux: ['/usr/local/bin', '/usr/bin', '/bin'],
  darwin: ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'],
};

export interface PathInputs {
  /** Directories the bot can't do without (node's, claude's, git's), first. */
  required: string[];
  /** The installing shell's PATH, so the tools Claude uses come along. */
  inherited: string | undefined;
  platform: 'linux' | 'darwin';
  /** Whether a directory is worth keeping (exists); defaults to all. */
  keep?: (dir: string) => boolean;
}

/**
 * The PATH baked into the unit: the required directories, then the installing
 * shell's PATH, then the system defaults — deduplicated, absolute entries
 * only. A project's node_modules/.bin is left out: it belongs to wherever the
 * install happened to be run from, not to the bot.
 */
export function buildServicePath({ required, inherited, platform, keep = () => true }: PathInputs): string {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (dir: string, check: boolean) => {
    const clean = dir.replace(/\/+$/, '') || '/';
    if (!path.isAbsolute(clean) || /[\n\r:]/.test(clean) || seen.has(clean)) return;
    if (clean.split('/').includes('node_modules')) return;
    if (check && !keep(clean)) return;
    seen.add(clean);
    out.push(clean);
  };
  for (const dir of required) add(dir, false);
  for (const dir of (inherited ?? '').split(':')) if (dir) add(dir, true);
  for (const dir of DEFAULT_PATH[platform]) add(dir, false);
  return out.join(':');
}

// ── systemd ─────────────────────────────────────────────────────

/** A line break in a path would end the directive and start another. */
function assertOneLine(value: string): string {
  if (/[\n\r]/.test(value)) throw new Error(`A line break in "${value}" can't go in a service file`);
  return value;
}

/** `%` starts a specifier in almost every unit setting. */
const escapeSpecifiers = (value: string): string => assertOneLine(value).replace(/%/g, '%%');

/**
 * One ExecStart= word: quoted only when it has to be, `%` escaped, and `$`
 * escaped in the arguments — systemd expands variables there but not in the
 * executable's own path (systemd-analyze verify confirms both).
 */
export function systemdExecArg(value: string, isExecutable = false): string {
  const specifiersEscaped = escapeSpecifiers(value);
  const escaped = isExecutable ? specifiersEscaped : specifiersEscaped.replace(/\$/g, '$$$$');
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(escaped)) return escaped;
  return `"${escaped.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** One `Environment=` line, always quoted. */
export function systemdEnvironment(key: string, value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
  const escaped = escapeSpecifiers(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `Environment="${key}=${escaped}"`;
}

export function renderSystemdUnit(spec: ServiceSpec): string {
  const exec = [systemdExecArg(spec.nodePath, true), systemdExecArg(spec.cliPath), 'start'].join(' ');
  return [
    '# Written by `telecoder service install`. Run it again to rewrite this file,',
    '# `telecoder service uninstall` to remove it. No secrets here: the bot reads',
    '# its token from the .env in WorkingDirectory.',
    '[Unit]',
    'Description=TeleCoder (Claude Code from Telegram)',
    'Documentation=https://telecoder.dev',
    // A bot that keeps dying within seconds stops after 20 tries in 5 minutes
    // instead of retrying forever; `telecoder service restart` resets that.
    'StartLimitIntervalSec=300',
    'StartLimitBurst=20',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${escapeSpecifiers(spec.workingDirectory)}`,
    `ExecStart=${exec}`,
    systemdEnvironment('PATH', spec.pathEnv),
    ...spec.env.map(([key, value]) => systemdEnvironment(key, value)),
    systemdEnvironment(SERVICE_MANAGER_ENV, 'systemd'),
    '# always, not on-failure: /restartbot exits for systemd to bring the bot back.',
    '# `systemctl --user stop` is still a stop — systemd never restarts a unit it',
    '# was told to stop.',
    'Restart=always',
    'RestartSec=5',
    `# ${RESTART_EXIT_CODE} is the exit /restartbot uses: logged as a clean exit, restarted all the same.`,
    `SuccessExitStatus=${RESTART_EXIT_CODE}`,
    `# ${EXIT_CONFIG} is a configuration problem (a missing setting, a rejected token):`,
    '# starting again would only print the same error. Fix it, then',
    '# `telecoder service restart`.',
    `RestartPreventExitStatus=${EXIT_CONFIG}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

// ── launchd ─────────────────────────────────────────────────────

const xml = (value: string): string =>
  assertOneLine(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * The LaunchAgent. KeepAlive restarts on any non-zero exit (so /restartbot's
 * 75 and a crash both come back) and not on a zero one — launchd has no way to
 * single out one exit code the way RestartPreventExitStatus= does, so a bot
 * stopped by its config exits 0 under launchd instead (see
 * utils/exit-codes.ts).
 */
export function renderLaunchdPlist(spec: LaunchdSpec): string {
  const env: Array<[string, string]> = [['PATH', spec.pathEnv], ...spec.env, [SERVICE_MANAGER_ENV, 'launchd']];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<!-- Written by `telecoder service install`; `telecoder service uninstall` removes it. -->',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${xml(launchdLabel(spec.name))}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...[spec.nodePath, spec.cliPath, 'start'].map((arg) => `    <string>${xml(arg)}</string>`),
    '  </array>',
    '  <key>WorkingDirectory</key>',
    `  <string>${xml(spec.workingDirectory)}</string>`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...env.flatMap(([key, value]) => [`    <key>${xml(key)}</key>`, `    <string>${xml(value)}</string>`]),
    '  </dict>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key>',
    '    <false/>',
    '  </dict>',
    '  <key>ThrottleInterval</key>',
    '  <integer>10</integer>',
    '  <key>StandardOutPath</key>',
    `  <string>${xml(spec.logFile)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xml(spec.logFile)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

// ── Diff ────────────────────────────────────────────────────────

/**
 * The lines that differ between two versions of a file, `- ` for removed and
 * `+ ` for added, in file order. A plain LCS: service files are a few dozen
 * lines.
 */
export function lineDiff(before: string, after: string): string[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push(`- ${a[i++]}`);
    } else {
      out.push(`+ ${b[j++]}`);
    }
  }
  while (i < a.length) out.push(`- ${a[i++]}`);
  while (j < b.length) out.push(`+ ${b[j++]}`);
  return out;
}
