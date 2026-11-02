/**
 * What happens to a message that has to wait, and taking one back.
 *
 * Telegram never tells a bot about a deleted message, so the button on the ack
 * is the only way to recall one. These drive real grammY, the real sequentialize
 * and request queue, and the real /cancel. Only Telegram and the pty are stood in
 * for. Sequentialize is the point: a handler awaits its whole turn, so nothing a
 * handler does can see a message waiting behind it. That used to leave the
 * message with no ack, and let /cancel stop the turn and so release the message.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Bot, GrammyError, type Context } from 'grammy';
import { sequentialize } from '@grammyjs/runner';

const fx = vi.hoisted(() => ({
  calls: [] as { method: string; payload: Record<string, unknown> }[],
  /** Hold back sendMessage responses until released. */
  sendGate: null as Promise<void> | null,
  /** What a sendMessage should throw, if its text matches. */
  sendFailure: null as { text: string; error: Error } | null,
  nextId: 5000,
  pty: {
    isSessionGenerating: (() => false) as (key: string) => boolean,
    interruptOwnTurn: (() => false) as (key: string) => boolean,
  },
  relay: {
    selfStartedTurn: false,
    repliesSent: Promise.resolve() as Promise<void>,
  },
}));

// The real tracker writes a marker into ~/.claudegram for every turn.
vi.mock('../../src/claude/in-flight-tracker.js', () => ({
  markInFlight: () => {},
  clearInFlight: () => {},
}));

vi.mock('../../src/providers/claude-provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/providers/claude-provider.js')>();
  return { ...actual, getPtyProvider: () => fx.pty };
});

vi.mock('../../src/claude/monitor-relay.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/claude/monitor-relay.js')>();
  return {
    ...actual,
    hasSelfStartedTurn: () => fx.relay.selfStartedTurn,
    whenRepliesSent: () => fx.relay.repliesSent,
  };
});

const {
  trackQueuedMessage,
  holdQueuedMessage,
  handleQueuedCallback,
  handleEditedMessage,
  initParkedMessages,
  forgetParkedMessages,
  armReminders,
} = await import('../../src/bot/middleware/queued-messages.js');
const { queueRequest, setAbortController, setActiveQuery, isProcessing } = await import('../../src/claude/request-queue.js');
const { handleCancel } = await import('../../src/bot/handlers/command.handler.js');
const { registerBotCommandName } = await import('../../src/claude/command-parser.js');
const { config } = await import('../../src/config.js');

const CHAT = 42;
const SENDER = 1; // In the suite's ALLOWED_USER_IDS, so an admin.
const STRANGER = 99;

/** Comfortably past the ack's delay, the hold's poll and the reminder's. */
const WAIT_MS = 1_100;

const REMINDER = '🔔 You set this aside. Still want to send it?';
const PARKED_FILE = path.join(os.homedir(), '.claudegram', 'parked-messages-123456789.json');

interface Turn { release: () => void; cancelled: boolean }

let bot: Bot;
/** Prompts that reached Claude, in the order they did. */
let started: string[];
/** Who each of those prompts came from. */
let startedBy: (number | undefined)[];
/** Bot commands that ran, in the order they did. */
let commandsRun: string[];
/** The turn each prompt is running, for the test to finish. */
let turns: Map<string, Turn>;
let pending: Promise<void>[];
let nextUpdateId: number;
let nextMessageId: number;
/** Held by a message of the text 'slow' before it starts its turn, like a voice note being transcribed. */
let slowGate: Promise<void>;

function runTurn(text: string): Promise<void> {
  started.push(text);
  const controller = new AbortController();
  setAbortController(String(CHAT), controller);
  return new Promise<void>((resolve) => {
    const turn: Turn = { release: resolve, cancelled: false };
    turns.set(text, turn);
    controller.signal.addEventListener('abort', () => {
      turn.cancelled = true;
      resolve();
    });
  });
}

function makeBot(): Bot {
  const b = new Bot('123456789:TEST_TOKEN', {
    botInfo: {
      id: 123456789,
      is_bot: true,
      first_name: 'probe',
      username: 'probe_bot',
      can_join_groups: false,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
    } as never,
  });
  b.api.config.use(async (_prev, method, payload) => {
    fx.calls.push({ method, payload: payload as Record<string, unknown> });
    if (method === 'sendMessage') {
      if (fx.sendGate) await fx.sendGate;
      if (fx.sendFailure?.text === (payload as { text?: string }).text) throw fx.sendFailure.error;
      return {
        ok: true,
        result: { message_id: fx.nextId++, date: 0, chat: { id: CHAT, type: 'private' } },
      } as never;
    }
    return { ok: true, result: true } as never;
  });

  // The same order as createBot in src/bot/bot.ts.
  b.command('cancel', handleCancel);
  b.callbackQuery(/^queued:/, handleQueuedCallback);
  b.on('edited_message', handleEditedMessage);
  initParkedMessages(b);
  b.use(trackQueuedMessage);
  b.use(sequentialize((ctx: Context) => (ctx.chat ? String(ctx.chat.id) : undefined)));
  b.use(holdQueuedMessage);
  registerBotCommandName('clear');
  b.command('clear', () => { commandsRun.push('/clear'); });
  b.on('message:text', async (ctx) => {
    const { text } = ctx.message;
    if (text === 'slow') await slowGate;
    startedBy.push(ctx.from?.id);
    await queueRequest(String(CHAT), text, () => runTurn(text));
  });
  return b;
}

