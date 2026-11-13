import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  envFileStatus,
  formatConfigReport,
  problemsFromIssues,
} from '../src/config-report.js';

describe('problemsFromIssues', () => {
  it('calls an absent key "not set", whatever check caught it', () => {
    const problems = problemsFromIssues(
      [
        { path: ['TELEGRAM_BOT_TOKEN'], code: 'invalid_type', message: 'Invalid input: expected string, received undefined' },
        { path: ['ALLOWED_USER_IDS'], code: 'too_small', message: 'At least one allowed user ID is required' },
      ],
      { ALLOWED_USER_IDS: '' },
    );
    expect(problems).toEqual([
      { key: 'TELEGRAM_BOT_TOKEN', message: 'TELEGRAM_BOT_TOKEN is not set.' },
      { key: 'ALLOWED_USER_IDS', message: 'ALLOWED_USER_IDS is not set.' },
    ]);
  });

  it('keeps a set value\'s own message, once per key', () => {
    const problems = problemsFromIssues(
      [
        { path: ['ALLOWED_USER_IDS'], message: 'ALLOWED_USER_IDS contains "@alice", which is not a number.' },
        { path: ['ALLOWED_USER_IDS'], message: 'a second complaint about the same line' },
        { path: ['SCOPE_GUARD'], message: 'Invalid option: expected one of "auto"|"on"|"off"' },
      ],
      { ALLOWED_USER_IDS: '@alice', SCOPE_GUARD: 'maybe' },
    );
    expect(problems).toEqual([
      { key: 'ALLOWED_USER_IDS', message: 'ALLOWED_USER_IDS contains "@alice", which is not a number.' },
      { key: 'SCOPE_GUARD', message: 'SCOPE_GUARD: Invalid option: expected one of "auto"|"on"|"off".' },
    ]);
  });
});

describe('formatConfigReport', () => {
  const missing = [
    { key: 'TELEGRAM_BOT_TOKEN', message: 'TELEGRAM_BOT_TOKEN is not set.' },
    { key: 'ALLOWED_USER_IDS', message: 'ALLOWED_USER_IDS is not set.' },
  ];

  it('says no .env was found, how to get each value, and how to make one', () => {
    const report = formatConfigReport(missing, { path: '/srv/telecoder/.env', status: 'missing' });
    expect(report).toContain('No .env file was found at /srv/telecoder/.env');
    expect(report).toContain('@BotFather');
    expect(report).toContain('@userinfobot');
    expect(report).toContain('/start');
    expect(report).toContain('`telecoder init`');
    expect(report).toContain('copy .env.example to .env');
  });

  it('names the file it read, and sends the fix there', () => {
    const report = formatConfigReport(missing.slice(0, 1), { path: '/home/me/.env', status: 'loaded' });
    expect(report).toContain('Settings were read from /home/me/.env');
    expect(report).toContain('Fix it in /home/me/.env');
    expect(report).not.toContain('telecoder init');
  });

  it("doesn't repeat where to get an id under a message that already says", () => {
    const report = formatConfigReport(
      [{ key: 'ALLOWED_USER_IDS', message: 'ALLOWED_USER_IDS still contains 123456789 — message @userinfobot on Telegram to get it.' }],
      { path: '/x/.env', status: 'loaded' },
    );
    expect(report.match(/@userinfobot/g)).toHaveLength(1);
  });

  it('points a launcher bot at instances.json', () => {
    const report = formatConfigReport(missing.slice(0, 1), { path: '/x/.env', status: 'loaded' }, { instanceName: 'TeleCoder 2' });
    expect(report).toContain('"TeleCoder 2"');
    expect(report).toContain('instances.json');
  });
});

describe('envFileStatus', () => {
  it('reads dotenv\'s result', () => {
    expect(envFileStatus({})).toBe('loaded');
    expect(envFileStatus({ error: Object.assign(new Error('nope'), { code: 'ENOENT' }) })).toBe('missing');
    expect(envFileStatus({ error: Object.assign(new Error('nope'), { code: 'EACCES' }) })).toBe('unreadable');
  });
});

/**
 * config.ts end to end: it validates at import time and exits, so it runs in a
 * child process with nothing but the variables each case gives it.
 */
describe('config.ts startup report', () => {
  const root = path.resolve(__dirname, '..');
  const tsx = path.join(root, 'node_modules', '.bin', 'tsx');

  function loadConfig(vars: Record<string, string>, envFile?: string) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-config-report-'));
    try {
      const envPath = path.join(dir, '.env');
      if (envFile !== undefined) fs.writeFileSync(envPath, envFile);
      const result = spawnSync(tsx, [path.join(root, 'src', 'config.ts')], {
        cwd: root,
        env: { PATH: process.env.PATH ?? '', HOME: dir, TELECODER_ENV_PATH: envPath, ...vars },
        encoding: 'utf8',
        timeout: 60_000,
      });
      return { status: result.status, stderr: result.stderr, envPath };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('reports a missing .env and missing keys in plain words, and exits 1 without a stack', () => {
    const { status, stderr, envPath } = loadConfig({});
    expect(status).toBe(1);
    expect(stderr).toContain(`No .env file was found at ${envPath}`);
    expect(stderr).toContain('TELEGRAM_BOT_TOKEN is not set.');
    expect(stderr).toContain('ALLOWED_USER_IDS is not set.');
    expect(stderr).toContain('telecoder init');
    expect(stderr).not.toContain('invalid_type');
    expect(stderr).not.toMatch(/\n\s+at /);
  }, 60_000);

  it('reports bad ids and a malformed token from the .env it read', () => {
    const { status, stderr, envPath } = loadConfig(
      {},
      'TELEGRAM_BOT_TOKEN=your_bot_token_here\nALLOWED_USER_IDS=123456789\nADMIN_USER_IDS=@alice\n',
    );
    expect(status).toBe(1);
    expect(stderr).toContain(`Settings were read from ${envPath}`);
    expect(stderr).toContain("TELEGRAM_BOT_TOKEN doesn't look like a bot token");
    expect(stderr).toContain('ALLOWED_USER_IDS still contains 123456789');
    expect(stderr).toContain('ADMIN_USER_IDS contains "@alice", which is not a number.');
    expect(stderr).not.toContain('your_bot_token_here');
  }, 60_000);
});
