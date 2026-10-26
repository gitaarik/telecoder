/**
 * A restart doesn't change which conversation a chat is in: every chat used
 * within the past week carries straight on, with no "continue or start
 * fresh?" to answer first.
 *
 * Drives the real session manager and history store, with home redirected to
 * a scratch dir so nothing here touches the real ~/.claudegram.
 */

import { describe, it, expect, vi, afterAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const mocked = { ...actual, homedir: () => process.env.TELECODER_TEST_HOME ?? actual.homedir() };
  return { ...mocked, default: mocked };
});

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-continue-'));
process.env.TELECODER_TEST_HOME = home;

const { sessionManager } = await import('../../src/claude/session-manager.js');
const { autoContinueOnStartup } = await import('../../src/startup/auto-continue.js');

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  delete process.env.TELECODER_TEST_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * A chat last used `idleMs` ago, whose in-memory session a restart has since
 * dropped. `key` must be a chat the test env allows (users 1–3, one group).
 */
function idleChat(key: string, idleMs: number, claudeSessionId?: string): void {
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() - idleMs);
  sessionManager.createSession(key, home);
  if (claudeSessionId) sessionManager.setClaudeSessionId(key, claudeSessionId);
  vi.useRealTimers();
  sessionManager.clearSession(key);
}

describe('starting up', () => {
  it('puts a chat idle for hours straight back in its conversation', () => {
    idleChat('1', 3 * HOUR, 'hours-old');

    autoContinueOnStartup();

    expect(sessionManager.getSession('1')?.claudeSessionId).toBe('hours-old');
  });

  it('does the same for one idle most of a week', () => {
    idleChat('2', 6 * DAY, 'days-old');

    autoContinueOnStartup();

    expect(sessionManager.getSession('2')?.claudeSessionId).toBe('days-old');
  });

  it('leaves one quiet for over a week to an explicit /continue', () => {
    idleChat('3', 8 * DAY, 'weeks-old');

    autoContinueOnStartup();

    expect(sessionManager.getSession('3')).toBeUndefined();
  });
});

describe('the first message after a restart', () => {
  it('gets back a project that was picked hours ago but never talked in', () => {
    // A /clear, say: no Claude session yet, so startup leaves it to the message.
    idleChat('-1009990001', 3 * HOUR);
    autoContinueOnStartup();
    expect(sessionManager.getSession('-1009990001')).toBeUndefined();

    const { session, restored } = sessionManager.getOrRestoreSession('-1009990001');

    expect(restored).toBe(true);
    expect(session?.workingDirectory).toBe(home);
    expect(session?.claudeSessionId).toBeUndefined();
  });
});
