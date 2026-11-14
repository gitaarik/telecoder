/**
 * `telecoder service install|uninstall|status|logs|restart` — run TeleCoder
 * in the background under the machine's own service manager: a systemd user
 * unit on Linux, a LaunchAgent on macOS.
 *
 * An npm install has no botctl script: /restartbot exits (RESTART_EXIT_CODE)
 * and counts on whatever started the bot to start it again. The unit written
 * here does — Restart=always, KeepAlive — and stands down on the config-error
 * code instead (see ../service/render.ts and utils/exit-codes.ts).
 *
 * Everything that touches the machine — files, systemctl, the prompt — comes
 * in through ServiceDeps, so the flows are tested with fakes; the unit text
 * itself is rendered by the pure functions in ../service/render.ts.
 */

import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import type { CliIo, CommandResult } from '../dispatch.js';
import { getConfigHomeInfo, type ConfigHome } from '../../utils/config-home.js';
import {
  detectPackageRunner,
  getInstallMode,
  PACKAGE_ROOT,
  type InstallMode,
  type PackageRunner,
} from '../../utils/install-mode.js';
import {
  buildServicePath,
  DEFAULT_SERVICE_NAME,
  launchdLabel,
  lineDiff,
  normalizeServiceName,
  renderLaunchdPlist,
  renderSystemdUnit,
  systemdUnitName,
  type ServiceSpec,
} from '../service/render.js';

// ── Dependencies ────────────────────────────────────────────────

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ServiceFs {
  exists(p: string): boolean;
  readFile(p: string): string;
  writeFile(p: string, content: string): void;
  mkdirp(p: string): void;
  remove(p: string): void;
  /** The real path, or the path itself when it can't be resolved. */
  realpath(p: string): string;
  isExecutable(p: string): boolean;
}

