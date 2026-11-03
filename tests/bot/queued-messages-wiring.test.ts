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
const { armReminders, forgetParkedMessages, initParkedMessages } = await import('../../src/bot/middleware/queued-messages.js');
const { config } = await import('../../src/config.js');

const CHAT = 1; // In the suite's ALLOWED_USER_IDS.
const GROUP = -1009990001; // In the suite's ALLOWED_GROUP_IDS.
const WAIT = { timeout: 5_000, interval: 20 };
const REMINDER = '🔔 You set this aside. Still want to send it?\n✏️ Edit your message above to change what goes out.';

let bot: Bot;
let pending: Promise<void>[];
let nextUpdateId = 1;
let nextMessageId = 100;

function chatFor(chatId: number) {
  return chatId === GROUP
    ? { id: GROUP, type: 'supergroup', title: 'g' }
    : { id: chatId, type: 'private', first_name: 'u' };
}

/** The entities Telegram would attach: a command at the start, and a mention per @handle. */
function entitiesFor(text: string) {
  const command = text.match(/^\/\w+/);
  return [
    ...(command ? [{ type: 'bot_command', offset: 0, length: command[0].length }] : []),
    ...[...text.matchAll(/@\w+/g)].map((m) => ({ type: 'mention', offset: m.index, length: m[0].length })),
  ];
}

function send(text: string, chatId = CHAT): number {
  const messageId = nextMessageId++;
  pending.push(bot.handleUpdate({
    update_id: nextUpdateId++,
    message: {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      chat: chatFor(chatId),
      from: { id: CHAT, is_bot: false, first_name: 'u' },
      text,
      entities: entitiesFor(text),
    },
  } as never));
  return messageId;
}

function edit(messageId: number, text: string, chatId = CHAT): Promise<void> {
  return bot.handleUpdate({
    update_id: nextUpdateId++,
    edited_message: {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      edit_date: Math.floor(Date.now() / 1000),
      chat: chatFor(chatId),
      from: { id: CHAT, is_bot: false, first_name: 'u' },
      text,
      entities: entitiesFor(text),
    },
  } as never);
}

const callsTo = (method: string) => fx.calls.filter((c) => c.method === method);
const ackFor = (messageId: number) => callsTo('sendMessage').find((c) =>
  (c.payload.reply_parameters as { message_id?: number } | undefined)?.message_id === messageId);
const reminderFor = (messageId: number) => callsTo('sendMessage').find((c) => c.payload.text === REMINDER
  && (c.payload.reply_parameters as { message_id?: number } | undefined)?.message_id === messageId);

function tapButton(data: string, chatId = CHAT): Promise<void> {
  return bot.handleUpdate({
    update_id: nextUpdateId++,
    callback_query: {
      id: `cb${nextUpdateId}`,
      from: { id: CHAT, is_bot: false, first_name: 'u' },
      chat_instance: 'x',
      data,
      message: {
        message_id: 4000,
        date: 0,
        chat: chatFor(chatId),
        from: { id: 123456789, is_bot: true, first_name: 'probe' },
        text: '⏳',
      },
    },
  } as never);
}

