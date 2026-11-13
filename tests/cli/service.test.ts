import { describe, it, expect } from 'vitest';
import {
  chooseNodePath,
  parseServiceArgs,
  runServiceCommand,
  runServiceInstall,
  type RunResult,
  type ServiceDeps,
} from '../../src/cli/commands/service.js';
import type { CliIo } from '../../src/cli/dispatch.js';

const UNIT = '/home/u/.config/systemd/user/telecoder.service';
const CLI = '/usr/lib/node_modules/telecoder/dist/cli.js';
const PLIST = '/Users/u/Library/LaunchAgents/dev.telecoder.telecoder.plist';

interface Fake {
  deps: ServiceDeps;
  files: Map<string, string>;
  calls: string[];
  inherited: string[];
  questions: string[];
  writes: string[];
  io: CliIo & { out: (l: string) => void; text: () => string };
}

interface FakeOptions {
  over?: Partial<ServiceDeps>;
  files?: Record<string, string>;
  dirs?: string[];
  execs?: string[];
  answers?: Array<boolean | null>;
  /** Scripted results by "cmd arg arg"; the rest succeed with no output. */
  results?: Record<string, Partial<RunResult>>;
  realpaths?: Record<string, string>;
}

function fake({ over = {}, files = {}, dirs = [], execs, answers = [], results = {}, realpaths = {} }: FakeOptions = {}): Fake {
  const fileMap = new Map(Object.entries({ [CLI]: '#!/usr/bin/env node', '/home/u/.telecoder/.env': 'TOKEN', ...files }));
  const dirSet = new Set(['/run/systemd/system', '/usr/bin', '/usr/local/bin', '/bin', '/home/u/.local/bin', ...dirs]);
  const execSet = new Set(execs ?? ['/usr/bin/node', '/usr/bin/systemctl', '/usr/bin/git', '/home/u/.local/bin/claude', '/usr/bin/launchctl']);
  const calls: string[] = [];
  const inherited: string[] = [];
  const questions: string[] = [];
  const writes: string[] = [];
  const lines: string[] = [];
  const queue = [...answers];

  const deps: ServiceDeps = {
    platform: 'linux',
    env: { PATH: '/home/u/.local/bin:/usr/bin', XDG_RUNTIME_DIR: '/run/user/1000' },
    homedir: '/home/u',
    uid: 1000,
    username: 'u',
    execPath: '/usr/bin/node',
    packageRoot: '/usr/lib/node_modules/telecoder',
    installMode: 'package',
    packageRunner: 'global',
    configHome: { dir: '/home/u/.telecoder', source: 'home' },
    fs: {
      exists: (p) => fileMap.has(p) || dirSet.has(p),
      readFile: (p) => {
        const content = fileMap.get(p);
        if (content === undefined) throw new Error(`ENOENT ${p}`);
        return content;
      },
      writeFile: (p, content) => {
        writes.push(p);
        fileMap.set(p, content);
      },
      mkdirp: (p) => {
        dirSet.add(p);
      },
      remove: (p) => {
        fileMap.delete(p);
      },
      realpath: (p) => realpaths[p] ?? p,
      isExecutable: (p) => execSet.has(p),
    },
    run: async (cmd, args) => {
      const key = [cmd, ...args].join(' ');
      calls.push(key);
      const scripted = results[key] ?? (key.startsWith('loginctl show-user') ? { stdout: 'no\n' } : {});
      return { code: 0, stdout: '', stderr: '', ...scripted };
    },
    runInherit: async (cmd, args) => {
      inherited.push([cmd, ...args].join(' '));
      return 0;
    },
    ask: async (question) => {
      questions.push(question);
      return queue.length ? (queue.shift() as boolean | null) : null;
    },
    ...over,
  };
  const io = {
    out: (l: string) => lines.push(l),
    err: (l: string) => lines.push(l),
    text: () => lines.join('\n'),
  };
  return { deps, files: fileMap, calls, inherited, questions, writes, io };
}

const mutating = (calls: string[]) =>
  calls.filter((c) => !c.includes('show-environment') && !c.startsWith('loginctl show-user') && !c.startsWith('launchctl print'));