/** Deliver a text message and return its id. Doesn't wait for the handler. */
function send(text: string, opts: { from?: number; date?: number } = {}): number {
  const messageId = nextMessageId++;
  const command = text.match(/^\/\w+/);
  pending.push(bot.handleUpdate({
    update_id: nextUpdateId++,
    message: {
      message_id: messageId,
      date: opts.date ?? Math.floor(Date.now() / 1000),
      chat: { id: CHAT, type: 'private', first_name: 'u' },
      from: { id: opts.from ?? SENDER, is_bot: false, first_name: 'u' },
      text,
      ...(command ? { entities: [{ type: 'bot_command', offset: 0, length: command[0].length }] } : {}),
    },
  } as never));
  return messageId;
}

function tapButton(data: string, opts: { from?: number; ackId?: number } = {}): Promise<void> {
  return bot.handleUpdate({
    update_id: nextUpdateId++,
    callback_query: {
      id: `cb${nextUpdateId}`,
      from: { id: opts.from ?? SENDER, is_bot: false, first_name: 'u' },
      chat_instance: 'x',
      data,
      message: {
        message_id: opts.ackId ?? 4000,
        date: 0,
        chat: { id: CHAT, type: 'private', first_name: 'u' },
        from: { id: 123456789, is_bot: true, first_name: 'probe' },
        text: '⏳',
      },
    },
  } as never);
}

function tapTakeBack(messageId: number, opts: { from?: number; ackId?: number } = {}): Promise<void> {
  return tapButton(`queued:${messageId}`, opts);
}

function edit(messageId: number, text: string): Promise<void> {
  return bot.handleUpdate({
    update_id: nextUpdateId++,
    edited_message: {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      edit_date: Math.floor(Date.now() / 1000),
      chat: { id: CHAT, type: 'private', first_name: 'u' },
      from: { id: SENDER, is_bot: false, first_name: 'u' },
      text,
    },
  } as never);
}

const callsTo = (method: string) => fx.calls.filter((c) => c.method === method);
const textsSent = () => callsTo('sendMessage').map((c) => String(c.payload.text));
const acksFor = (messageId: number) => callsTo('sendMessage').filter((c) =>
  (c.payload.reply_parameters as { message_id?: number } | undefined)?.message_id === messageId);
const remindersFor = (messageId: number) => acksFor(messageId).filter((c) => c.payload.text === REMINDER);
const answers = () => callsTo('answerCallbackQuery').map((c) => c.payload.text);
const edits = () => callsTo('editMessageText').map((c) => c.payload.text);
const advance = (ms = WAIT_MS) => vi.advanceTimersByTimeAsync(ms);

/** Finish every turn still running or about to run, and let the chain drain. */
async function drain(): Promise<void> {
  fx.pty.isSessionGenerating = () => false;
  for (let i = 0; i < 10; i++) {
    for (const turn of turns.values()) turn.release();
    await advance();
  }
  await Promise.all(pending);
}

beforeEach(() => {
  vi.useFakeTimers();
  fx.calls = [];
  fx.sendGate = null;
  fx.sendFailure = null;
  fx.nextId = 5000;
  fx.pty.isSessionGenerating = () => false;
  fx.pty.interruptOwnTurn = () => false;
  fx.relay.selfStartedTurn = false;
  fx.relay.repliesSent = Promise.resolve();
  started = [];
  startedBy = [];
  commandsRun = [];
  turns = new Map();
  pending = [];
  nextUpdateId = 1;
  nextMessageId = 100;
  slowGate = Promise.resolve();
  bot = makeBot();
});