export interface ServiceDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homedir: string;
  uid: number;
  username: string;
  /** process.execPath: the node running us. */
  execPath: string;
  packageRoot: string;
  installMode: InstallMode;
  packageRunner: PackageRunner;
  configHome: ConfigHome;
  fs: ServiceFs;
  /** Run a command and capture its output. Never through a shell. env: the whole environment, else ours. */
  run(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<RunResult>;
  /** Run a command attached to this terminal (status, logs); resolves with its exit code. */
  runInherit(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<number>;
  /** A yes/no question; null when there is no one to ask (not a terminal). */
  ask(question: string, defaultYes: boolean): Promise<boolean | null>;
}

export function realDeps(): ServiceDeps {
  return {
    platform: process.platform,
    env: process.env,
    homedir: os.homedir(),
    uid: process.getuid?.() ?? -1,
    username: os.userInfo().username,
    execPath: process.execPath,
    packageRoot: PACKAGE_ROOT,
    installMode: getInstallMode(),
    packageRunner: detectPackageRunner(),
    configHome: getConfigHomeInfo(),
    fs: {
      exists: (p) => fs.existsSync(p),
      readFile: (p) => fs.readFileSync(p, 'utf8'),
      writeFile: (p, content) => fs.writeFileSync(p, content, { mode: 0o644 }),
      mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
      remove: (p) => fs.rmSync(p, { force: true }),
      realpath: (p) => {
        try {
          return fs.realpathSync(p);
        } catch {
          return p;
        }
      },
      isExecutable: (p) => {
        try {
          const stat = fs.statSync(p);
          return stat.isFile() && (stat.mode & 0o111) !== 0;
        } catch {
          return false;
        }
      },
    },
    run: (cmd, args, env) =>
      new Promise((resolve) => {
        execFile(cmd, args, { timeout: 60_000, env }, (error, stdout, stderr) => {
          const code = error ? (typeof error.code === 'number' ? error.code : 127) : 0;
          resolve({ code, stdout: String(stdout), stderr: String(stderr) || (error && !stderr ? error.message : '') });
        });
      }),
    runInherit: (cmd, args, env) =>
      new Promise((resolve) => {
        const child = spawn(cmd, args, { stdio: 'inherit', env });
        child.on('error', () => resolve(127));
        child.on('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 0 : 1)));
      }),
    ask: async (question, defaultYes) => {
      if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await new Promise<string>((resolve) => rl.question(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'} `, resolve));
        const a = answer.trim().toLowerCase();
        return a === '' ? defaultYes : a === 'y' || a === 'yes';
      } finally {
        rl.close();
      }
    },
  };
}

// ── Options ─────────────────────────────────────────────────────

export interface ServiceOptions {
  name: string;
  /** Answer yes to every question (replace a changed unit, enable linger). */
  yes: boolean;
  /** false: --no-linger. undefined: ask. */
  linger?: boolean;
  /** Install from a git checkout's dist/ anyway. */
  fromCheckout: boolean;
  /** Print what would be written and do nothing. */
  dryRun: boolean;
  /** logs: follow (the default) or print the last lines and stop. */
  follow: boolean;
}

export type ServiceInstallOptions = Partial<ServiceOptions> & { io: CliIo };

const SUBCOMMANDS = ['install', 'uninstall', 'status', 'logs', 'restart'] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

export function parseServiceArgs(
  args: string[],
): { sub: Subcommand | null; options: ServiceOptions } | { error: string } {
  const options: ServiceOptions = { name: DEFAULT_SERVICE_NAME, yes: false, fromCheckout: false, dryRun: false, follow: true };
  let sub: Subcommand | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--name' || arg.startsWith('--name=')) {
      const value = arg === '--name' ? args[++i] : arg.slice('--name='.length);
      if (!value) return { error: '--name needs a value, e.g. --name telecoder-work' };
      const normalized = normalizeServiceName(value);
      if ('error' in normalized) return normalized;
      options.name = normalized.name;
    } else if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--no-linger') options.linger = false;
    else if (arg === '--from-checkout') options.fromCheckout = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--no-follow') options.follow = false;
    else if (!sub && (SUBCOMMANDS as readonly string[]).includes(arg)) sub = arg as Subcommand;
    else return { error: `Unknown service argument: ${arg}` };
  }
  return { sub, options };
}

export function usage(): string[] {
  return [
    'Usage: telecoder service <command> [--name <name>]',
    '',
    '  install     Run TeleCoder in the background, and start it at login/boot',
    '              (systemd user unit on Linux, LaunchAgent on macOS)',
    '              [--yes] [--no-linger] [--dry-run] [--from-checkout]',
    '  status      Is it running?',
    '  logs        Follow its output [--no-follow: print the last 100 lines]',
    '  restart     Restart it (also after a config error stopped it)',
    '  uninstall   Stop it and remove the service',
    '',
    '--name picks the unit name (default "telecoder"), for several installs side by side.',
  ];
}

// ── Locating things ─────────────────────────────────────────────

/** Where a command is on PATH (the PATH entry, not where its symlink leads), or null. */
export function findOnPath(name: string, pathVar: string | undefined, isExecutable: (p: string) => boolean): string | null {
  for (const dir of (pathVar ?? '').split(':')) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function extraSearchPath(deps: ServiceDeps): string {
  const dirs = [path.join(deps.homedir, '.local', 'bin'), '/usr/local/bin', '/usr/bin', '/bin'];
  if (deps.platform === 'darwin') dirs.unshift('/opt/homebrew/bin');
  return [deps.env.PATH ?? '', ...dirs].join(':');
}

const which = (deps: ServiceDeps, name: string) => findOnPath(name, extraSearchPath(deps), deps.fs.isExecutable);

/**
 * The node to put in the unit. process.execPath is already resolved, which
 * for Homebrew is a versioned Cellar path that the next `brew upgrade`
 * deletes; the `node` on PATH that leads to the same binary is the stable
 * name for it.
 */
export function chooseNodePath(deps: ServiceDeps): string {
  const onPath = which(deps, 'node');
  if (onPath && deps.fs.realpath(onPath) === deps.fs.realpath(deps.execPath)) return onPath;
  return deps.execPath;
}

/** The env vars carried into the unit: where the config is, never what's in it. */
function carriedEnv(deps: ServiceDeps): Array<[string, string]> {
  const env: Array<[string, string]> = [];
  if (deps.configHome.source === 'override') env.push(['TELECODER_HOME', deps.configHome.dir]);
  for (const suffix of ['ENV_PATH', 'INSTANCES_CONFIG']) {
    const value = deps.env[`TELECODER_${suffix}`] ?? deps.env[`CLAUDEGRAM_${suffix}`];
    if (value?.trim()) env.push([`TELECODER_${suffix}`, path.resolve(value.trim())]);
  }
  return env;
}

export type Resolved =
  | { ok: true; spec: ServiceSpec; warnings: string[]; notes: string[] }
  | { ok: false; lines: string[] };

/** Work out everything the unit needs, or why there can't be one. */
export function resolveServiceSpec(deps: ServiceDeps, options: Pick<ServiceOptions, 'name' | 'fromCheckout'>): Resolved {
  if (deps.installMode === 'checkout' && !options.fromCheckout) {
    return {
      ok: false,
      lines: [
        `This is a source checkout (${deps.packageRoot}).`,
        'A checkout is usually run with pm2 through scripts/telecoder-botctl.sh, or with',
        '"npm start" — /restartbot and /rebuildbot already know how to work with those.',
        '',
        "To run it as a service instead, pointing at this checkout's dist/:",
        '  node dist/cli.js service install --from-checkout',
        'Run it under one or the other, not both: two copies of one bot conflict.',
      ],
    };
  }
  if (deps.installMode === 'package' && deps.packageRunner === 'npx') {
    return {
      ok: false,
      lines: [
        "TeleCoder is running through npx, from npm's cache — a path that can be cleared",
        'at any time, which would leave the service pointing at nothing.',
        '',
        'Install it first, then install the service from that:',
        '  npm install -g telecoder',
        '  telecoder service install',
      ],
    };
  }

  const cliPath = deps.fs.realpath(path.join(deps.packageRoot, 'dist', 'cli.js'));
  if (!deps.fs.exists(cliPath)) {
    return {
      ok: false,
      lines: deps.installMode === 'checkout'
        ? [`${cliPath} doesn't exist yet. Build the checkout first: npm run build`]
        : [`${cliPath} is missing — the install looks broken. Reinstall: npm install -g telecoder`],
    };
  }

  const home = deps.configHome.dir;
  const hasConfig = ['.env', 'instances.json'].some((f) => deps.fs.exists(path.join(home, f)))
    || Boolean(deps.env.TELECODER_ENV_PATH || deps.env.CLAUDEGRAM_ENV_PATH);
  if (!hasConfig) {
    return {
      ok: false,
      lines: [
        `No TeleCoder config in ${home} yet, so the service would only fail to start.`,
        'Run "telecoder init" first (or create the .env there), then "telecoder doctor".',
      ],
    };
  }

  const warnings: string[] = [];
  const nodePath = chooseNodePath(deps);
  const required = [path.dirname(nodePath)];
  for (const tool of ['claude', 'git', 'ffmpeg']) {
    const found = which(deps, tool);
    if (found) required.push(path.dirname(found));
    else if (tool === 'claude') warnings.push('The claude CLI is not on your PATH. The bot needs it: install Claude Code, then run this again so the service can find it.');
    else if (tool === 'git') warnings.push('git is not on your PATH; Claude will be without it.');
  }
  if (deps.installMode === 'package' && deps.packageRunner === 'local') {
    warnings.push(`TeleCoder is installed in a project's node_modules (${deps.packageRoot}); the service runs it from there.`);
  }

  const platform = deps.platform === 'darwin' ? 'darwin' : 'linux';
  const env = carriedEnv(deps);
  return {
    ok: true,
    warnings,
    notes: env.map(([key, value]) => `The service gets ${key}=${value}, from your environment.`),
    spec: {
      name: options.name,
      nodePath,
      cliPath,
      workingDirectory: home,
      pathEnv: buildServicePath({ required, inherited: deps.env.PATH, platform, keep: (d) => deps.fs.exists(d) }),
      env,
    },
  };
}

// ── systemd ─────────────────────────────────────────────────────

export function systemdUnitPath(deps: ServiceDeps, name: string): string {
  const configHome = deps.env.XDG_CONFIG_HOME && path.isAbsolute(deps.env.XDG_CONFIG_HOME)
    ? deps.env.XDG_CONFIG_HOME
    : path.join(deps.homedir, '.config');
  return path.join(configHome, 'systemd', 'user', systemdUnitName(name));
}

const userRuntimeDir = (uid: number) => `/run/user/${uid}`;

/**
 * Under `sudo -u` or `su` there is no XDG_RUNTIME_DIR, so systemctl --user
 * can't find the user's manager even when it is running (a login elsewhere,
 * or lingering). When its bus socket is there, point systemctl at it: the
 * returned deps run every command with XDG_RUNTIME_DIR and
 * DBUS_SESSION_BUS_ADDRESS set. `adopted` is the directory, when it did.
 */
export function withUserBus(deps: ServiceDeps): { deps: ServiceDeps; adopted: string | null } {
  if (deps.platform !== 'linux' || deps.env.XDG_RUNTIME_DIR || deps.uid < 0) return { deps, adopted: null };
  const runtimeDir = userRuntimeDir(deps.uid);
  const bus = `${runtimeDir}/bus`;
  if (!deps.fs.exists(bus)) return { deps, adopted: null };
  // A DBUS_SESSION_BUS_ADDRESS that came through sudo is the other user's.
  const env = { ...deps.env, XDG_RUNTIME_DIR: runtimeDir, DBUS_SESSION_BUS_ADDRESS: `unix:path=${bus}` };
  return {
    adopted: runtimeDir,
    deps: {
      ...deps,
      env,
      run: (cmd, args, e) => deps.run(cmd, args, e ?? env),
      runInherit: (cmd, args, e) => deps.runInherit(cmd, args, e ?? env),
    },
  };
}

export interface SystemdUnavailable {
  reason: string;
  /** The user's systemd manager isn't running or reachable: lingering is the usual fix. */
  userManager: boolean;
}

/** Why `systemctl --user` can't be used here, or null when it can. */
export async function systemdUnavailableReason(deps: ServiceDeps): Promise<SystemdUnavailable | null> {
  if (!which(deps, 'systemctl')) return { reason: 'systemctl is not installed', userManager: false };
  if (!deps.fs.exists('/run/systemd/system')) {
    return { reason: 'this system was not booted with systemd (a container, or WSL without systemd enabled)', userManager: false };
  }
  if (!deps.env.XDG_RUNTIME_DIR) {
    return {
      reason: `there is no user session here (XDG_RUNTIME_DIR is unset, and no systemd user manager is running for ${deps.username})`,
      userManager: true,
    };
  }
  const probe = await deps.run('systemctl', ['--user', 'show-environment']);
  if (probe.code !== 0) {
    return {
      reason: `the systemd user manager isn't reachable (${firstLine(probe.stderr) || `systemctl exited ${probe.code}`})`,
      userManager: true,
    };
  }
  return null;
}

const firstLine = (text: string) => text.trim().split('\n')[0] ?? '';

/** How to get the user's systemd manager running without a login, first in the fallback. */
async function userManagerFix(deps: ServiceDeps, name: string): Promise<string[]> {
  const user = deps.username;
  const runtimeDir = userRuntimeDir(deps.uid);
  const viaSudo = !deps.env.XDG_RUNTIME_DIR || Boolean(deps.env.SUDO_USER);
  const sudoLines = viaSudo
    ? [
      `Under sudo -u, "telecoder service" finds that manager at ${runtimeDir} by itself; other`,
      `systemctl --user commands need XDG_RUNTIME_DIR=${runtimeDir} in front, e.g.`,
      `  sudo -u ${user} XDG_RUNTIME_DIR=${runtimeDir} systemctl --user status ${systemdUnitName(name)}`,
    ]
    : [];
  if (await lingerEnabled(deps)) {
    return [
      `Lingering is already on for ${user}, so its systemd user manager should be running.`,
      `Check it with "systemctl status user@${deps.uid}.service", then run "telecoder service install" again.`,
      ...sudoLines,
    ];
  }
  return [
    `To fix it, turn on lingering: it keeps ${user}'s systemd running without a login (and starts it at boot).`,
    `  sudo loginctl enable-linger ${user}`,
    'then run "telecoder service install" again.',
    ...sudoLines,
  ];
}

async function systemdFallback(
  deps: ServiceDeps, io: CliIo, unavailable: SystemdUnavailable, unitPath: string, unit: string, spec: ServiceSpec,
): Promise<void> {
  io.err(`Can't install a systemd user service: ${unavailable.reason}.`);
  io.err('');
  if (unavailable.userManager) {
    for (const line of await userManagerFix(deps, spec.name)) io.err(line);
    io.err('');
  }
  io.err('Or other ways to keep it running:');
  io.err(`  - pm2:   pm2 start ${spec.cliPath} --name ${spec.name} --interpreter ${spec.nodePath} -- start`);
  io.err('           then "pm2 save" and "pm2 startup" to bring it back after a reboot');
  io.err('  - tmux or screen: run "telecoder start" in a detached session (no restart from chat)');
  io.err(`  - by hand, where systemd --user works: save this as ${unitPath}, then`);
  io.err(`    systemctl --user daemon-reload && systemctl --user enable --now ${systemdUnitName(spec.name)}`);
  io.err('');
  for (const line of unit.trimEnd().split('\n')) io.err(`    ${line}`);
}

async function lingerEnabled(deps: ServiceDeps): Promise<boolean> {
  const result = await deps.run('loginctl', ['show-user', deps.username, '--property=Linger', '--value']);
  return result.code === 0 && result.stdout.trim() === 'yes';
}

type Existing = 'none' | 'same' | 'replaced';

/**
 * Compare with what is already there; show the difference and ask before
 * replacing. Returns null when the answer is no.
 */
async function checkExisting(
  deps: ServiceDeps,
  io: CliIo,
  file: string,
  content: string,
  yes: boolean,
): Promise<Existing | null> {
  if (!deps.fs.exists(file)) return 'none';
  const current = deps.fs.readFile(file);
  if (current === content) return 'same';
  io.out(`${file} already exists and differs:`);
  for (const line of lineDiff(current, content)) io.out(`  ${line}`);
  io.out('');
  const answer = yes ? true : await deps.ask('Replace it?', false);
  if (answer === null) {
    io.err('Not replacing it without asking. Run again in a terminal, or with --yes to replace it.');
    return null;
  }
  if (!answer) {
    io.out('Left it as it is.');
    return null;
  }
  return 'replaced';
}

async function step(deps: ServiceDeps, io: CliIo, cmd: string, args: string[]): Promise<boolean> {
  const result = await deps.run(cmd, args);
  if (result.code === 0) return true;
  io.err(`"${[cmd, ...args].join(' ')}" failed (exit ${result.code}): ${firstLine(result.stderr) || 'no output'}`);
  return false;
}

const TWO_COPIES_NOTE =
  'If this bot is also running somewhere else (a terminal, pm2), stop that copy: two copies of one bot token fight over its messages.';

async function installSystemd(deps: ServiceDeps, io: CliIo, spec: ServiceSpec, options: ServiceOptions): Promise<number> {
  const unitPath = systemdUnitPath(deps, spec.name);
  const unitName = systemdUnitName(spec.name);
  const unit = renderSystemdUnit(spec);

  if (options.dryRun) {
    io.out(`Would write ${unitPath}:`);
    io.out('');
    for (const line of unit.trimEnd().split('\n')) io.out(line);
    return 0;
  }

  const unavailable = await systemdUnavailableReason(deps);
  if (unavailable) {
    await systemdFallback(deps, io, unavailable, unitPath, unit, spec);
    return 1;
  }

  const existing = await checkExisting(deps, io, unitPath, unit, options.yes);
  if (existing === null) return 1;

  // Ask everything before changing anything.
  let enableLinger = false;
  const lingering = await lingerEnabled(deps);
  if (!lingering && options.linger !== false) {
    io.out('Lingering lets your user services run while you are logged out, and start at boot.');
    const answer = options.yes ? true : await deps.ask(`Enable it for ${deps.username} (loginctl enable-linger)?`, true);
    if (answer === null) io.out('Not enabling lingering without asking (--yes would). Until it is on, the bot stops when you log out.');
    enableLinger = answer === true;
  }

  if (existing !== 'same') {
    deps.fs.mkdirp(path.dirname(unitPath));
    deps.fs.writeFile(unitPath, unit);
    io.out(`${existing === 'replaced' ? 'Updated' : 'Wrote'} ${unitPath}`);
  } else {
    io.out(`${unitPath} is already up to date.`);
  }

  if (!(await step(deps, io, 'systemctl', ['--user', 'daemon-reload']))) return 1;
  if (!(await step(deps, io, 'systemctl', ['--user', 'enable', '--now', unitName]))) {
    io.err(`See why with: telecoder service logs${nameFlag(spec.name)} --no-follow`);
    return 1;
  }
  // enable --now leaves a running bot alone; a changed unit needs a restart to apply.
  if (existing === 'replaced') {
    io.out('Restarting it to apply the change...');
    if (!(await step(deps, io, 'systemctl', ['--user', 'restart', unitName]))) return 1;
  }
  io.out(`${unitName} is enabled and running.`);

  if (enableLinger) {
    if (await step(deps, io, 'loginctl', ['enable-linger', deps.username])) {
      io.out(`Lingering is on for ${deps.username}: the bot keeps running after logout and starts at boot.`);
    } else {
      io.err(`Enable it as root instead: sudo loginctl enable-linger ${deps.username}`);
    }
  } else if (lingering) {
    io.out(`Lingering is already on for ${deps.username}: the bot starts at boot.`);
  } else {
    io.out(`Lingering is off: the bot runs while you are logged in. "loginctl enable-linger ${deps.username}" changes that.`);
  }

  printNextSteps(io, spec.name);
  return 0;
}

const nameFlag = (name: string) => (name === DEFAULT_SERVICE_NAME ? '' : ` --name ${name}`);

function printNextSteps(io: CliIo, name: string): void {
  const flag = nameFlag(name);
  io.out('');
  io.out(TWO_COPIES_NOTE);
  io.out('');
  io.out(`  telecoder service status${flag}     is it running?`);
  io.out(`  telecoder service logs${flag}       follow its output`);
  io.out(`  telecoder service restart${flag}    restart it (/restartbot from chat works too)`);
  io.out(`  telecoder service uninstall${flag}  stop and remove it`);
}

// ── launchd ─────────────────────────────────────────────────────

export function launchdPaths(deps: ServiceDeps, name: string) {
  return {
    plist: path.join(deps.homedir, 'Library', 'LaunchAgents', `${launchdLabel(name)}.plist`),
    logDir: path.join(deps.homedir, 'Library', 'Logs', 'telecoder'),
    logFile: path.join(deps.homedir, 'Library', 'Logs', 'telecoder', `${name}.log`),
  };
}

const launchdDomain = (deps: ServiceDeps) => `gui/${deps.uid}`;
const launchdTarget = (deps: ServiceDeps, name: string) => `${launchdDomain(deps)}/${launchdLabel(name)}`;

async function launchdLoaded(deps: ServiceDeps, name: string): Promise<boolean> {
  return (await deps.run('launchctl', ['print', launchdTarget(deps, name)])).code === 0;
}

/** bootstrap, or `load -w` on a macOS too old to have it. */
async function launchdLoad(deps: ServiceDeps, io: CliIo, plist: string): Promise<boolean> {
  const boot = await deps.run('launchctl', ['bootstrap', launchdDomain(deps), plist]);
  if (boot.code === 0) return true;
  const legacy = await deps.run('launchctl', ['load', '-w', plist]);
  if (legacy.code === 0) return true;
  io.err(`launchctl couldn't load ${plist}: ${firstLine(boot.stderr) || firstLine(legacy.stderr) || `exit ${boot.code}`}`);
  return false;
}

async function launchdUnload(deps: ServiceDeps, name: string, plist: string): Promise<void> {
  const out = await deps.run('launchctl', ['bootout', launchdTarget(deps, name)]);
  if (out.code !== 0) await deps.run('launchctl', ['unload', '-w', plist]);
}

async function installLaunchd(deps: ServiceDeps, io: CliIo, spec: ServiceSpec, options: ServiceOptions): Promise<number> {
  const paths = launchdPaths(deps, spec.name);
  const plist = renderLaunchdPlist({ ...spec, logFile: paths.logFile });

  if (options.dryRun) {
    io.out(`Would write ${paths.plist}:`);
    io.out('');
    for (const line of plist.trimEnd().split('\n')) io.out(line);
    return 0;
  }
  if (deps.uid === 0) {
    io.err('Run this as the user the bot should run as, not as root: a LaunchAgent belongs to a user session.');
    return 1;
  }
  if (!which(deps, 'launchctl')) {
    io.err('launchctl is not on the PATH, so the LaunchAgent cannot be loaded.');
    return 1;
  }

  const existing = await checkExisting(deps, io, paths.plist, plist, options.yes);
  if (existing === null) return 1;

  deps.fs.mkdirp(paths.logDir);
  if (existing !== 'same') {
    deps.fs.mkdirp(path.dirname(paths.plist));
    deps.fs.writeFile(paths.plist, plist);
    io.out(`${existing === 'replaced' ? 'Updated' : 'Wrote'} ${paths.plist}`);
  } else {
    io.out(`${paths.plist} is already up to date.`);
  }

  const loaded = await launchdLoaded(deps, spec.name);
  // A loaded agent keeps its old definition until it is unloaded.
  if (loaded && existing === 'replaced') await launchdUnload(deps, spec.name, paths.plist);
  if (!loaded || existing === 'replaced') {
    if (!(await launchdLoad(deps, io, paths.plist))) return 1;
  }
  io.out(`${launchdLabel(spec.name)} is loaded: it runs now and whenever you log in.`);
  io.out(`Its output goes to ${paths.logFile}.`);
  printNextSteps(io, spec.name);
  return 0;
}

// ── Entry points ────────────────────────────────────────────────

/**
 * Install (or update) the service. Exported for `telecoder init`, which can
 * offer it at the end of a setup.
 */
export async function runServiceInstall(opts: ServiceInstallOptions, givenDeps: ServiceDeps = realDeps()): Promise<number> {
  const { io } = opts;
  const { deps, adopted } = withUserBus(givenDeps);
  const options: ServiceOptions = {
    name: DEFAULT_SERVICE_NAME,
    yes: false,
    fromCheckout: false,
    dryRun: false,
    follow: true,
    ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)),
  };
  if (deps.platform !== 'linux' && deps.platform !== 'darwin') {
    io.err(`telecoder service supports Linux (systemd) and macOS (launchd), not ${deps.platform}.`);
    io.err('Run "telecoder start" under any supervisor that starts it again when it exits.');
    return 1;
  }

  const resolved = resolveServiceSpec(deps, options);
  if (!resolved.ok) {
    for (const line of resolved.lines) io.err(line);
    return 1;
  }
  for (const warning of resolved.warnings) io.err(`Warning: ${warning}`);
  for (const note of resolved.notes) io.out(note);
  if (adopted && !options.dryRun) {
    io.out(`XDG_RUNTIME_DIR isn't set (sudo -u, say), but ${deps.username}'s systemd user manager is running: using ${adopted}.`);
  }

  return deps.platform === 'darwin'
    ? installLaunchd(deps, io, resolved.spec, options)
    : installSystemd(deps, io, resolved.spec, options);
}

