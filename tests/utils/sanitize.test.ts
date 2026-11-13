import { describe, it, expect } from 'vitest';
import * as os from 'os';
import { sanitizePath, sanitizeError, redactSecrets } from '../../src/utils/sanitize.js';

describe('sanitizePath', () => {
  it('replaces the home directory with ~', () => {
    const home = os.homedir();
    const input = `${home}/dev/secret/file.ts`;
    expect(sanitizePath(input)).toBe('~/dev/secret/file.ts');
  });

  it('replaces multiple occurrences of the home directory', () => {
    const home = os.homedir();
    const input = `${home}/a and ${home}/b`;
    expect(sanitizePath(input)).toBe('~/a and ~/b');
  });

  it('returns falsy input unchanged', () => {
    expect(sanitizePath('')).toBe('');
  });

  it('leaves unrelated strings untouched', () => {
    expect(sanitizePath('no paths here')).toBe('no paths here');
  });
});

describe('sanitizeError', () => {
  it('extracts and sanitizes an Error message', () => {
    const home = os.homedir();
    const err = new Error(`failed at ${home}/x.ts`);
    expect(sanitizeError(err)).toBe('failed at ~/x.ts');
  });

  it('sanitizes a raw string error', () => {
    const home = os.homedir();
    expect(sanitizeError(`${home}/y`)).toBe('~/y');
  });

  it('returns a generic message for unknown error shapes', () => {
    expect(sanitizeError({ weird: true })).toBe('Unknown error');
    expect(sanitizeError(null)).toBe('Unknown error');
    expect(sanitizeError(42)).toBe('Unknown error');
  });

  it('strips a bot token from an error message', () => {
    const err = new Error('Failed: https://api.telegram.org/file/bot1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ/x');
    expect(sanitizeError(err)).not.toContain('AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ');
  });
});

describe('redactSecrets', () => {
  const token = '1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ';

  it('redacts a Telegram bot token inside a file URL', () => {
    const msg = `Command failed: curl -sS -- https://api.telegram.org/file/bot${token}/photos/file_1.jpg`;
    const out = redactSecrets(msg);
    expect(out).not.toContain('AAHdqTcv');
    expect(out).toContain('https://api.telegram.org/file/bot<telegram-token>/photos/file_1.jpg');
  });

  it('redacts a bare Telegram bot token', () => {
    expect(redactSecrets(`token is ${token}.`)).toBe('token is <telegram-token>.');
  });

  it('redacts common API keys, auth headers and URL credentials', () => {
    const out = redactSecrets([
      'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789AB',
      'AKIAABCDEFGHIJKLMNOP',
      'Authorization: Bearer abcdef0123456789abcdef',
      'https://alice:hunter22@example.com/repo.git',
      'DB_PASSWORD=correcthorsebattery',
    ].join('\n'));
    expect(out).not.toMatch(/abcdefghijklmnopqrstuvwxyz0123456789|ABCDEFGHIJKLMNOP|abcdef0123456789abcdef|hunter22|correcthorsebattery/);
    expect(out).toContain('https://<redacted>@example.com/repo.git');
    expect(out).toContain('DB_PASSWORD=<redacted>');
  });

  it('leaves ordinary text and token counts alone', () => {
    const text = 'used 1234567 input_tokens: 1234567 at 12:30';
    expect(redactSecrets(text)).toBe(text);
  });
});
