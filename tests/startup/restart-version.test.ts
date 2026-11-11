/**
 * Whichever message a restart ends in, it says which build came back: the
 * session recap, or the plain confirmation for a chat that didn't get one.
 * /botstatus says the same at any other time.
 *
 * Drives the real session manager and history store, with home redirected to
 * a scratch dir so nothing here touches the real ~/.telecoder.
 */

import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest';
import type { Bot, Context } from 'grammy';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const mocked = { ...actual, homedir: () => process.env.TELECODER_TEST_HOME ?? actual.homedir() };
  return { ...mocked, default: mocked };
});

const running = vi.hoisted(() => ({ build: null as string | null }));
vi.mock('../../src/utils/build-info.js', () => ({ describeRunningBuild: () => running.build }));

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-version-'));
process.env.TELECODER_TEST_HOME = home;

const { getReloadMarkerPath } = await import('../../src/config.js');
const { sessionManager } = await import('../../src/claude/session-manager.js');
const { autoResumeAfterReload } = await import('../../src/startup/auto-resume.js');
const { notifyRestartComplete } = await import('../../src/startup/notices.js');
const { handleBotStatus } = await import('../../src/bot/handlers/command/admin.js');

/** A subject with what markdown would read as formatting. */
const BUILD = 'abc1234 fix: keep (some) things_tidy. (built just now)';

const sendMessage = vi.fn(async (..._args: unknown[]) => ({ message_id: 1 }));
const bot = { api: { sendMessage, setMyName: vi.fn(async () => true) } } as unknown as Bot;

const sentTexts = () => sendMessage.mock.calls.map((call) => call[1] as string);

/** A chat used moments ago, whose in-memory session the restart has dropped. */
function recentChat(key: string): void {
  sessionManager.createSession(key, home);
  sessionManager.setClaudeSessionId(key, `session-${key}`);
  sessionManager.clearSession(key);
}

function leaveReloadMarker(): void {
  fs.mkdirSync(path.dirname(getReloadMarkerPath()), { recursive: true });
  fs.writeFileSync(getReloadMarkerPath(), JSON.stringify({ timestamp: new Date().toISOString() }));
}

beforeEach(() => {
  sendMessage.mockClear();
  running.build = BUILD;
});

afterAll(() => {
  delete process.env.TELECODER_TEST_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('the session recap after a restart', () => {
  it('names the build verbatim, with no parse mode', async () => {
    recentChat('1');
    leaveReloadMarker();

    await autoResumeAfterReload(bot, new Set());

    const header = sentTexts().find((text) => text.startsWith('✅ Reloaded'));
    expect(header).toContain(`\nVersion: ${BUILD}`);
    expect(sendMessage.mock.calls[0][2]).not.toHaveProperty('parse_mode');
    expect(sendMessage.mock.calls[0][2]).toMatchObject({ entities: [] });
  });

  it('leaves the line out when the build is not stamped', async () => {
    running.build = null;
    recentChat('2');
    leaveReloadMarker();

    await autoResumeAfterReload(bot, new Set());

    expect(sentTexts().join('\n')).not.toContain('Version');
  });
});

describe('the restart confirmation', () => {
  it('names the build, unescaped since it is sent as plain text', async () => {
    recentChat('1');

    await notifyRestartComplete(bot, new Set());

    expect(sentTexts()).toEqual([`✅ TeleCoder restarted and is ready.\nVersion: ${BUILD}`]);
    expect(sendMessage.mock.calls[0][2]).not.toHaveProperty('parse_mode');
  });

  it('leaves the line out when the build is not stamped', async () => {
    running.build = null;
    recentChat('1');

    await notifyRestartComplete(bot, new Set());

    expect(sentTexts()).toEqual(['✅ TeleCoder restarted and is ready.']);
  });
});

describe('/botstatus', () => {
  const botStatus = async (): Promise<string> => {
    const reply = vi.fn(async (..._args: unknown[]) => ({}));
    await handleBotStatus({ reply, chat: { id: 1, type: 'private' } } as unknown as Context);
    return reply.mock.calls[0][0] as string;
  };

  it('names the build verbatim, with only the label in bold', async () => {
    const reply = vi.fn(async (..._args: unknown[]) => ({}));
    await handleBotStatus({ reply, chat: { id: 1, type: 'private' } } as unknown as Context);
    const [text, other] = reply.mock.calls[0] as [string, { entities: { type: string; offset: number; length: number }[] }];

    expect(text).toContain(`\nVersion: ${BUILD}\n`);
    expect(other).not.toHaveProperty('parse_mode');
    const bold = other.entities.filter((e) => e.type === 'bold').map((e) => text.slice(e.offset, e.offset + e.length));
    expect(bold).toContain('Version:');
    expect(bold.some((t) => t.includes('abc1234'))).toBe(false);
  });

  it('leaves the line out when the build is not stamped', async () => {
    running.build = null;

    expect(await botStatus()).not.toContain('Version');
  });
});