export async function runServiceUninstall(options: ServiceOptions, io: CliIo, deps: ServiceDeps): Promise<number> {
  if (deps.platform === 'darwin') {
    const paths = launchdPaths(deps, options.name);
    if (!deps.fs.exists(paths.plist)) {
      io.err(`No service named "${options.name}" is installed (${paths.plist} doesn't exist).`);
      return 1;
    }
    await launchdUnload(deps, options.name, paths.plist);
    deps.fs.remove(paths.plist);
    io.out(`Stopped ${launchdLabel(options.name)} and removed ${paths.plist}. Logs stay in ${paths.logDir}.`);
    return 0;
  }

  const unitPath = systemdUnitPath(deps, options.name);
  const unitName = systemdUnitName(options.name);
  if (!deps.fs.exists(unitPath)) {
    io.err(`No service named "${options.name}" is installed (${unitPath} doesn't exist).`);
    return 1;
  }
  const unavailable = await systemdUnavailableReason(deps);
  if (unavailable) {
    io.err(`Can't reach systemd --user: ${unavailable.reason}.`);
    io.err(`Removing ${unitPath} anyway; it was not stopped.`);
  } else {
    // Failure here is fine: the unit may never have been loaded.
    await deps.run('systemctl', ['--user', 'disable', '--now', unitName]);
  }
  deps.fs.remove(unitPath);
  if (!unavailable) {
    await deps.run('systemctl', ['--user', 'daemon-reload']);
    await deps.run('systemctl', ['--user', 'reset-failed', unitName]);
  }
  io.out(`Stopped ${unitName} and removed ${unitPath}.`);
  if (!unavailable && (await lingerEnabled(deps))) {
    io.out(`Lingering stays on for ${deps.username}; "loginctl disable-linger ${deps.username}" turns it off if nothing else needs it.`);
  }
  return 0;
}

