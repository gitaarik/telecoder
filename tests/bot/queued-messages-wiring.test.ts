/**
 * The queue's middleware as src/bot/bot.ts actually assembles it.
 *
 * The behaviour depends on where each piece sits relative to sequentialize, and
 * that lives in createBot, so this runs the real one: real auth, real handlers,
 * the real streaming pipeline. Only Telegram and the provider are stood in for.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import { Api, type Bot } from 'grammy';

const fx = vi.hoisted(() => {
  // Before any import: the state directories are resolved as modules load.
  const nodeFs = process.getBuiltinModule('fs');
  const nodeOs = process.getBuiltinModule('os');
  const nodePath = process.getBuiltinModule('path');
  process.env.TELECODER_TEST_HOME = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'telecoder-queued-'));
  return {
    calls: [] as { method: string; payload: Record<string, unknown>; sentId?: number }[],
    /** What reached the provider, which is to say Claude. */
    prompts: [] as string[],
    finish: new Map<string, () => void>(),
    nextId: 5000,
  };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: actual, homedir: () => process.env.TELECODER_TEST_HOME ?? actual.homedir() };
});

vi.mock('../../src/providers/provider-router.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/providers/provider-router.js')>();
  return {
    ...actual,
    sendToAgent: (_key: string, message: string, options?: { abortController?: AbortController }) =>
      new Promise((resolve) => {
        fx.prompts.push(message);
        fx.finish.set(message, () => resolve({ text: `answer to ${message}`, toolsUsed: [] }));
        options?.abortController?.signal.addEventListener('abort', () => {
          resolve({ text: '🛑 Cancelled.', toolsUsed: [] });
        });
      }),
  };
});

// A real side call to Haiku for the topic, on every message.
vi.mock('../../src/claude/auto-topic-haiku.js', () => ({ summarizeTopicWithHaiku: async () => null }));

// Nothing here spawns a claude to call back, and a listener would outlive the test.
vi.mock('../../src/claude/ipc-server.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/claude/ipc-server.js')>();
  return { ...actual, startIpcServer: async () => ({ port: 45678 }) };
});

const { createBot } = await import('../../src/bot/bot.js');
const { sessionManager } = await import('../../src/claude/session-manager.js');

const CHAT = 1; // In the suite's ALLOWED_USER_IDS.
const WAIT = { timeout: 5_000, interval: 20 };

let bot: Bot;
let pending: Promise<void>[];
let nextUpdateId = 1;
let nextMessageId = 100;

function send(text: string): number {
  const messageId = nextMessageId++;
  const command = text.match(/^\/\w+/);
  pending.push(bot.handleUpdate({
    update_id: nextUpdateId++,
    message: {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: CHAT, type: 'private', first_name: 'u' },
      from: { id: CHAT, is_bot: false, first_name: 'u' },
      text,
      ...(command ? { entities: [{ type: 'bot_command', offset: 0, length: command[0].length }] } : {}),
    },
  } as never));
  return messageId;
}

const callsTo = (method: string) => fx.calls.filter((c) => c.method === method);
const ackFor = (messageId: number) => callsTo('sendMessage').find((c) =>
  (c.payload.reply_parameters as { message_id?: number } | undefined)?.message_id === messageId);

function tapTakeBack(messageId: number): Promise<void> {
  return bot.handleUpdate({
    update_id: nextUpdateId++,
    callback_query: {
      id: `cb${nextUpdateId}`,
      from: { id: CHAT, is_bot: false, first_name: 'u' },
      chat_instance: 'x',
      data: `queued:${messageId}`,
      message: {
        message_id: 4000,
        date: 0,
        chat: { id: CHAT, type: 'private', first_name: 'u' },
        from: { id: 123456789, is_bot: true, first_name: 'probe' },
        text: '⏳',
      },
    },
  } as never);
}