describe('parseServiceArgs', () => {
  it('reads the subcommand and flags in any order', () => {
    const parsed = parseServiceArgs(['--name', 'work.service', 'install', '--yes', '--no-linger']);
    expect(parsed).toMatchObject({ sub: 'install', options: { name: 'work', yes: true, linger: false } });
  });

  it('rejects unknown arguments and bad names', () => {
    expect(parseServiceArgs(['install', '--bogus'])).toHaveProperty('error');
    expect(parseServiceArgs(['install', '--name', '../etc'])).toHaveProperty('error');
    expect(parseServiceArgs(['install', '--name'])).toHaveProperty('error');
  });
});

describe('service install on Linux', () => {
  it('writes the unit, enables it, and enables lingering when the answer is yes', async () => {
    const f = fake({ answers: [true] });
    expect(await runServiceInstall({ io: f.io }, f.deps)).toBe(0);

    const unit = f.files.get(UNIT)!;
    expect(unit).toContain(`ExecStart=/usr/bin/node ${CLI} start\n`);
    expect(unit).toContain('WorkingDirectory=/home/u/.telecoder\n');
    expect(unit).toContain('Environment="PATH=/usr/bin:/home/u/.local/bin:/usr/local/bin:/bin"\n');
    expect(unit).not.toContain('TELECODER_HOME');
    expect(f.questions).toEqual(['Enable it for u (loginctl enable-linger)?']);
    expect(mutating(f.calls)).toEqual([
      'systemctl --user daemon-reload',
      'systemctl --user enable --now telecoder.service',
      'loginctl enable-linger u',
    ]);
    expect(f.io.text()).toContain('telecoder service logs');
  });

  it('leaves lingering off when the answer is no', async () => {
    const f = fake({ answers: [false] });
    expect(await runServiceInstall({ io: f.io }, f.deps)).toBe(0);
    expect(f.calls).not.toContain('loginctl enable-linger u');
    expect(f.io.text()).toContain('Lingering is off');
  });

  it('skips lingering without a terminal to ask in, and enables it with --yes', async () => {
    const noTty = fake({ answers: [null] });
    expect(await runServiceInstall({ io: noTty.io }, noTty.deps)).toBe(0);
    expect(noTty.calls).not.toContain('loginctl enable-linger u');

    const yes = fake();
    expect(await runServiceInstall({ io: yes.io, yes: true }, yes.deps)).toBe(0);
    expect(yes.questions).toEqual([]);
    expect(yes.calls).toContain('loginctl enable-linger u');
  });

  it("doesn't ask about lingering when it is already on, or with --no-linger", async () => {
    const on = fake({ results: { 'loginctl show-user u --property=Linger --value': { stdout: 'yes\n' } } });
    expect(await runServiceInstall({ io: on.io }, on.deps)).toBe(0);
    expect(on.questions).toEqual([]);

    const off = fake();
    expect(await runServiceInstall({ io: off.io, linger: false }, off.deps)).toBe(0);
    expect(off.questions).toEqual([]);
    expect(off.calls).not.toContain('loginctl enable-linger u');
  });

  it('suggests sudo when enabling lingering is refused', async () => {
    const f = fake({ answers: [true], results: { 'loginctl enable-linger u': { code: 1, stderr: 'Access denied' } } });
    expect(await runServiceInstall({ io: f.io }, f.deps)).toBe(0);
    expect(f.io.text()).toContain('sudo loginctl enable-linger u');
  });

  it('leaves an identical unit alone and does not restart the bot', async () => {
    const first = fake({ answers: [false] });
    await runServiceInstall({ io: first.io }, first.deps);
    const unit = first.files.get(UNIT)!;

    const f = fake({ files: { [UNIT]: unit }, answers: [false] });
    expect(await runServiceInstall({ io: f.io }, f.deps)).toBe(0);
    expect(f.writes).toEqual([]);
    expect(f.io.text()).toContain('already up to date');
    expect(f.calls).toContain('systemctl --user enable --now telecoder.service');
    expect(f.calls).not.toContain('systemctl --user restart telecoder.service');
  });

  it('shows what changes in a different unit, and replaces and restarts it on yes', async () => {
    const f = fake({ files: { [UNIT]: '[Service]\nExecStart=/old/node /old/cli.js start\n' }, answers: [true, false] });
    expect(await runServiceInstall({ io: f.io }, f.deps)).toBe(0);
    expect(f.questions[0]).toBe('Replace it?');
    expect(f.io.text()).toContain('- ExecStart=/old/node /old/cli.js start');
    expect(f.io.text()).toContain(`+ ExecStart=/usr/bin/node ${CLI} start`);
    expect(f.files.get(UNIT)).toContain(CLI);
    expect(f.calls).toContain('systemctl --user restart telecoder.service');
  });

  it('keeps a different unit on no, and without a terminal unless --yes', async () => {
    const old = '[Service]\nExecStart=/old\n';
    for (const answer of [false, null]) {
      const f = fake({ files: { [UNIT]: old }, answers: [answer] });
      expect(await runServiceInstall({ io: f.io }, f.deps)).toBe(1);
      expect(f.files.get(UNIT)).toBe(old);
      expect(mutating(f.calls)).toEqual([]);
      if (answer === null) expect(f.io.text()).toContain('--yes');
    }

    const yes = fake({ files: { [UNIT]: old } });
    expect(await runServiceInstall({ io: yes.io, yes: true }, yes.deps)).toBe(0);
    expect(yes.files.get(UNIT)).toContain(CLI);
  });

  it('prints a manual fallback when systemd is not running', async () => {
    const f = fake({ over: {} });
    f.deps.fs.exists = ((orig) => (p: string) => p !== '/run/systemd/system' && orig(p))(f.deps.fs.exists);
    expect(await runServiceInstall({ io: f.io }, f.deps)).toBe(1);
    expect(f.writes).toEqual([]);
    expect(f.io.text()).toContain('not booted with systemd');
    expect(f.io.text()).toContain('pm2 start');
    expect(f.io.text()).toContain('RestartPreventExitStatus=78');
  });

  it('explains a missing user session (sudo) and an unreachable user manager', async () => {
    const sudo = fake({ over: { env: { PATH: '/usr/bin' } } });
    expect(await runServiceInstall({ io: sudo.io }, sudo.deps)).toBe(1);
    expect(sudo.io.text()).toContain('XDG_RUNTIME_DIR is unset');

    const noBus = fake({ results: { 'systemctl --user show-environment': { code: 1, stderr: 'Failed to connect to bus: No medium found' } } });
    expect(await runServiceInstall({ io: noBus.io }, noBus.deps)).toBe(1);
    expect(noBus.io.text()).toContain('Failed to connect to bus');
    expect(noBus.writes).toEqual([]);
  });

  it('carries TELECODER_HOME when the config home was moved', async () => {
    const f = fake({
      over: { configHome: { dir: '/srv/tc', source: 'override' } },
      files: { '/srv/tc/.env': 'x' },
      answers: [false],
    });
    expect(await runServiceInstall({ io: f.io }, f.deps)).toBe(0);
    expect(f.files.get(UNIT)).toContain('Environment="TELECODER_HOME=/srv/tc"');
    expect(f.files.get(UNIT)).toContain('WorkingDirectory=/srv/tc\n');
  });

  it('writes nothing on --dry-run', async () => {
    const f = fake();
    expect(await runServiceInstall({ io: f.io, dryRun: true }, f.deps)).toBe(0);
    expect(f.writes).toEqual([]);
    expect(f.calls).toEqual([]);
    expect(f.io.text()).toContain(`Would write ${UNIT}`);
  });

  it('uses --name for the unit file', async () => {
    const f = fake({ answers: [false] });
    expect(await runServiceCommand(['install', '--name', 'work'], f.io, f.deps)).toBe(0);
    expect(f.files.has('/home/u/.config/systemd/user/work.service')).toBe(true);
    expect(f.calls).toContain('systemctl --user enable --now work.service');
  });
});