function notInstalled(io: CliIo, deps: ServiceDeps, name: string): boolean {
  const file = deps.platform === 'darwin' ? launchdPaths(deps, name).plist : systemdUnitPath(deps, name);
  if (deps.fs.exists(file)) return false;
  io.err(`No service named "${name}" is installed. Set one up with: telecoder service install${nameFlag(name)}`);
  return true;
}

export async function runServiceCommand(args: string[], io: CliIo, givenDeps: ServiceDeps): Promise<number> {
  const deps = withUserBus(givenDeps).deps;
  const parsed = parseServiceArgs(args);
  if ('error' in parsed) {
    io.err(parsed.error);
    for (const line of usage()) io.err(line);
    return 2;
  }
  const { sub, options } = parsed;
  if (!sub) {
    for (const line of usage()) io.out(line);
    return 0;
  }
  if (sub === 'install') return runServiceInstall({ ...options, io }, givenDeps);
  if (deps.platform !== 'linux' && deps.platform !== 'darwin') {
    io.err(`telecoder service supports Linux (systemd) and macOS (launchd), not ${deps.platform}.`);
    return 1;
  }
  if (sub === 'uninstall') return runServiceUninstall(options, io, deps);
  if (notInstalled(io, deps, options.name)) return 1;

  if (deps.platform === 'darwin') {
    const target = launchdTarget(deps, options.name);
    if (sub === 'status') return deps.runInherit('launchctl', ['print', target]);
    if (sub === 'restart') return (await step(deps, io, 'launchctl', ['kickstart', '-k', target])) ? 0 : 1;
    const { logFile } = launchdPaths(deps, options.name);
    return deps.runInherit('tail', ['-n', '100', ...(options.follow ? ['-F'] : []), logFile]);
  }

  const unitName = systemdUnitName(options.name);
  if (sub === 'status') return deps.runInherit('systemctl', ['--user', 'status', unitName, '--no-pager']);
  if (sub === 'logs') {
    return deps.runInherit('journalctl', ['--user', '-u', unitName, '-n', '100', options.follow ? '-f' : '--no-pager']);
  }
  // restart: reset-failed first, or a unit that hit its start limit (or
  // stopped on a config error) refuses to start again.
  await deps.run('systemctl', ['--user', 'reset-failed', unitName]);
  if (!(await step(deps, io, 'systemctl', ['--user', 'restart', unitName]))) return 1;
  io.out(`Restarted ${unitName}.`);
  return 0;
}

export async function run(args: string[], io: CliIo): Promise<CommandResult> {
  return runServiceCommand(args, io, realDeps());
}
