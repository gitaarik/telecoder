import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseArgs, dispatch, COMMANDS, type CommandSpec, type CliIo } from '../../src/cli/dispatch.js';
import { helpText } from '../../src/cli/commands/help.js';
import { chooseStartTarget } from '../../src/cli/commands/start.js';
import {
  checkNodeVersion,
  tokenLooksValid,
  checkAllowedUsers,
  parseAuthStatus,
  claudeAuthEnv,
  checkLoginSurvivesService,
  credentialVarsIn,
  envOnlyLogin,
} from '../../src/cli/commands/doctor.js';

function captureIo(): CliIo & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, out: (l) => lines.push(l), err: (l) => errors.push(l) };
}

function fakeCommands() {
  const calls: Array<{ name: string; args: string[] }> = [];
  const make = (name: string): CommandSpec => ({
    summary: name,
    load: async () => ({
      run: async (args) => {
        calls.push({ name, args });
        return 0;
      },
    }),
  });
  const commands = { start: make('start'), doctor: make('doctor'), help: make('help'), version: make('version') };
  return { commands, calls };
}

describe('parseArgs', () => {
  it('shows help with no arguments', () => {
    expect(parseArgs([])).toEqual({ kind: 'command', name: 'help', args: [] });
  });

  it('maps --version, -v and --help to their commands', () => {
    expect(parseArgs(['--version'])).toMatchObject({ name: 'version' });
    expect(parseArgs(['-v'])).toMatchObject({ name: 'version' });
    expect(parseArgs(['--help'])).toMatchObject({ name: 'help' });
    expect(parseArgs(['-h'])).toMatchObject({ name: 'help' });
  });

  it('passes the rest of the arguments to the command', () => {
    expect(parseArgs(['start', '--config', 'x.json'])).toEqual({ kind: 'command', name: 'start', args: ['--config', 'x.json'] });
  });

  it('turns "<command> --help" into help about that command', () => {
    expect(parseArgs(['doctor', '--help'])).toEqual({ kind: 'command', name: 'help', args: ['doctor'] });
  });

  it('reports an unknown command', () => {
    expect(parseArgs(['frobnicate'])).toEqual({ kind: 'unknown', name: 'frobnicate' });
  });

  it("doesn't take Object.prototype names for commands", () => {
    expect(parseArgs(['toString'])).toEqual({ kind: 'unknown', name: 'toString' });
  });

  it('knows the commands the init/service follow-up will fill in', () => {
    expect(Object.keys(COMMANDS)).toEqual(expect.arrayContaining(['start', 'doctor', 'init', 'service', 'help', 'version']));
  });
});

