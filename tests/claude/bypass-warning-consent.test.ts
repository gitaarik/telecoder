/**
 * The answer to Claude Code's bypass warning, carried into the pty.
 *
 * Accepting the warning records it in ~/.claude/settings.json, a file the pty's
 * `--setting-sources project,local` keeps claude from reading, so without this
 * the warning opens on every new pty. Two properties matter: an acceptance on
 * file reaches claude, including one made since the last spawn, and the bot
 * never makes one up for an account that hasn't accepted.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as realOs from 'os';

// The answer is read from os.homedir()/.claude; point it at a scratch dir so the
// suite never depends on the developer's real settings.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: actual, homedir: () => process.env.TELECODER_TEST_HOME ?? actual.homedir() };
});

const home = fs.mkdtempSync(path.join(realOs.tmpdir(), 'telecoder-bypass-'));
process.env.TELECODER_TEST_HOME = home;

const settingsFile = path.join(home, '.claude', 'settings.json');

// Imported after the mock so the read resolves under the scratch home.
const { buildSettingsJson } = await import('../../src/claude/pty-spawn-config.js');

function writeUserSettings(content: string): void {
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, content);
}

function carriedConsent(): unknown {
  return JSON.parse(buildSettingsJson(1234)).skipDangerousModePermissionPrompt;
}

beforeEach(() => {
  fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true });
});

afterAll(() => {
  delete process.env.TELECODER_TEST_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('the bypass warning in the --settings payload', () => {
  it('carries an acceptance on file', () => {
    writeUserSettings(JSON.stringify({ model: 'opus', skipDangerousModePermissionPrompt: true }));
    expect(carriedConsent()).toBe(true);
  });

  it('counts a "Yes" given since the last spawn', () => {
    writeUserSettings(JSON.stringify({ model: 'opus' }));
    expect(carriedConsent()).toBeUndefined();

    writeUserSettings(JSON.stringify({ model: 'opus', skipDangerousModePermissionPrompt: true }));
    expect(carriedConsent()).toBe(true);
  });

  it('leaves the key out when the account has no settings file', () => {
    expect(carriedConsent()).toBeUndefined();
  });

  it('leaves the key out when the settings say nothing about it', () => {
    writeUserSettings(JSON.stringify({ model: 'opus' }));
    expect(carriedConsent()).toBeUndefined();
  });

  it.each([
    ['false', 'false'],
    ['a string', '"true"'],
    ['a number', '1'],
  ])('does not take %s for an acceptance', (_name, value) => {
    writeUserSettings(`{"skipDangerousModePermissionPrompt": ${value}}`);
    expect(carriedConsent()).toBeUndefined();
  });

  it.each([
    ['does not parse', '{"skipDangerousModePermissionPrompt": true'],
    ['is not an object', 'null'],
  ])('survives a settings file that %s', (_name, content) => {
    writeUserSettings(content);
    expect(carriedConsent()).toBeUndefined();
  });

  it('brings nothing else from the user settings with it', () => {
    writeUserSettings(JSON.stringify({ editorMode: 'vim', skipDangerousModePermissionPrompt: true }));
    expect(JSON.parse(buildSettingsJson(1234)).editorMode).toBeUndefined();
  });

  it('keeps the hooks either way, since the permission gate rides in them', () => {
    expect(JSON.parse(buildSettingsJson(1234)).hooks.PreToolUse).toHaveLength(1);

    writeUserSettings(JSON.stringify({ skipDangerousModePermissionPrompt: true }));
    expect(JSON.parse(buildSettingsJson(1234)).hooks.PreToolUse).toHaveLength(1);
  });
});