function tapTakeBack(messageId: number): Promise<void> {
  return tapButton(`queued:${messageId}`);
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
  sessionManager.createSession(String(GROUP), fs.mkdtempSync(`${process.env.TELECODER_TEST_HOME}/project-`));
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

  it('asks about a message set aside once the turn is over, and delivers it on Send', async () => {
    send('first');
    await vi.waitFor(() => expect(fx.prompts).toEqual(['first']), WAIT);
    const second = send('second');
    await vi.waitFor(() => expect(ackFor(second)).toBeDefined(), WAIT);

    await tapButton(`queued:park:${second}`);
    expect(reminderFor(second)).toBeUndefined();

    fx.finish.get('first')!();
    await vi.waitFor(() => expect(reminderFor(second)).toBeDefined(), WAIT);
    // Below the reply, which is the point of waiting for the turn to be over.
    const reminderAt = callsTo('sendMessage').indexOf(reminderFor(second)!);
    expect(callsTo('sendMessage').findIndex((c) => String(c.payload.text).includes('answer to first'))).toBeLessThan(reminderAt);
    expect(fx.prompts).toEqual(['first']);

    await tapButton(`queued:send:${second}`);
    await vi.waitFor(() => expect(fx.prompts).toEqual(['first', 'second']), WAIT);
  });

  it('sets an idea aside with /later during a turn, and delivers it without the command on Send', async () => {
    send('first');
    await vi.waitFor(() => expect(fx.prompts).toEqual(['first']), WAIT);
    const idea = send('/later and the tests');
    await vi.waitFor(() => expect(ackFor(idea)?.payload.text).toBe("🔔 Set aside. I'll ask when Claude is done."), WAIT);
    expect(reminderFor(idea)).toBeUndefined();

    fx.finish.get('first')!();
    await vi.waitFor(() => expect(reminderFor(idea)).toBeDefined(), WAIT);
    expect(fx.prompts).toEqual(['first']);

    await tapButton(`queued:send:${idea}`);
    await vi.waitFor(() => expect(fx.prompts).toEqual(['first', 'and the tests']), WAIT);
  });

  it('leaves the chat free while a message is set aside', async () => {
    send('first');
    await vi.waitFor(() => expect(fx.prompts).toEqual(['first']), WAIT);
    const second = send('second');
    await vi.waitFor(() => expect(ackFor(second)).toBeDefined(), WAIT);
    await tapButton(`queued:park:${second}`);
    fx.finish.get('first')!();
    await vi.waitFor(() => expect(reminderFor(second)).toBeDefined(), WAIT);

    send('third');
    await vi.waitFor(() => expect(fx.prompts).toEqual(['first', 'third']), WAIT);
  });

  it("sends a message the handlers would otherwise call stale, after a restart", async () => {
    // Saved by an earlier process: the handlers ignore anything dated before this
    // one started, and every message saved to disk ends up that old.
    const stale = nextMessageId++;
    const file = `${process.env.TELECODER_TEST_HOME}/.claudegram/parked-messages-123456789.json`;
    fs.mkdirSync(`${process.env.TELECODER_TEST_HOME}/.claudegram`, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      messages: [{
        chatId: CHAT,
        sessionKey: String(CHAT),
        messageId: stale,
        senderId: CHAT,
        update: {
          update_id: 1,
          message: {
            message_id: stale,
            date: 1_000,
            chat: chatFor(CHAT),
            from: { id: CHAT, is_bot: false, first_name: 'u' },
            text: 'from before the restart',
          },
        },
      }],
    }));

    forgetParkedMessages();
    initParkedMessages(bot);
    armReminders();
    await vi.waitFor(() => expect(reminderFor(stale)).toBeDefined(), WAIT);

    await tapButton(`queued:send:${stale}`);
    await vi.waitFor(() => expect(fx.prompts).toEqual(['from before the restart']), WAIT);
  });

  it('gets a message sent in a group back past the mention gate, without the mention', async () => {
    send('@probe_bot first', GROUP);
    await vi.waitFor(() => expect(fx.prompts).toEqual(['first']), WAIT);
    const second = send('@probe_bot second', GROUP);
    await vi.waitFor(() => expect(ackFor(second)).toBeDefined(), WAIT);
    await tapButton(`queued:park:${second}`, GROUP);

    fx.finish.get('first')!();
    await vi.waitFor(() => expect(reminderFor(second)).toBeDefined(), WAIT);
    await tapButton(`queued:send:${second}`, GROUP);

    await vi.waitFor(() => expect(fx.prompts).toEqual(['first', 'second']), WAIT);
  });

  it('takes the mention out of an edit too, which the gate passes untouched', async () => {
    send('@probe_bot first', GROUP);
    await vi.waitFor(() => expect(fx.prompts).toEqual(['first']), WAIT);
    const second = send('@probe_bot second', GROUP);
    await vi.waitFor(() => expect(ackFor(second)).toBeDefined(), WAIT);
    await tapButton(`queued:park:${second}`, GROUP);

    await edit(second, '@probe_bot second, fixed', GROUP);
    fx.finish.get('first')!();
    await vi.waitFor(() => expect(reminderFor(second)).toBeDefined(), WAIT);
    await tapButton(`queued:send:${second}`, GROUP);

    await vi.waitFor(() => expect(fx.prompts).toEqual(['first', 'second, fixed']), WAIT);
  });

  describe('with messages merged by the batcher', () => {
    beforeEach(() => { config.MESSAGE_BATCH_TIMEOUT_MS = 30; });
    afterEach(() => { config.MESSAGE_BATCH_TIMEOUT_MS = 0; });

    it('sends the whole of a merged message set aside', async () => {
      send('first');
      await vi.waitFor(() => expect(fx.prompts).toEqual(['first']), WAIT);
      const merged = send('part one');
      send('part two');
      await vi.waitFor(() => expect(ackFor(merged)).toBeDefined(), WAIT);
      await tapButton(`queued:park:${merged}`);

      fx.finish.get('first')!();
      await vi.waitFor(() => expect(reminderFor(merged)).toBeDefined(), WAIT);
      await tapButton(`queued:send:${merged}`);

      await vi.waitFor(() => expect(fx.prompts).toEqual(['first', 'part one\npart two']), WAIT);
    });

    it("doesn't let an edit to one part replace the whole of a merged message", async () => {
      send('first');
      await vi.waitFor(() => expect(fx.prompts).toEqual(['first']), WAIT);
      const merged = send('part one');
      send('part two');
      await vi.waitFor(() => expect(ackFor(merged)).toBeDefined(), WAIT);

      await edit(merged, 'part one, fixed');
      fx.finish.get('first')!();

      await vi.waitFor(() => expect(fx.prompts).toEqual(['first', 'part one\npart two']), WAIT);
    });
  });
});