describe('service install refusals', () => {
  it('refuses an npx install, pointing at npm install -g', async () => {
    const f = fake({ over: { packageRunner: 'npx', packageRoot: '/home/u/.npm/_npx/abc/node_modules/telecoder' } });
    expect(await runServiceInstall({ io: f.io }, f.deps)).toBe(1);
    expect(f.io.text()).toContain('npm install -g telecoder');
    expect(f.writes).toEqual([]);
  });

  it('points a checkout at pm2/botctl, and installs from its dist/ with --from-checkout', async () => {
    const checkout = { installMode: 'checkout' as const, packageRoot: '/home/u/dev/telecoder', configHome: { dir: '/home/u/dev/telecoder', source: 'package-root' as const } };
    const files = { '/home/u/dev/telecoder/dist/cli.js': 'x', '/home/u/dev/telecoder/.env': 'x' };

    const plain = fake({ over: checkout, files });
    expect(await runServiceInstall({ io: plain.io }, plain.deps)).toBe(1);
    expect(plain.io.text()).toContain('telecoder-botctl.sh');
    expect(plain.io.text()).toContain('--from-checkout');

    const from = fake({ over: checkout, files, answers: [false] });
    expect(await runServiceInstall({ io: from.io, fromCheckout: true }, from.deps)).toBe(0);
    expect(from.files.get(UNIT)).toContain('ExecStart=/usr/bin/node /home/u/dev/telecoder/dist/cli.js start');
  });

  it('asks for a build when a checkout has no dist/ yet', async () => {
    const f = fake({ over: { installMode: 'checkout', packageRoot: '/home/u/dev/telecoder' } });
    expect(await runServiceInstall({ io: f.io, fromCheckout: true }, f.deps)).toBe(1);
    expect(f.io.text()).toContain('npm run build');
  });

  it('sends a machine without config to telecoder init', async () => {
    const f = fake();
    f.files.delete('/home/u/.telecoder/.env');
    expect(await runServiceInstall({ io: f.io }, f.deps)).toBe(1);
    expect(f.io.text()).toContain('telecoder init');
  });

  it('refuses platforms without systemd or launchd', async () => {
    const f = fake({ over: { platform: 'win32' } });
    expect(await runServiceInstall({ io: f.io }, f.deps)).toBe(1);
    expect(f.io.text()).toContain('Linux (systemd) and macOS (launchd)');
  });

  it('warns when claude is not on the PATH', async () => {
    const f = fake({ execs: ['/usr/bin/node', '/usr/bin/systemctl'], answers: [false] });
    expect(await runServiceInstall({ io: f.io }, f.deps)).toBe(0);
    expect(f.io.text()).toContain('claude CLI is not on your PATH');
  });
});