beforeAll(async () => {
  // createBot sets the command menu before there's a chance to stub the API.
  vi.spyOn(Api.prototype, 'setMyCommands').mockResolvedValue(true);
  bot = await createBot();
  bot.botInfo = {
    id: 123456789,
    is_bot: true,
    first_name: 'probe',
    username: 'probe_bot',
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
  } as never;
  bot.api.config.use(async (_prev, method, payload) => {
    const call: (typeof fx.calls)[number] = { method, payload: payload as Record<string, unknown> };
    fx.calls.push(call);
    if (method === 'sendMessage') {
      call.sentId = fx.nextId++;
      return {
        ok: true,
        result: { message_id: call.sentId, date: 0, chat: { id: CHAT, type: 'private' } },
      } as never;
    }
    return { ok: true, result: true } as never;
  });
  sessionManager.createSession(String(CHAT), fs.mkdtempSync(`${process.env.TELECODER_TEST_HOME}/project-`));
});

afterAll(() => {
  fs.rmSync(process.env.TELECODER_TEST_HOME!, { recursive: true, force: true });
  delete process.env.TELECODER_TEST_HOME;
  vi.restoreAllMocks();
});

beforeEach(() => {
  fx.calls.length = 0;
  fx.prompts.length = 0;
  fx.finish.clear();
  pending = [];
});

afterEach(async () => {
  // Let every turn this test left running finish, then the chain behind it.
  for (let i = 0; i < 5; i++) {
    for (const finish of fx.finish.values()) finish();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await Promise.all(pending);
});

describe('the bot as assembled', () => {
  it('tells a message sent during a turn that it is waiting, then delivers it', async () => {
    send('first');
    await vi.waitFor(() => expect(fx.prompts).toEqual(['first']), WAIT);

    const second = send('second');
    await vi.waitFor(() => expect(ackFor(second)?.payload.text).toBe('⏳ Queued behind the running turn.'), WAIT);
    expect(fx.prompts).toEqual(['first']);

    fx.finish.get('first')!();
    await vi.waitFor(() => expect(fx.prompts).toEqual(['first', 'second']), WAIT);
    await vi.waitFor(() => expect(callsTo('deleteMessage').map((c) => c.payload.message_id))
      .toContain(ackFor(second)?.sentId), WAIT);
  });

  it('never delivers a message that was taken back, and carries on with the turn', async () => {
    send('first');
    await vi.waitFor(() => expect(fx.prompts).toEqual(['first']), WAIT);

    const second = send('second');
    await vi.waitFor(() => expect(ackFor(second)).toBeDefined(), WAIT);
    await tapTakeBack(second);

    expect(callsTo('answerCallbackQuery').at(-1)?.payload.text).toBe('Taken back.');
    await vi.waitFor(() => expect(callsTo('editMessageText').map((c) => c.payload.text))
      .toContain('🗑 Taken back before it reached Claude.'), WAIT);

    fx.finish.get('first')!();
    await Promise.all(pending);
    expect(fx.prompts).toEqual(['first']);
  });

  it('has /cancel stop the turn and drop what was waiting behind it', async () => {
    send('first');
    await vi.waitFor(() => expect(fx.prompts).toEqual(['first']), WAIT);

    const second = send('second');
    await vi.waitFor(() => expect(ackFor(second)).toBeDefined(), WAIT);

    send('/cancel');
    await Promise.all(pending);

    expect(fx.prompts).toEqual(['first']);
    expect(callsTo('sendMessage').map((c) => c.payload.text)).toContain('🛑 Cancelled\\. \\(1 queued request cleared\\)');
  });

  it('answers the take-back button while the turn is still running', async () => {
    // Registered behind sequentialize, the tap would wait for the very turn it
    // has to get past, and this would hang until that turn ended.
    send('first');
    await vi.waitFor(() => expect(fx.prompts).toEqual(['first']), WAIT);

    const second = send('second');
    await vi.waitFor(() => expect(ackFor(second)).toBeDefined(), WAIT);

    await tapTakeBack(second);
    expect(fx.finish.has('first')).toBe(true);
    expect(callsTo('answerCallbackQuery')).toHaveLength(1);
  });
});