afterEach(async () => {
  config.CANCEL_ON_NEW_MESSAGE = false;
  await drain();
  forgetParkedMessages();
  fs.rmSync(PARKED_FILE, { force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a message sent while the bot is free', () => {
  it('goes straight through, with no ack', async () => {
    send('hello');
    await advance();

    expect(started).toEqual(['hello']);
    expect(callsTo('sendMessage')).toEqual([]);
  });
});

describe('a message sent during a turn', () => {
  it('is told it is waiting, in reply to itself, with a button to take it back', async () => {
    send('first');
    await advance();
    const second = send('second');
    await advance();

    expect(started).toEqual(['first']);
    const [ack] = acksFor(second);
    expect(ack?.payload.text).toBe('⏳ Queued behind the running turn.');
    expect(ack?.payload.reply_markup).toEqual({
      inline_keyboard: [[
        { text: '🗑 Take back', callback_data: `queued:${second}` },
        { text: '🔔 Ask me after', callback_data: `queued:park:${second}` },
      ]],
    });
    // Still goes out if the sender has deleted the message meanwhile.
    expect((ack?.payload.reply_parameters as { allow_sending_without_reply?: boolean }).allow_sending_without_reply).toBe(true);
  });

  it('reaches Claude once the turn ends, and the ack comes down', async () => {
    send('first');
    await advance();
    send('second');
    await advance();

    turns.get('first')!.release();
    await advance();

    expect(started).toEqual(['first', 'second']);
    expect(callsTo('deleteMessage').map((c) => c.payload.message_id)).toEqual([5000]);
  });

  it("doesn't flash an ack when the wait is over before it is due", async () => {
    send('first');
    await advance();
    send('second');
    await advance(100);
    turns.get('first')!.release();
    await advance();

    expect(started).toEqual(['first', 'second']);
    expect(callsTo('sendMessage')).toEqual([]);
    expect(callsTo('deleteMessage')).toEqual([]);
  });

  it('keeps the order it was sent in, however long the acks take', async () => {
    let openGate!: () => void;
    fx.sendGate = new Promise<void>((resolve) => { openGate = resolve; });

    send('first');
    await advance();
    send('second');
    send('third');
    await advance();

    // The acks are stuck on their way out, and nothing is waiting for them.
    expect(callsTo('sendMessage')).toHaveLength(2);
    turns.get('first')!.release();
    await advance();
    expect(started).toEqual(['first', 'second']);
    turns.get('second')!.release();
    await advance();
    expect(started).toEqual(['first', 'second', 'third']);

    // An ack that lands after its message went through still comes down.
    openGate();
    await advance();
    expect(callsTo('deleteMessage')).toHaveLength(2);
  });

  it('acks a second message that arrived before the first had started its turn', async () => {
    // Delivered together, as one getUpdates response hands them over.
    send('first');
    const second = send('second');
    await advance();

    expect(started).toEqual(['first']);
    expect(acksFor(second)).toHaveLength(1);
  });

  it("doesn't ack a message from before the bot started, which the handlers ignore", async () => {
    send('first');
    await advance();
    const stale = send('stale', { date: 1_000 });
    await advance();

    expect(acksFor(stale)).toEqual([]);
  });
});

describe('taking a message back', () => {
  it("means it never reaches Claude, and the running turn isn't touched", async () => {
    send('first');
    await advance();
    const second = send('second');
    await advance();

    await tapTakeBack(second);
    await advance();

    expect(answers()).toEqual(['Taken back.']);
    expect(callsTo('editMessageText').at(-1)?.payload).toMatchObject({
      message_id: 5000,
      text: '🗑 Taken back before it reached Claude.',
      reply_markup: { inline_keyboard: [] },
    });
    expect(turns.get('first')!.cancelled).toBe(false);
    expect(isProcessing(String(CHAT))).toBe(true);

    turns.get('first')!.release();
    await advance();
    expect(started).toEqual(['first']);
    // The ack stays, as the record of what happened to the message.
    expect(callsTo('deleteMessage')).toEqual([]);
  });

  it('leaves whatever was waiting behind it in line', async () => {
    send('first');
    await advance();
    const second = send('second');
    send('third');
    await advance();

    await tapTakeBack(second);
    turns.get('first')!.release();
    await advance();

    expect(started).toEqual(['first', 'third']);
  });

  it('answers a second tap without doing anything twice', async () => {
    send('first');
    await advance();
    const second = send('second');
    await advance();

    await tapTakeBack(second);
    await tapTakeBack(second);
    await advance();

    expect(answers()).toEqual(['Taken back.', 'Already taken back.']);
    expect(callsTo('editMessageText')).toHaveLength(1);
  });

  it('is too late once its turn has started', async () => {
    send('first');
    await advance();
    const second = send('second');
    await advance();
    turns.get('first')!.release();
    await advance();
    expect(started).toEqual(['first', 'second']);

    await tapTakeBack(second);
    await advance();

    expect(answers()).toEqual(['This message is no longer waiting.']);
    expect(turns.get('second')!.cancelled).toBe(false);
  });

  it('owns up on an ack left standing by a restart', async () => {
    // Nothing in memory knows this message: the bot restarted since it was acked.
    await tapTakeBack(777, { ackId: 4242 });

    expect(answers()).toEqual(['This message is no longer waiting.']);
    expect(callsTo('editMessageText').at(-1)?.payload).toMatchObject({
      message_id: 4242,
      text: '⌛ No longer waiting. If Claude never answered it, send it again.',
      reply_markup: { inline_keyboard: [] },
    });
  });

  it("is refused to someone else in the chat, and the message still goes through", async () => {
    send('first');
    await advance();
    const second = send('second');
    await advance();

    await tapTakeBack(second, { from: STRANGER });
    await advance();

    expect(answers()).toEqual(['Only the person who sent this, or an admin, can do that.']);
    turns.get('first')!.release();
    await advance();
    expect(started).toEqual(['first', 'second']);
  });

  it("is open to an admin, for someone else's message", async () => {
    send('first');
    await advance();
    const second = send('second', { from: STRANGER });
    await advance();

    await tapTakeBack(second, { from: SENDER });
    turns.get('first')!.release();
    await advance();

    expect(answers()).toEqual(['Taken back.']);
    expect(started).toEqual(['first']);
  });
});

describe('setting a message aside', () => {
  /** A turn running, and a message behind it set aside. The ack is message 5000. */
  async function setAside(text = 'second'): Promise<number> {
    send('first');
    await advance();
    const id = send(text);
    await advance();
    await tapButton(`queued:park:${id}`, { ackId: 5000 });
    return id;
  }

  /** Set aside, with the turn over and the question up. */
  async function asked(text = 'second'): Promise<number> {
    const id = await setAside(text);
    turns.get('first')!.release();
    await advance();
    expect(remindersFor(id)).toHaveLength(1);
    return id;
  }

  it("isn't offered on a bot command, which has no answer to read first", async () => {
    send('first');
    await advance();
    const clear = send('/clear');
    await advance();

    expect(acksFor(clear)[0]?.payload.reply_markup).toEqual({
      inline_keyboard: [[{ text: '🗑 Take back', callback_data: `queued:${clear}` }]],
    });
  });

  it('says so on the ack, and leaves the running turn alone', async () => {
    const id = await setAside();

    expect(answers()).toEqual(['Set aside.']);
    expect(callsTo('editMessageText').at(-1)?.payload).toMatchObject({
      message_id: 5000,
      text: "🔔 Set aside. I'll ask when Claude is done.",
      reply_markup: { inline_keyboard: [[{ text: '🗑 Take back', callback_data: `queued:${id}` }]] },
    });
    expect(turns.get('first')!.cancelled).toBe(false);
    expect(isProcessing(String(CHAT))).toBe(true);
    expect(remindersFor(id)).toEqual([]);
  });

  it("doesn't go out when the turn ends, and asks instead, in a way that reaches someone who looked away", async () => {
    const id = await setAside();

    turns.get('first')!.release();
    await advance();

    expect(started).toEqual(['first']);
    const [reminder] = remindersFor(id);
    expect(reminder?.payload.reply_markup).toEqual({
      inline_keyboard: [[
        { text: '📤 Send', callback_data: `queued:send:${id}` },
        { text: '🗑 Drop', callback_data: `queued:drop:${id}` },
      ]],
    });
    expect(reminder?.payload.reply_parameters).toEqual({ message_id: id, allow_sending_without_reply: true });
    expect(reminder?.payload.disable_notification).toBeUndefined();
    // The notice has served, and it would only sit above the reply saying it's still to come.
    expect(callsTo('deleteMessage').map((c) => c.payload.message_id)).toEqual([5000]);
  });

  it('asks only once, however long the question goes unanswered', async () => {
    const id = await asked();

    await advance(60_000);

    expect(remindersFor(id)).toHaveLength(1);
    expect(started).toEqual(['first']);
  });

  it('asks about each message set aside, and handles them one by one', async () => {
    const second = await setAside('second');
    const third = send('third');
    await advance();
    await tapButton(`queued:park:${third}`, { ackId: 5001 });
    turns.get('first')!.release();
    await advance();

    expect(remindersFor(second)).toHaveLength(1);
    expect(remindersFor(third)).toHaveLength(1);

    await tapButton(`queued:send:${third}`);
    await advance();
    expect(started).toEqual(['first', 'third']);

    await tapButton(`queued:drop:${second}`);
    await advance();
    expect(started).toEqual(['first', 'third']);
  });

  it("doesn't hold up what's behind it, and asks once that has finished too", async () => {
    const id = await setAside();
    send('third');
    await advance();

    turns.get('first')!.release();
    await advance();
    expect(started).toEqual(['first', 'third']);
    expect(remindersFor(id)).toEqual([]);

    turns.get('third')!.release();
    await advance();
    expect(remindersFor(id)).toHaveLength(1);
    expect(started).toEqual(['first', 'third']);
  });

  it("doesn't ask while the next message is on its way to a turn, which isn't one yet", async () => {
    let openGate!: () => void;
    slowGate = new Promise<void>((resolve) => { openGate = resolve; });
    const id = await setAside();
    send('slow');
    await advance();

    turns.get('first')!.release();
    await advance();
    expect(isProcessing(String(CHAT))).toBe(false);
    expect(remindersFor(id)).toEqual([]);

    openGate();
    await advance();
    expect(started).toEqual(['first', 'slow']);
    expect(remindersFor(id)).toEqual([]);

    turns.get('slow')!.release();
    await advance();
    expect(remindersFor(id)).toHaveLength(1);
  });

  it('asks after a turn Claude started itself, and below its reply', async () => {
    fx.pty.isSessionGenerating = () => true;
    const id = send('hello');
    await advance();
    await tapButton(`queued:park:${id}`, { ackId: 5000 });
    await advance();
    expect(remindersFor(id)).toEqual([]);

    // The screen has stopped, but the session log hasn't closed the turn yet.
    fx.pty.isSessionGenerating = () => false;
    fx.relay.selfStartedTurn = true;
    await advance();
    expect(remindersFor(id)).toEqual([]);

    // Closed, with the reply still on its way to the chat.
    let replySent!: () => void;
    fx.relay.repliesSent = new Promise<void>((resolve) => { replySent = resolve; });
    fx.relay.selfStartedTurn = false;
    await advance();
    expect(remindersFor(id)).toEqual([]);

    replySent();
    await advance();
    expect(remindersFor(id)).toHaveLength(1);
    expect(started).toEqual([]);
  });

  it('asks after a turn no update started, which only the request queue knows about', async () => {
    void queueRequest(String(CHAT), '[scheduled]', () => runTurn('[scheduled]'));
    await advance();
    const id = send('hello');
    await advance();
    await tapButton(`queued:park:${id}`, { ackId: 5000 });
    await advance();
    expect(remindersFor(id)).toEqual([]);

    turns.get('[scheduled]')!.release();
    await advance();

    expect(remindersFor(id)).toHaveLength(1);
    expect(started).toEqual(['[scheduled]']);
  });

  it('stops holding up a bot command the moment it is set aside', async () => {
    // Behind a turn no update started, what a bot command waits for is the message
    // ahead of it, which is waiting for Claude. Once set aside, it isn't any more.
    void queueRequest(String(CHAT), '[scheduled]', () => runTurn('[scheduled]'));
    await advance();
    const id = send('hello');
    send('/clear');
    await advance();
    expect(commandsRun).toEqual([]);

    await tapButton(`queued:park:${id}`, { ackId: 5000 });
    await advance();

    expect(commandsRun).toEqual(['/clear']);
    expect(turns.get('[scheduled]')!.cancelled).toBe(false);
  });

  it('goes out on Send, and the question says so', async () => {
    const id = await asked();

    await tapButton(`queued:send:${id}`, { ackId: 5001 });
    await advance();

    expect(started).toEqual(['first', 'second']);
    expect(answers()).toContain('Sent.');
    expect(callsTo('editMessageText').at(-1)?.payload).toMatchObject({
      message_id: 5001,
      text: '📤 Sent.',
      reply_markup: { inline_keyboard: [] },
    });
  });

  it('goes out only once, however often Send is tapped', async () => {
    const id = await asked();

    await tapButton(`queued:send:${id}`);
    await tapButton(`queued:send:${id}`);
    await advance();

    expect(started).toEqual(['first', 'second']);
    expect(answers().at(-1)).toBe('Already dealt with.');
    expect(callsTo('editMessageReplyMarkup')).toHaveLength(1);
    // The second tap leaves "📤 Sent." standing, rather than calling it lost.
    expect(edits()).not.toContain('⌛ No longer waiting. If Claude never answered it, send it again.');
  });

  it('waits its turn like any other message when Send is tapped during one', async () => {
    const id = await asked();
    send('third');
    await advance();
    expect(started).toEqual(['first', 'third']);

    await tapButton(`queued:send:${id}`);
    await advance();

    expect(started).toEqual(['first', 'third']);
    expect(textsSent().filter((text) => text === '⏳ Queued behind the running turn.')).toHaveLength(2);

    turns.get('third')!.release();
    await advance();
    expect(started).toEqual(['first', 'third', 'second']);
  });

  it('can be set aside again when Send finds another turn running', async () => {
    const id = await asked();
    send('third');
    await advance();
    await tapButton(`queued:send:${id}`);
    await advance();

    await tapButton(`queued:park:${id}`, { ackId: 5002 });
    turns.get('third')!.release();
    await advance();

    expect(started).toEqual(['first', 'third']);
    expect(remindersFor(id)).toHaveLength(2);

    await tapButton(`queued:send:${id}`);
    await advance();
    expect(started).toEqual(['first', 'third', 'second']);
  });

  it('never goes out on Drop', async () => {
    const id = await asked();

    await tapButton(`queued:drop:${id}`, { ackId: 5001 });
    await advance();

    expect(started).toEqual(['first']);
    expect(answers()).toContain('Dropped.');
    expect(callsTo('editMessageText').at(-1)?.payload).toMatchObject({
      message_id: 5001,
      text: '🗑 Dropped before it reached Claude.',
      reply_markup: { inline_keyboard: [] },
    });
  });

  it('can be taken back while it is still in line, and then nothing asks about it', async () => {
    const id = await setAside();

    await tapTakeBack(id);
    turns.get('first')!.release();
    await advance();

    expect(started).toEqual(['first']);
    expect(remindersFor(id)).toEqual([]);
    expect(edits()).toContain('🗑 Taken back before it reached Claude.');
  });

  it('can be taken back after its place in line has gone, and then nothing asks about it', async () => {
    const id = await setAside();
    send('third');
    await advance();
    turns.get('first')!.release();
    await advance();
    expect(started).toEqual(['first', 'third']);

    await tapTakeBack(id, { ackId: 5000 });
    expect(callsTo('editMessageText').at(-1)?.payload).toMatchObject({
      message_id: 5000,
      text: '🗑 Taken back before it reached Claude.',
    });
    turns.get('third')!.release();
    await advance();

    expect(started).toEqual(['first', 'third']);
    expect(remindersFor(id)).toEqual([]);
  });

  it('answers a second tap without setting it aside twice', async () => {
    const id = await setAside();

    await tapButton(`queued:park:${id}`, { ackId: 5000 });
    turns.get('first')!.release();
    await advance();

    expect(answers()).toEqual(['Set aside.', 'Already set aside.']);
    expect(remindersFor(id)).toHaveLength(1);
  });

  it('is too late once its turn has started', async () => {
    send('first');
    await advance();
    const id = send('second');
    await advance();
    turns.get('first')!.release();
    await advance();
    expect(started).toEqual(['first', 'second']);

    await tapButton(`queued:park:${id}`);
    await advance();

    expect(answers()).toEqual(['This message is no longer waiting.']);
    expect(remindersFor(id)).toEqual([]);
  });

  it('stays set aside through /cancel, which brings the question on', async () => {
    const id = await setAside();
    send('third');
    await advance();

    send('/cancel');
    await advance();

    expect(turns.get('first')!.cancelled).toBe(true);
    expect(started).toEqual(['first']);
    // Only the third was dropped.
    expect(textsSent()).toContain('🛑 Cancelled\\. \\(1 queued request cleared\\)');
    expect(remindersFor(id)).toHaveLength(1);
  });

  it('stays set aside when a new message replaces the turn', async () => {
    const id = await setAside();

    config.CANCEL_ON_NEW_MESSAGE = true;
    send('third');
    await advance();
    config.CANCEL_ON_NEW_MESSAGE = false;
    expect(started).toEqual(['first', 'third']);

    turns.get('third')!.release();
    await advance();
    expect(remindersFor(id)).toHaveLength(1);
  });

  it("is refused to someone else in the chat, at every step", async () => {
    send('first');
    await advance();
    const id = send('second');
    await advance();

    await tapButton(`queued:park:${id}`, { from: STRANGER });
    await advance();
    expect(answers().at(-1)).toBe('Only the person who sent this, or an admin, can do that.');
    expect(remindersFor(id)).toEqual([]);

    await tapButton(`queued:park:${id}`);
    turns.get('first')!.release();
    await advance();

    await tapButton(`queued:send:${id}`, { from: STRANGER });
    await tapButton(`queued:drop:${id}`, { from: STRANGER });
    await advance();
    expect(answers().slice(-2)).toEqual([
      'Only the person who sent this, or an admin, can do that.',
      'Only the person who sent this, or an admin, can do that.',
    ]);
    expect(started).toEqual(['first']);

    // Still there to be decided on by the person who can.
    await tapButton(`queued:send:${id}`);
    await advance();
    expect(started).toEqual(['first', 'second']);
  });

  it("is open to an admin, for someone else's message, which still goes out as theirs", async () => {
    send('first');
    await advance();
    const id = send('second', { from: STRANGER });
    await advance();

    await tapButton(`queued:park:${id}`, { from: SENDER });
    turns.get('first')!.release();
    await advance();
    await tapButton(`queued:send:${id}`, { from: SENDER });
    await advance();

    expect(started).toEqual(['first', 'second']);
    expect(startedBy.at(-1)).toBe(STRANGER);
  });

  it("gives up on a chat that refuses the question, rather than asking it every second", async () => {
    fx.sendFailure = {
      text: REMINDER,
      error: new GrammyError(
        'Forbidden',
        { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' },
        'sendMessage',
        {},
      ),
    };
    const id = await setAside();

    turns.get('first')!.release();
    await advance(10_000);

    expect(remindersFor(id)).toHaveLength(1);
    // The next restart tries again, since it's still on disk.
    fx.sendFailure = null;
    forgetParkedMessages();
    initParkedMessages(bot);
    armReminders();
    await advance();
    expect(remindersFor(id)).toHaveLength(2);
  });

  it('keeps asking through a network failure', async () => {
    fx.sendFailure = { text: REMINDER, error: new Error('socket hang up') };
    const id = await setAside();

    turns.get('first')!.release();
    await advance(3_000);
    expect(remindersFor(id).length).toBeGreaterThan(1);

    const tries = remindersFor(id).length;
    fx.sendFailure = null;
    await advance();
    await advance(10_000);
    expect(remindersFor(id)).toHaveLength(tries + 1);
  });

  describe('across a restart', () => {
    function restart(): void {
      forgetParkedMessages();
      initParkedMessages(bot);
    }

    it('still asks about a message the old process never got round to', async () => {
      const id = await setAside();
      turns.get('first')!.release();
      restart();
      await advance();
      expect(remindersFor(id)).toEqual([]);

      // What src/index.ts does once the resume paths have run.
      armReminders();
      await advance();

      expect(remindersFor(id)).toHaveLength(1);
      expect(callsTo('deleteMessage').map((c) => c.payload.message_id)).toEqual([5000]);
    });

    it('still sends from a question asked before it', async () => {
      const id = await asked();
      restart();
      armReminders();
      await advance();
      expect(remindersFor(id)).toHaveLength(1);

      await tapButton(`queued:send:${id}`);
      await advance();

      expect(started).toEqual(['first', 'second']);
    });

    it('still drops from a question asked before it, and stays dropped', async () => {
      const id = await asked();
      restart();

      await tapButton(`queued:drop:${id}`);
      restart();
      armReminders();
      await advance();

      expect(started).toEqual(['first']);
      expect(remindersFor(id)).toHaveLength(1);
      await tapButton(`queued:send:${id}`);
      await advance();
      expect(started).toEqual(['first']);
    });

    it('starts empty from a file it cannot read, and says nothing to anyone', async () => {
      fs.writeFileSync(PARKED_FILE, '{ not json');
      vi.spyOn(console, 'error').mockImplementation(() => {});
      restart();
      armReminders();
      await advance();

      expect(callsTo('sendMessage')).toEqual([]);
    });
  });

  describe('with an edit', () => {
    it('sends the edit, not what was first typed', async () => {
      const id = await setAside();

      await edit(id, 'second, fixed');
      turns.get('first')!.release();
      await advance();
      await tapButton(`queued:send:${id}`);
      await advance();

      expect(started).toEqual(['first', 'second, fixed']);
    });

    it('sends an edit made after the question went up', async () => {
      const id = await asked();

      await edit(id, 'second, fixed');
      await tapButton(`queued:send:${id}`);
      await advance();

      expect(started).toEqual(['first', 'second, fixed']);
    });

    it('keeps an edit across a restart', async () => {
      const id = await asked();

      await edit(id, 'second, fixed');
      forgetParkedMessages();
      initParkedMessages(bot);
      await tapButton(`queued:send:${id}`);
      await advance();

      expect(started).toEqual(['first', 'second, fixed']);
    });
  });
});

describe('an edit to a message still in line', () => {
  it('is what goes out', async () => {
    send('first');
    await advance();
    const id = send('second');
    await advance();

    await edit(id, 'second, fixed');
    turns.get('first')!.release();
    await advance();

    expect(started).toEqual(['first', 'second, fixed']);
  });

  it("doesn't wait behind the turn to land", async () => {
    send('first');
    await advance();
    const id = send('second');
    await advance();

    // Behind sequentialize this wouldn't return until the turn had ended.
    await edit(id, 'second, fixed');

    expect(turns.get('first')!.cancelled).toBe(false);
    expect(isProcessing(String(CHAT))).toBe(true);
  });

  it('is ignored once the message has gone out', async () => {
    const id = send('first');
    await advance();

    await edit(id, 'first, fixed');
    turns.get('first')!.release();
    await advance();

    expect(started).toEqual(['first']);
    expect(callsTo('sendMessage')).toEqual([]);
  });
});

describe('/cancel', () => {
  it('stops the turn without letting what was waiting behind it through', async () => {
    send('first');
    await advance();
    send('second');
    send('third');
    await advance();

    send('/cancel');
    await advance();

    expect(turns.get('first')!.cancelled).toBe(true);
    expect(started).toEqual(['first']);
    expect(textsSent()).toContain('🛑 Cancelled\\. \\(2 queued requests cleared\\)');
    expect(callsTo('editMessageText').map((c) => c.payload.text)).toEqual([
      '🛑 Cancelled before it reached Claude.',
      '🛑 Cancelled before it reached Claude.',
    ]);
  });

  it('drops what was waiting even if the turn ends before the interrupt returns', async () => {
    // The SDK path: the turn is over while /cancel is still awaiting interrupt(),
    // so anything dropped only after that await would already have gone through.
    send('first');
    await advance();
    send('second');
    await advance();
    setActiveQuery(String(CHAT), {
      interrupt: async () => {
        turns.get('first')!.release();
        await new Promise((resolve) => setTimeout(resolve, 200));
      },
    } as never);

    send('/cancel');
    await advance();

    expect(started).toEqual(['first']);
  });

  it('leaves the chat free for the next message', async () => {
    send('first');
    await advance();
    send('second');
    await advance();
    send('/cancel');
    await advance();

    send('third');
    await advance();

    expect(started).toEqual(['first', 'third']);
  });

  it('drops a message before its ack is even due', async () => {
    send('first');
    await advance();
    send('second');
    await advance(100);
    send('/cancel');
    await advance();

    expect(started).toEqual(['first']);
    expect(acksFor(101)).toEqual([]);
    expect(textsSent()).toContain('🛑 Cancelled\\. \\(1 queued request cleared\\)');
  });

  it('says there was nothing to cancel when there was not', async () => {
    send('/cancel');
    await advance();

    expect(textsSent()).toEqual(['ℹ️ Nothing to cancel\\.']);
  });
});

describe('a turn Claude started itself', () => {
  beforeEach(() => {
    fx.pty.isSessionGenerating = () => true;
  });

  it('holds a message until it ends, naming what the wait is for', async () => {
    const id = send('hello');
    await advance();

    expect(started).toEqual([]);
    expect(isProcessing(String(CHAT))).toBe(false);
    expect(acksFor(id)[0]?.payload.text).toBe('⏳ Queued behind a turn Claude started itself.');

    fx.pty.isSessionGenerating = () => false;
    await advance();

    expect(started).toEqual(['hello']);
    expect(callsTo('deleteMessage')).toHaveLength(1);
  });

  it('can have a message taken back without interrupting it', async () => {
    const interrupt = vi.fn(() => true);
    fx.pty.interruptOwnTurn = interrupt;
    const id = send('hello');
    await advance();

    await tapTakeBack(id);
    fx.pty.isSessionGenerating = () => false;
    await advance();

    expect(started).toEqual([]);
    expect(interrupt).not.toHaveBeenCalled();
  });

  it('is what /cancel stops when no turn of ours is running, and the message goes with it', async () => {
    const interrupt = vi.fn(() => true);
    fx.pty.interruptOwnTurn = interrupt;
    send('hello');
    await advance();

    send('/cancel');
    await advance();

    expect(interrupt).toHaveBeenCalledOnce();
    expect(started).toEqual([]);
    expect(textsSent()).toContain('🛑 Cancelled\\. \\(1 queued request cleared\\)');
  });

  it('is stopped by /cancel with nothing waiting, too', async () => {
    fx.pty.interruptOwnTurn = () => true;
    send('/cancel');
    await advance();

    expect(textsSent()).toEqual(['🛑 Cancelled\\.']);
  });

  it("lets go after the ceiling, so the provider's wait can report a turn that never ends", async () => {
    send('hello');
    await advance();
    expect(started).toEqual([]);

    await advance(29 * 60_000);
    expect(started).toEqual([]);
    await advance(2 * 60_000);
    expect(started).toEqual(['hello']);
  });

  it("doesn't hold up a bot command, which doesn't need Claude", async () => {
    send('/clear');
    await advance();

    expect(commandsRun).toEqual(['/clear']);
    expect(callsTo('sendMessage')).toEqual([]);
  });
});

describe('a turn no update started, like a /schedule fire', () => {
  // These hold nothing in sequentialize, which is what makes them different: a
  // message gets past it and is held by holdQueuedMessage instead.
  function fireScheduled(): void {
    void queueRequest(String(CHAT), '[scheduled]', () => runTurn('[scheduled]'));
  }

  it('holds a message until it ends', async () => {
    fireScheduled();
    await advance();
    const id = send('hello');
    await advance();

    expect(started).toEqual(['[scheduled]']);
    expect(acksFor(id)[0]?.payload.text).toBe('⏳ Queued behind the running turn.');

    turns.get('[scheduled]')!.release();
    await advance();

    expect(started).toEqual(['[scheduled]', 'hello']);
    expect(callsTo('deleteMessage')).toHaveLength(1);
  });

  it('can have a message taken back', async () => {
    fireScheduled();
    await advance();
    const id = send('hello');
    await advance();

    await tapTakeBack(id);
    await advance();
    turns.get('[scheduled]')!.release();
    await advance();

    expect(started).toEqual(['[scheduled]']);
    expect(turns.get('[scheduled]')!.cancelled).toBe(false);
  });

  it("doesn't count towards the ceiling on a turn Claude starts straight after", async () => {
    // Longer than the ceiling, with the screen saying Claude is at work
    // throughout. Only what comes after it counts as Claude's own turn.
    fx.pty.isSessionGenerating = () => true;
    fireScheduled();
    await advance();
    send('hello');
    await advance(31 * 60_000);
    expect(started).toEqual(['[scheduled]']);

    turns.get('[scheduled]')!.release();
    await advance();
    expect(started).toEqual(['[scheduled]']);
  });

  it("doesn't hold up a bot command, which doesn't need Claude", async () => {
    fireScheduled();
    await advance();
    send('/clear');
    await advance();

    expect(commandsRun).toEqual(['/clear']);
  });
});

describe('a bot command sent during a turn', () => {
  it('gets the ack too, since it is waiting as well', async () => {
    send('first');
    await advance();
    const clear = send('/clear');
    await advance();

    expect(commandsRun).toEqual([]);
    expect(acksFor(clear)).toHaveLength(1);

    turns.get('first')!.release();
    await advance();
    expect(commandsRun).toEqual(['/clear']);
    expect(callsTo('deleteMessage')).toHaveLength(1);
  });

  it('can be taken back like anything else', async () => {
    send('first');
    await advance();
    const clear = send('/clear');
    await advance();

    await tapTakeBack(clear);
    turns.get('first')!.release();
    await advance();

    expect(commandsRun).toEqual([]);
  });

  it('counts as a message when the bot has no such command, since Claude gets typed it', async () => {
    fx.pty.isSessionGenerating = () => true;
    send('/some-project-command');
    await advance();
    expect(started).toEqual([]);

    fx.pty.isSessionGenerating = () => false;
    await advance();
    expect(started).toEqual(['/some-project-command']);
  });
});

describe('CANCEL_ON_NEW_MESSAGE', () => {
  it('has the newest message replace the running turn and everything waiting', async () => {
    send('first');
    await advance();
    send('second');
    await advance();

    config.CANCEL_ON_NEW_MESSAGE = true;
    send('third');
    await advance();

    expect(turns.get('first')!.cancelled).toBe(true);
    expect(started).toEqual(['first', 'third']);
    expect(callsTo('editMessageText').map((c) => c.payload.text)).toEqual(['🛑 Cancelled before it reached Claude.']);
  });

  it('leaves the turn alone for a bot command', async () => {
    send('first');
    await advance();

    config.CANCEL_ON_NEW_MESSAGE = true;
    send('/clear');
    await advance();

    expect(turns.get('first')!.cancelled).toBe(false);
  });
});