describe('chooseNodePath', () => {
  it('prefers the node on PATH over a versioned Homebrew Cellar path it leads to', () => {
    const cellar = '/opt/homebrew/Cellar/node/22.1.0/bin/node';
    const f = fake({
      over: { execPath: cellar, platform: 'darwin', env: { PATH: '/opt/homebrew/bin:/usr/bin' } },
      execs: ['/opt/homebrew/bin/node'],
      realpaths: { '/opt/homebrew/bin/node': cellar },
    });
    expect(chooseNodePath(f.deps)).toBe('/opt/homebrew/bin/node');
  });

  it("keeps execPath when the node on PATH is a different one", () => {
    const f = fake({ over: { execPath: '/home/u/.nvm/versions/node/v22.0.0/bin/node' } });
    expect(chooseNodePath(f.deps)).toBe('/home/u/.nvm/versions/node/v22.0.0/bin/node');
  });
});

describe('service install on macOS', () => {
  const mac = (extra: FakeOptions = {}) =>
    fake({
      ...extra,
      over: {
        platform: 'darwin',
        homedir: '/Users/u',
        uid: 501,
        env: { PATH: '/usr/bin' },
        configHome: { dir: '/Users/u/.telecoder', source: 'home' },
        ...extra.over,
      },
      files: { '/Users/u/.telecoder/.env': 'x', ...extra.files },
      results: { 'launchctl print gui/501/dev.telecoder.telecoder': { code: 113 }, ...extra.results },
    });

  it('writes the LaunchAgent and bootstraps it', async () => {
    const f = mac();
    expect(await runServiceInstall({ io: f.io }, f.deps)).toBe(0);
    const plist = f.files.get(PLIST)!;
    expect(plist).toContain('<string>dev.telecoder.telecoder</string>');
    expect(plist).toContain('<string>/Users/u/Library/Logs/telecoder/telecoder.log</string>');
    expect(plist).toContain('<key>SuccessfulExit</key>\n    <false/>');
    expect(f.calls).toContain(`launchctl bootstrap gui/501 ${PLIST}`);
    expect(f.calls.some((c) => c.includes('loginctl'))).toBe(false);
  });

  it('falls back to load -w when bootstrap fails (older macOS)', async () => {
    const f = mac({ results: { [`launchctl bootstrap gui/501 ${PLIST}`]: { code: 1, stderr: 'Unrecognized subcommand' } } });
    expect(await runServiceInstall({ io: f.io }, f.deps)).toBe(0);
    expect(f.calls).toContain(`launchctl load -w ${PLIST}`);
  });

  it('reloads a changed agent that is already loaded', async () => {
    const f = mac({
      files: { [PLIST]: '<plist>old</plist>' },
      answers: [true],
      results: { 'launchctl print gui/501/dev.telecoder.telecoder': { code: 0 } },
    });
    expect(await runServiceInstall({ io: f.io }, f.deps)).toBe(0);
    const i = f.calls.indexOf('launchctl bootout gui/501/dev.telecoder.telecoder');
    expect(i).toBeGreaterThan(-1);
    expect(f.calls.indexOf(`launchctl bootstrap gui/501 ${PLIST}`)).toBeGreaterThan(i);
  });

  it('refuses to run as root', async () => {
    const f = mac({ over: { uid: 0 } });
    expect(await runServiceInstall({ io: f.io }, f.deps)).toBe(1);
    expect(f.writes).toEqual([]);
  });

  it('tails the log file, restarts with kickstart, and uninstalls with bootout', async () => {
    const f = mac({ files: { [PLIST]: 'x' } });
    expect(await runServiceCommand(['logs', '--no-follow'], f.io, f.deps)).toBe(0);
    expect(f.inherited).toEqual(['tail -n 100 /Users/u/Library/Logs/telecoder/telecoder.log']);
    expect(await runServiceCommand(['restart'], f.io, f.deps)).toBe(0);
    expect(f.calls).toContain('launchctl kickstart -k gui/501/dev.telecoder.telecoder');
    expect(await runServiceCommand(['uninstall'], f.io, f.deps)).toBe(0);
    expect(f.calls).toContain('launchctl bootout gui/501/dev.telecoder.telecoder');
    expect(f.files.has(PLIST)).toBe(false);
  });
});