describe('dispatch', () => {
  it('runs the chosen command with its arguments', async () => {
    const { commands, calls } = fakeCommands();
    const io = captureIo();
    expect(await dispatch(['doctor', '--live'], { commands, io })).toBe(0);
    expect(calls).toEqual([{ name: 'doctor', args: ['--live'] }]);
  });

  it('exits 2 on an unknown command, without running anything', async () => {
    const { commands, calls } = fakeCommands();
    const io = captureIo();
    expect(await dispatch(['nope'], { commands, io })).toBe(2);
    expect(calls).toEqual([]);
    expect(io.errors[0]).toContain('Unknown command: nope');
  });

  it('prints the version through the real command table', async () => {
    const io = captureIo();
    expect(await dispatch(['--version'], { io })).toBe(0);
    expect(io.lines[0]).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('shows the service subcommands for a bare "service"', async () => {
    const io = captureIo();
    expect(await dispatch(['service'], { io })).toBe(0);
    expect(io.lines[0]).toContain('Usage: telecoder service');
  });
});

describe('helpText', () => {
  it('lists every command', () => {
    const text = helpText();
    for (const name of Object.keys(COMMANDS)) expect(text).toContain(`  ${name}`);
  });
});

describe('chooseStartTarget', () => {
  it('runs one bot without an instances.json', () => {
    expect(chooseStartTarget({ args: [], instancesExists: false })).toBe('single');
  });

  it('runs the launcher when instances.json exists', () => {
    expect(chooseStartTarget({ args: [], instancesExists: true })).toBe('multi');
  });

  it('lets --single and --multi/--config override', () => {
    expect(chooseStartTarget({ args: ['--single'], instancesExists: true })).toBe('single');
    expect(chooseStartTarget({ args: ['--multi'], instancesExists: false })).toBe('multi');
    expect(chooseStartTarget({ args: ['--config', 'bots.json'], instancesExists: false })).toBe('multi');
  });
});

describe('doctor checks', () => {
  it('wants Node 22 or newer', () => {
    expect(checkNodeVersion('22.0.0').status).toBe('ok');
    expect(checkNodeVersion('24.1.0').status).toBe('ok');
    expect(checkNodeVersion('20.18.0').status).toBe('fail');
  });

  it('recognises the shape of a bot token', () => {
    expect(tokenLooksValid('123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw')).toBe(true);
    expect(tokenLooksValid('your_telegram_bot_token')).toBe(false);
    expect(tokenLooksValid('123456789:short')).toBe(false);
  });

  it('refuses the placeholder user id', () => {
    expect(checkAllowedUsers('123456789').status).toBe('fail');
    expect(checkAllowedUsers('').status).toBe('fail');
    expect(checkAllowedUsers('@me').status).toBe('fail');
    expect(checkAllowedUsers('42, 43').status).toBe('ok');
  });

  it('reads claude auth status', () => {
    expect(parseAuthStatus('{"loggedIn":true,"authMethod":"claude.ai"}')).toEqual({ loggedIn: true, method: 'claude.ai' });
    expect(parseAuthStatus('{"loggedIn":false}')).toEqual({ loggedIn: false, method: undefined });
    expect(parseAuthStatus('error: unknown command')).toBeNull();
  });

  it('hands claude the login kept in the .env, and nothing else from it', () => {
    const file: Record<string, string> = { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x', TELEGRAM_BOT_TOKEN: '1:abc' };
    const env = claudeAuthEnv((key) => file[key], { PATH: '/bin' });
    expect(env).toEqual({ PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x' });
  });

  it('finds the credential variables a login can come from', () => {
    expect(credentialVarsIn({ CLAUDE_CODE_OAUTH_TOKEN: 'x', ANTHROPIC_API_KEY: ' ', ANTHROPIC_BASE_URL: 'u' })).toEqual(['CLAUDE_CODE_OAUTH_TOKEN']);
    expect(credentialVarsIn({})).toEqual([]);
  });

  it('tells a login kept in the environment from stored credentials, asking claude without the variables', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-doctor-'));
    try {
      // A fake claude: logged in when a token is set, or when FAKE_STORED says credentials are stored.
      const bin = path.join(dir, 'claude');
      fs.writeFileSync(bin, '#!/bin/sh\nif [ -n "$CLAUDE_CODE_OAUTH_TOKEN$FAKE_STORED" ]; then echo \'{"loggedIn":true}\'; ' +
        'else echo \'{"loggedIn":false}\'; fi\n', { mode: 0o755 });
      const base = { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: dir };
      expect(await envOnlyLogin(bin, { ...base, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x' })).toEqual(['CLAUDE_CODE_OAUTH_TOKEN']);
      expect(await envOnlyLogin(bin, { ...base, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x', FAKE_STORED: '1' })).toEqual([]);
      expect(await envOnlyLogin(bin, base)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('warns that a login only in the shell environment leaves a service logged out', () => {
    const w = checkLoginSurvivesService(['CLAUDE_CODE_OAUTH_TOKEN'], {}, '/h/.telecoder/.env');
    expect(w?.status).toBe('warn');
    expect(w?.label).toContain('CLAUDE_CODE_OAUTH_TOKEN in this shell');
    expect(w?.detail?.join('\n')).toContain('start logged out');
    expect(checkLoginSurvivesService(['CLAUDE_CODE_OAUTH_TOKEN'], { CLAUDE_CODE_OAUTH_TOKEN: 'x' }, '/e')).toBeNull();
    expect(checkLoginSurvivesService([], {}, '/e')).toBeNull();
  });
});
