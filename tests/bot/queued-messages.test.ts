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
import { Bot, type Context } from 'grammy';
import { sequentialize } from '@grammyjs/runner';

const fx = vi.hoisted(() => ({
  calls: [] as { method: string; payload: Record<string, unknown> }[],
  /** Hold back sendMessage responses until released. */
  sendGate: null as Promise<void> | null,
  nextId: 5000,
  pty: {
    isSessionGenerating: (() => false) as (key: string) => boolean,
    interruptOwnTurn: (() => false) as (key: string) => boolean,
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

const { trackQueuedMessage, holdQueuedMessage, handleQueuedCallback } = await import('../../src/bot/middleware/queued-messages.js');
const { queueRequest, setAbortController, setActiveQuery, isProcessing } = await import('../../src/claude/request-queue.js');
const { handleCancel } = await import('../../src/bot/handlers/command.handler.js');
const { registerBotCommandName } = await import('../../src/claude/command-parser.js');
const { config } = await import('../../src/config.js');

const CHAT = 42;
const SENDER = 1; // In the suite's ALLOWED_USER_IDS, so an admin.
const STRANGER = 99;

/** Comfortably past the ack's delay and the hold's poll. */
const WAIT_MS = 1_100;

interface Turn { release: () => void; cancelled: boolean }

let bot: Bot;
/** Prompts that reached Claude, in the order they did. */
let started: string[];
/** Bot commands that ran, in the order they did. */
let commandsRun: string[];
/** The turn each prompt is running, for the test to finish. */
let turns: Map<string, Turn>;
let pending: Promise<void>[];
let nextUpdateId: number;
let nextMessageId: number;

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
  b.use(trackQueuedMessage);
  b.use(sequentialize((ctx: Context) => (ctx.chat ? String(ctx.chat.id) : undefined)));
  b.use(holdQueuedMessage);
  registerBotCommandName('clear');
  b.command('clear', () => { commandsRun.push('/clear'); });
  b.on('message:text', async (ctx) => {
    const { text } = ctx.message;
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

function tapTakeBack(messageId: number, opts: { from?: number; ackId?: number } = {}): Promise<void> {
  return bot.handleUpdate({
    update_id: nextUpdateId++,
    callback_query: {
      id: `cb${nextUpdateId}`,
      from: { id: opts.from ?? SENDER, is_bot: false, first_name: 'u' },
      chat_instance: 'x',
      data: `queued:${messageId}`,
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

const callsTo = (method: string) => fx.calls.filter((c) => c.method === method);
const textsSent = () => callsTo('sendMessage').map((c) => String(c.payload.text));
const acksFor = (messageId: number) => callsTo('sendMessage').filter((c) =>
  (c.payload.reply_parameters as { message_id?: number } | undefined)?.message_id === messageId);
const answers = () => callsTo('answerCallbackQuery').map((c) => c.payload.text);
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
  fx.nextId = 5000;
  fx.pty.isSessionGenerating = () => false;
  fx.pty.interruptOwnTurn = () => false;
  started = [];
  commandsRun = [];
  turns = new Map();
  pending = [];
  nextUpdateId = 1;
  nextMessageId = 100;
  bot = makeBot();
});

afterEach(async () => {
  config.CANCEL_ON_NEW_MESSAGE = false;
  await drain();
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
      inline_keyboard: [[{ text: '🗑 Take back', callback_data: `queued:${second}` }]],
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

    expect(answers()).toEqual(['Only the person who sent this, or an admin, can take it back.']);
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
