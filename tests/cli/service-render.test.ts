import { describe, it, expect } from 'vitest';
import {
  buildServicePath,
  lineDiff,
  normalizeServiceName,
  renderLaunchdPlist,
  renderSystemdUnit,
  systemdEnvironment,
  systemdExecArg,
  type ServiceSpec,
} from '../../src/cli/service/render.js';

const spec: ServiceSpec = {
  name: 'telecoder',
  nodePath: '/usr/bin/node',
  cliPath: '/usr/lib/node_modules/telecoder/dist/cli.js',
  workingDirectory: '/home/u/.telecoder',
  pathEnv: '/usr/bin:/home/u/.local/bin:/usr/local/bin:/bin',
  env: [],
};

describe('renderSystemdUnit', () => {
  it('renders the whole unit', () => {
    expect(renderSystemdUnit(spec)).toBe([
      '# Written by `telecoder service install`. Run it again to rewrite this file,',
      '# `telecoder service uninstall` to remove it. No secrets here: the bot reads',
      '# its token from the .env in WorkingDirectory.',
      '[Unit]',
      'Description=TeleCoder (Claude Code from Telegram)',
      'Documentation=https://telecoder.dev',
      'StartLimitIntervalSec=300',
      'StartLimitBurst=20',
      '',
      '[Service]',
      'Type=simple',
      'WorkingDirectory=/home/u/.telecoder',
      'ExecStart=/usr/bin/node /usr/lib/node_modules/telecoder/dist/cli.js start',
      'Environment="PATH=/usr/bin:/home/u/.local/bin:/usr/local/bin:/bin"',
      'Environment="TELECODER_SERVICE=systemd"',
      '# always, not on-failure: /restartbot exits for systemd to bring the bot back.',
      '# `systemctl --user stop` is still a stop — systemd never restarts a unit it',
      '# was told to stop.',
      'Restart=always',
      'RestartSec=5',
      '# 75 is the exit /restartbot uses: logged as a clean exit, restarted all the same.',
      'SuccessExitStatus=75',
      '# 78 is a configuration problem (a missing setting, a rejected token):',
      '# starting again would only print the same error. Fix it, then',
      '# `telecoder service restart`.',
      'RestartPreventExitStatus=78',
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n'));
  });

  it('carries extra variables, after PATH', () => {
    const unit = renderSystemdUnit({ ...spec, env: [['TELECODER_HOME', '/srv/bot']] });
    expect(unit).toContain('Environment="PATH=/usr/bin:/home/u/.local/bin:/usr/local/bin:/bin"\nEnvironment="TELECODER_HOME=/srv/bot"\n');
  });

  it('escapes paths with spaces, % and $', () => {
    const unit = renderSystemdUnit({
      ...spec,
      nodePath: '/opt/my node/node$1',
      cliPath: '/opt/100% "tc"/cli.js',
      workingDirectory: '/home/u/my 100%',
    });
    expect(unit).toContain('WorkingDirectory=/home/u/my 100%%\n');
    expect(unit).toContain('ExecStart="/opt/my node/node$1" "/opt/100%% \\"tc\\"/cli.js" start\n');
  });

  it('refuses a line break, which would start a new directive', () => {
    expect(() => renderSystemdUnit({ ...spec, workingDirectory: '/a\nExecStartPre=/bin/evil' })).toThrow(/line break/);
  });
});

describe('systemd escaping', () => {
  it('leaves plain words bare', () => {
    expect(systemdExecArg('/usr/bin/node', true)).toBe('/usr/bin/node');
    expect(systemdExecArg('start')).toBe('start');
  });

  it('doubles $ in arguments but not in the executable', () => {
    expect(systemdExecArg('/a/$x')).toBe('"/a/$$x"');
    expect(systemdExecArg('/a/$x', true)).toBe('"/a/$x"');
  });

  it('quotes Environment= values', () => {
    expect(systemdEnvironment('PATH', '/a b:/c%d')).toBe('Environment="PATH=/a b:/c%%d"');
    expect(() => systemdEnvironment('BAD KEY', 'x')).toThrow();
  });
});

describe('renderLaunchdPlist', () => {
  it('renders the whole agent', () => {
    const plist = renderLaunchdPlist({
      ...spec,
      nodePath: '/opt/homebrew/bin/node',
      cliPath: '/opt/homebrew/lib/node_modules/telecoder/dist/cli.js',
      workingDirectory: '/Users/u/.telecoder',
      pathEnv: '/opt/homebrew/bin:/usr/bin:/bin',
      env: [['TELECODER_HOME', '/Users/u/bots & co']],
      logFile: '/Users/u/Library/Logs/telecoder/telecoder.log',
    });
    expect(plist).toBe([
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<!-- Written by `telecoder service install`; `telecoder service uninstall` removes it. -->',
      '<plist version="1.0">',
      '<dict>',
      '  <key>Label</key>',
      '  <string>dev.telecoder.telecoder</string>',
      '  <key>ProgramArguments</key>',
      '  <array>',
      '    <string>/opt/homebrew/bin/node</string>',
      '    <string>/opt/homebrew/lib/node_modules/telecoder/dist/cli.js</string>',
      '    <string>start</string>',
      '  </array>',
      '  <key>WorkingDirectory</key>',
      '  <string>/Users/u/.telecoder</string>',
      '  <key>EnvironmentVariables</key>',
      '  <dict>',
      '    <key>PATH</key>',
      '    <string>/opt/homebrew/bin:/usr/bin:/bin</string>',
      '    <key>TELECODER_HOME</key>',
      '    <string>/Users/u/bots &amp; co</string>',
      '    <key>TELECODER_SERVICE</key>',
      '    <string>launchd</string>',
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
      '  <string>/Users/u/Library/Logs/telecoder/telecoder.log</string>',
      '  <key>StandardErrorPath</key>',
      '  <string>/Users/u/Library/Logs/telecoder/telecoder.log</string>',
      '</dict>',
      '</plist>',
      '',
    ].join('\n'));
  });
});

describe('buildServicePath', () => {
  it('puts the required dirs first, then the shell PATH, then the defaults, without repeats', () => {
    expect(buildServicePath({
      required: ['/home/u/.nvm/versions/node/v22/bin', '/home/u/.local/bin'],
      inherited: '/home/u/.local/bin:/home/u/.cargo/bin:/usr/bin',
      platform: 'linux',
    })).toBe('/home/u/.nvm/versions/node/v22/bin:/home/u/.local/bin:/home/u/.cargo/bin:/usr/bin:/usr/local/bin:/bin');
  });

  it("drops relative entries, node_modules/.bin and dirs that don't exist", () => {
    expect(buildServicePath({
      required: [],
      inherited: '.:bin:/proj/node_modules/.bin:/gone:/usr/bin/',
      platform: 'linux',
      keep: (dir) => dir !== '/gone',
    })).toBe('/usr/bin:/usr/local/bin:/bin');
  });

  it('adds Homebrew on macOS', () => {
    expect(buildServicePath({ required: [], inherited: undefined, platform: 'darwin' }))
      .toBe('/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin');
  });
});

describe('normalizeServiceName', () => {
  it('strips .service and accepts the usual characters', () => {
    expect(normalizeServiceName('telecoder-work.service')).toEqual({ name: 'telecoder-work' });
    expect(normalizeServiceName('tc_2.b')).toEqual({ name: 'tc_2.b' });
  });

  it('rejects slashes, spaces and leading dashes', () => {
    for (const bad of ['../x', 'a b', '-x', '', 'a/b']) {
      expect(normalizeServiceName(bad)).toHaveProperty('error');
    }
  });
});

describe('lineDiff', () => {
  it('lists only the changed lines, in order', () => {
    expect(lineDiff('a\nb\nc\n', 'a\nB\nc\nd\n')).toEqual(['- b', '+ B', '+ d']);
  });

  it('is empty for identical text', () => {
    expect(lineDiff('a\nb', 'a\nb')).toEqual([]);
  });
});
