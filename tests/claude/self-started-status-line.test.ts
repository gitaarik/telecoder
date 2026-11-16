/**
 * What the status line says under the reply from a turn claude started itself,
 * when a background task reported back.
 *
 * No turn of TeleCoder's ran, so there is no prompt and no response to build
 * the line from. The prompts have to be the ones the user sent, not the report
 * the task filed in their place, and the context has to be what this turn
 * left: the cached figure is from the turn before, which is the one the task
 * was started in.
 *
 * Where the line goes is self-started-reply.test.ts. This runs the real relay
 * into the real status line, off a session log on disk, with only Telegram
 * stood in for.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Bot } from 'grammy';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const mocked = { ...actual, homedir: () => process.env.TELECODER_TEST_HOME ?? actual.homedir() };
  return { ...mocked, default: mocked };
});

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-self-status-'));
process.env.TELECODER_TEST_HOME = home;
const PROJECT = path.join(home, 'shop');
fs.mkdirSync(PROJECT);

const { setMonitorRelayBot, onAsyncToolArmed, markTurnEnd, teardown } = await import('../../src/claude/monitor-relay.js');
const { messageSender } = await import('../../src/telegram/message-sender.js');
const { sessionManager } = await import('../../src/claude/session-manager.js');
const { sessionJsonlPath } = await import('../../src/claude/session-jsonl.js');
const { userPreferences } = await import('../../src/providers/user-preferences.js');
const { getPtyProvider } = await import('../../src/providers/claude-provider.js');

const CHAT = 4242;
const KEY = String(CHAT);
const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
/** vi.waitFor's default second is tight for a file watcher under a busy suite. */
const WAIT = { timeout: 3_000 };

/** The reply and everything the bot sent itself, in the order they reached the chat. */
const chat: string[] = [];

let uuid = 0;
const prompt = (text: string) => ({
  type: 'user',
  uuid: `r${uuid++}`,
  message: { role: 'user', content: [{ type: 'text', text }] },
});
/** A reply with the usage Claude Code records on it: `context` tokens, nearly all of them cache reads. */
const reply = (text: string, context: number) => ({
  type: 'assistant',
  uuid: `r${uuid++}`,
  message: {
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'text', text }],
    usage: { input_tokens: 2, output_tokens: 320, cache_read_input_tokens: context - 322, cache_creation_input_tokens: 0 },
  },
});
/** What a finished subagent files in the user's place, which starts claude on a turn of its own. */
const taskReport = {
  type: 'user',
  uuid: `r${uuid++}`,
  origin: { kind: 'task-notification' },
  message: {
    role: 'user',
    content: [{
      type: 'text',
      text: '<task-notification><task-id>task_1</task-id><tool-use-id>toolu_01</tool-use-id>'
        + '<status>completed</status><summary>Agent "review the diff" completed</summary></task-notification>',
    }],
  },
};
/** The record Claude Code closes every turn with. */
const turnClosed = { type: 'system', subtype: 'turn_duration', durationMs: 22789 };

const logFile = sessionJsonlPath(PROJECT, SESSION_ID);
const append = (...recs: object[]) => fs.appendFileSync(logFile, recs.map((r) => JSON.stringify(r) + '\n').join(''));

beforeAll(() => {
  let nextId = 100;
  setMonitorRelayBot({
    api: {
      sendMessage: vi.fn(async (_chatId: number, text: string) => {
        chat.push(text);
        return { message_id: nextId++ };
      }),
      editMessageText: vi.fn(async () => true),
    },
  } as unknown as Bot);
  // The reply goes through the sender, which would chunk it.
  vi.spyOn(messageSender, 'sendMessage').mockImplementation(async (_ctx, text) => {
    chat.push(text);
    return nextId++;
  });

  userPreferences.setShowStatusLine(CHAT, true);
  userPreferences.setShowPromptInStatusLine(CHAT, true);
});

afterAll(async () => {
  teardown(KEY);
  await new Promise((resolve) => setTimeout(resolve, 20));
  vi.restoreAllMocks();
  delete process.env.TELECODER_TEST_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('the status line under a reply claude started on its own', () => {
  it("lists the user's prompts and the context that turn left", async () => {
    // Two turns of TeleCoder's, the second starting a reviewer in the background.
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, '');
    append(
      prompt('Why does checkout fail?'), reply('The cart total is stale.', 80_000),
      prompt('Review the fix in the background'), reply('Started a reviewer.', 100_000),
    );
    sessionManager.createSession(KEY, PROJECT);
    sessionManager.setClaudeSessionId(KEY, SESSION_ID);
    // What that turn left cached, as /status and the status line under it read it.
    expect(getPtyProvider().getCachedUsage(KEY)?.cacheReadTokens).toBe(100_000 - 322);
    onAsyncToolArmed('subagent', KEY, PROJECT, SESSION_ID, 'review the diff', 'toolu_01');
    markTurnEnd(KEY);
    chat.length = 0;

    // The reviewer reports back, and claude answers on its own.
    append(taskReport, reply('The review is back: one finding, now fixed.', 250_000), turnClosed);

    await vi.waitFor(() => expect(chat.some((text) => text.includes('📁'))).toBe(true), WAIT);
    const answered = chat.indexOf('The review is back: one finding, now fixed.');
    expect(answered).toBeGreaterThanOrEqual(0);
    // Straight under the reply, and the last thing in the chat.
    expect(chat.slice(answered + 1)).toEqual([[
      '▸ Why does checkout fail?',
      '▸ Review the fix in the background',
      '',
      '📁 shop · 🧠 Auto · 🤖 opus-5-5 · 🟡 25% · 💰 $0.00',
    ].join('\n')]);

    // And /status and /context now agree with it.
    expect(getPtyProvider().getCachedUsage(KEY)?.cacheReadTokens).toBe(250_000 - 322);
  });
});
