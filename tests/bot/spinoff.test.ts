/**
 * /spinoff <task> splits one task off into a thread of its own: the
 * conversation as it stands goes into a new thread, is compacted there around
 * the task, and the task goes in as the first prompt, while this thread
 * carries on unchanged. These tests drive the real handler, stores and
 * session manager, with home redirected to a scratch dir and the replays into
 * the new thread recorded instead of run.
 */

import { describe, it, expect, vi, afterAll } from 'vitest';
import type { Context } from 'grammy';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const mocked = { ...actual, homedir: () => process.env.TELECODER_TEST_HOME ?? actual.homedir() };
  return { ...mocked, default: mocked };
});
vi.mock('../../src/providers/provider-router.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/providers/provider-router.js')>()),
  clearConversation: vi.fn(),
}));
vi.mock('../../src/bot/handlers/command.handler.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/bot/handlers/command.handler.js')>()),
  restoreTopicAndRefreshBotName: vi.fn(async () => {}),
  getSessionTopic: vi.fn(() => undefined),
}));
const replayIntoThread = vi.fn(async (_update: unknown, _threadId: number, _changes: object) => {});
vi.mock('../../src/bot/middleware/queued-messages.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/bot/middleware/queued-messages.js')>()),
  replayIntoThread,
}));

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-spinoff-'));
process.env.TELECODER_TEST_HOME = home;
const PROJECT = path.join(home, 'project');
fs.mkdirSync(PROJECT);

const { handleSpinoffCommand, spinoffCompactFocus } = await import('../../src/bot/handlers/fork.handler.js');
const { sessionManager } = await import('../../src/claude/session-manager.js');
const { sessionJsonlPath } = await import('../../src/claude/session-jsonl.js');

afterAll(() => {
  delete process.env.TELECODER_TEST_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

const record = (uuid: string, type: 'user' | 'assistant', text: string) => JSON.stringify({
  type,
  uuid,
  sessionId: 'source-session',
  message: { role: type, content: [{ type: 'text', text }], ...(type === 'assistant' ? { stop_reason: 'end_turn' } : {}) },
});

/** A source chat one turn in, with a second prompt still running. */
function sourceChat(chatId: number): void {
  const sessionId = `source-${chatId}`;
  const file = sessionJsonlPath(PROJECT, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    record('u1', 'user', 'Plan features X, Y and Z'),
    record('a1', 'assistant', 'Here is the plan.'),
    record('u2', 'user', 'Do X and Y'),
  ].join('\n') + '\n');
  sessionManager.createSession(String(chatId), PROJECT).claudeSessionId = sessionId;
}

const uuidsIn = (file: string) => fs.readFileSync(file, 'utf-8')
  .split('\n')
  .filter(Boolean)
  .map((line) => (JSON.parse(line) as { uuid: string }).uuid);

function command(chatId: number, text: string, opts: { topics?: boolean } = {}) {
  const message = {
    message_id: 80,
    text,
    chat: { id: chatId, type: 'private' },
    entities: [
      { type: 'bot_command', offset: 0, length: '/spinoff'.length },
      { type: 'bold', offset: '/spinoff '.length, length: 'Z'.length },
    ],
  };
  return {
    chat: { id: chatId, type: 'private' },
    from: { id: 1 },
    message,
    update: { update_id: 1, message },
    me: { username: 'telecoder_bot', has_topics_enabled: opts.topics ?? true },
    api: {
      createForumTopic: vi.fn(async () => ({ message_thread_id: 21, name: '🍴 project', icon_color: 0 })),
      sendMessage: vi.fn(async () => ({ message_id: 600 })),
    },
    reply: vi.fn(async () => ({ message_id: 81 })),
  };
}

const asCtx = (fake: object) => fake as unknown as Context;
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('/spinoff', () => {
  it('forks into a new thread, compacts it around the task, then sends the task', async () => {
    const chatId = 701;
    sourceChat(chatId);
    const before = sessionManager.getSession(String(chatId))?.claudeSessionId;
    const ctx = command(chatId, '/spinoff Z now');

    await handleSpinoffCommand(asCtx(ctx));
    await flush();

    // The conversation up to the running turn, with its prompt and the note.
    const thread = sessionManager.getSession(`${chatId}:21`)!;
    const uuids = uuidsIn(sessionJsonlPath(PROJECT, thread.claudeSessionId!));
    expect(uuids.slice(0, 3)).toEqual(['u1', 'a1', 'u2']);
    expect(uuids).toHaveLength(4);
    expect(sessionManager.getSession(String(chatId))?.claudeSessionId).toBe(before);

    // The task is shown in the thread, and the link to it goes under the command.
    expect(ctx.api.sendMessage).toHaveBeenCalledWith(
      chatId,
      expect.stringContaining('You: Z now'),
      expect.objectContaining({ message_thread_id: 21 }),
    );
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('Spun off into'),
      expect.objectContaining({ reply_parameters: { message_id: 80 } }),
    );

    // Compact first, then the task under the You line's id, its bold kept in place.
    expect(replayIntoThread).toHaveBeenCalledTimes(2);
    expect(replayIntoThread.mock.calls[0][1]).toBe(21);
    expect(replayIntoThread.mock.calls[0][2]).toEqual({
      text: `/compact ${spinoffCompactFocus('Z now')}`,
      entities: [{ type: 'bot_command', offset: 0, length: '/compact'.length }],
    });
    expect(replayIntoThread.mock.calls[1][2]).toEqual({
      text: 'Z now',
      entities: [{ type: 'bold', offset: 0, length: 1 }],
      message_id: 600,
    });
  });

  it('asks for a task when there is none', async () => {
    replayIntoThread.mockClear();
    const ctx = command(702, '/spinoff');
    await handleSpinoffCommand(asCtx(ctx));
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Usage: /spinoff <task>'));
    expect(ctx.api.createForumTopic).not.toHaveBeenCalled();
    expect(replayIntoThread).not.toHaveBeenCalled();
  });

  it('says so on a bot without threads', async () => {
    const chatId = 703;
    sourceChat(chatId);
    const ctx = command(chatId, '/spinoff Z', { topics: false });
    await handleSpinoffCommand(asCtx(ctx));
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('threads are off'));
    expect(ctx.api.createForumTopic).not.toHaveBeenCalled();
  });
});
