/**
 * The status line names the project. A bot moves between projects, and its
 * display name only says where it is now, so this is what tells you which
 * project an older answer belongs to when you scroll back.
 *
 * Drives the real sendStatusLine, with sessions and the chat's preferences kept
 * under a scratch home, so nothing here touches the real ~/.claudegram.
 */

import { describe, it, expect, vi, afterAll } from 'vitest';
import type { Context } from 'grammy';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentUsage } from '../../src/providers/types.js';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const mocked = { ...actual, homedir: () => process.env.TELECODER_TEST_HOME ?? actual.homedir() };
  return { ...mocked, default: mocked };
});

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-status-project-'));
process.env.TELECODER_TEST_HOME = home;

const { sendStatusLine } = await import('../../src/bot/handlers/command/settings.js');
const { userPreferences } = await import('../../src/providers/user-preferences.js');
const { sessionManager } = await import('../../src/claude/session-manager.js');

afterAll(() => {
  delete process.env.TELECODER_TEST_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

const USAGE: AgentUsage = {
  inputTokens: 500,
  outputTokens: 1_000,
  cacheReadTokens: 119_000,
  cacheWriteTokens: 0,
  totalCostUsd: 0.1234,
  sessionCostUsd: 0,
  sessionCostTurns: 0,
  contextWindow: 1_000_000,
  numTurns: 3,
  model: 'claude-opus-5-5',
};

function projectDir(name: string): string {
  const dir = path.join(home, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

let nextChat = 8000;

/** A chat with the status line on, and nothing else on it that would get in the way. */
function chat(): { chatId: number; key: string } {
  const chatId = nextChat++;
  userPreferences.setShowStatusLine(chatId, true);
  return { chatId, key: String(chatId) };
}

/** The status line a turn closes with. */
async function statusLine(chatId: number, key: string, usage?: AgentUsage): Promise<string> {
  const reply = vi.fn(async (_text: string, _opts?: unknown) => ({}));
  await sendStatusLine({ reply } as unknown as Context, chatId, key, usage);
  expect(reply).toHaveBeenCalledTimes(1);
  return reply.mock.calls[0]![0];
}

describe('the project on the status line', () => {
  it('leads the line of stats', async () => {
    const { chatId, key } = chat();
    sessionManager.createSession(key, projectDir('telecoder'));

    expect(await statusLine(chatId, key, USAGE))
      .toBe('_📁 telecoder · 🧠 Auto · 🤖 opus\\-5\\-5 · 📊 12% · 💰 $0\\.12_');
  });

  it('is on the line before a turn has given it any figures', async () => {
    const { chatId, key } = chat();
    sessionManager.createSession(key, projectDir('telecoder'));

    expect(await statusLine(chatId, key)).toBe('_📁 telecoder · 🧠 Auto_');
  });

  it('is escaped, so a name full of punctuation still sends', async () => {
    const { chatId, key } = chat();
    sessionManager.createSession(key, projectDir('my_app.v2 (old)'));

    expect(await statusLine(chatId, key)).toBe('_📁 my\\_app\\.v2 \\(old\\) · 🧠 Auto_');
  });

  it('follows a switch, naming where the next message goes', async () => {
    const { chatId, key } = chat();
    sessionManager.createSession(key, projectDir('telecoder'));
    sessionManager.setWorkingDirectory(key, projectDir('triallab'));

    expect(await statusLine(chatId, key)).toBe('_📁 triallab · 🧠 Auto_');
  });

  it('shows the whole path for a directory with no name of its own', async () => {
    const { chatId, key } = chat();
    sessionManager.createSession(key, '/');

    expect(await statusLine(chatId, key)).toBe('_📁 / · 🧠 Auto_');
  });

  it('is left out when the chat has no session', async () => {
    const { chatId, key } = chat();

    expect(await statusLine(chatId, key)).toBe('_🧠 Auto_');
  });
});