describe('service status, logs, restart, uninstall on Linux', () => {
  it('wraps systemctl status and journalctl', async () => {
    const f = fake({ files: { [UNIT]: 'x' } });
    await runServiceCommand(['status'], f.io, f.deps);
    await runServiceCommand(['logs'], f.io, f.deps);
    await runServiceCommand(['logs', '--no-follow'], f.io, f.deps);
    expect(f.inherited).toEqual([
      'systemctl --user status telecoder.service --no-pager',
      'journalctl --user -u telecoder.service -n 100 -f',
      'journalctl --user -u telecoder.service -n 100 --no-pager',
    ]);
  });

  it('resets a failed unit before restarting it', async () => {
    const f = fake({ files: { [UNIT]: 'x' } });
    expect(await runServiceCommand(['restart'], f.io, f.deps)).toBe(0);
    expect(f.calls).toEqual(['systemctl --user reset-failed telecoder.service', 'systemctl --user restart telecoder.service']);
  });

  it('says so when nothing is installed', async () => {
    const f = fake();
    expect(await runServiceCommand(['status'], f.io, f.deps)).toBe(1);
    expect(f.inherited).toEqual([]);
    expect(f.io.text()).toContain('telecoder service install');
  });

  it('disables, removes and reloads on uninstall, leaving lingering alone', async () => {
    const f = fake({ files: { [UNIT]: 'x' }, results: { 'loginctl show-user u --property=Linger --value': { stdout: 'yes\n' } } });
    expect(await runServiceCommand(['uninstall'], f.io, f.deps)).toBe(0);
    expect(f.files.has(UNIT)).toBe(false);
    expect(mutating(f.calls)).toEqual([
      'systemctl --user disable --now telecoder.service',
      'systemctl --user daemon-reload',
      'systemctl --user reset-failed telecoder.service',
    ]);
    expect(f.io.text()).toContain('loginctl disable-linger u');
  });

  it('prints usage without a subcommand', async () => {
    const f = fake();
    expect(await runServiceCommand([], f.io, f.deps)).toBe(0);
    expect(f.io.text()).toContain('Usage: telecoder service');
  });
});
