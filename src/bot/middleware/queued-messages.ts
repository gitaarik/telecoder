/**
 * Messages waiting their turn, and taking one back.
 *
 * A message sent while the bot is busy doesn't reach Claude until the bot is
 * free, so until then it can still be recalled. Deleting it in Telegram can't
 * do that: the Bot API has no event for a delete outside business accounts, and
 * in a bot chat a delete only ever removes the sender's copy, so the bot's stays
 * as it was. The only signal that can reach us is one we offer, hence a button.
 *
 * The wait has to be announced from out here because the handlers can't see it.
 * Every handler awaits its whole turn and sequentialize holds the next update
 * until that returns, so by the time a handler runs there is no turn left to
 * report. A message behind a turn used to wait in silence, which looks exactly
 * like a bot that has gone idle. /cancel couldn't reach it either: the message
 * wasn't in the request queue, so stopping the turn released it.
 *
 * Hence a middleware either side of sequentialize:
 *
 *  - `trackQueuedMessage`, ahead of it, notes the message the moment it arrives
 *    and schedules the ack. It must not await anything on the way to `next`:
 *    updates reach sequentialize in the order they leave here, so waiting on the
 *    ack would let a later message overtake an earlier one.
 *  - `holdQueuedMessage`, behind it, is where the wait ends. It drops a message
 *    that was taken back and otherwise takes the ack down and lets it through.
 *
 * It also holds a message bound for Claude while Claude is busy with something
 * sequentialize knows nothing about: a /schedule fire, or a turn Claude started
 * itself when a background task reported back. Holding here rather than in the
 * pty provider's readiness wait means taking the message back leaves that turn
 * alone, no "thinking" bubble goes up for a prompt that hasn't been delivered,
 * and the relay still gets to post that turn's reply. The provider's wait stays
 * as the backstop for a turn that starts in the moment after this lets go.
 *
 * Bot commands get the ack and the button while sequentialize holds them, and
 * nothing more. They don't need Claude, so they don't wait for it.
 *
 * Whether a message is still worth sending can depend on the answer it's waiting
 * behind, so one bound for Claude can also be set aside, to decide on once that
 * answer has been read. "Parked" in here, because "hold" already means the wait
 * above. It leaves the line the way a taken-back message does, since waiting in
 * there for a decision would hold up everything behind it, and it's kept on disk,
 * since the decision can outlast any number of restarts. The question goes up once
 * nothing is running or waiting in the session. Send feeds the update back through
 * the whole middleware chain as if it had just arrived, which is what gets a voice
 * note transcribed and puts the message back in line if a turn has started since.
 */

import * as path from 'path';
import { GrammyError, type Api, type Bot, type Context, type MiddlewareFn } from 'grammy';
import type { Message, Update } from 'grammy/types';
import { z } from 'zod';
import { BOT_ID, config } from '../../config.js';
import { getBotCommandNames } from '../../claude/command-parser.js';
import { hasSelfStartedTurn, whenRepliesSent } from '../../claude/monitor-relay.js';
import { cancelRequest, clearQueue, isProcessing } from '../../claude/request-queue.js';
import { getPtyProvider } from '../../providers/claude-provider.js';
import { isAdmin } from '../../utils/admins.js';
import { ensureStateDir, getStateDir, readJsonFile, writeJsonFile } from '../../utils/json-store.js';
import { sanitizeError } from '../../utils/sanitize.js';
import { getSessionKeyFromCtx, type SessionKey } from '../../utils/session-key.js';
import { markAlreadyAddressed, stripBotMention } from './group-mention.middleware.js';
import { wasBatched } from './message-batcher.js';
import { isStaleMessage } from './stale-filter.js';

/**
 * How long a message must have been waiting before it says so. Long enough that
 * one arriving as a turn winds up, or behind a command that answers at once,
 * doesn't flash a notice that's gone a moment later; short enough to read as an
 * immediate answer.
 */
const ACK_DELAY_MS = 500;

/** How often a held message looks again at what it is waiting for. */
const HOLD_POLL_MS = 500;

/**
 * How long a message waits on a turn Claude started itself before it moves on
 * to the pty provider's readiness wait, which reports a turn that never ends
 * instead of sitting on it. Matches that wait's own patience. A turn TeleCoder
 * started has no ceiling here, because the agent watchdog already looks after it.
 */
const OWN_TURN_CEILING_MS = 30 * 60_000;

/** How often a message set aside looks again at whether it can be asked about. */
const REMIND_POLL_MS = 1_000;

const CALLBACK_PREFIX = 'queued:';
/** A bare message id is Take back, which is what acks already in chats carry. */
const CALLBACK_PATTERN = /^queued:(?:(park|send|drop):)?(\d+)$/;

const BEHIND_TURN = '⏳ Queued behind the running turn.';
const BEHIND_OWN_TURN = '⏳ Queued behind a turn Claude started itself.';
const TAKEN_BACK = '🗑 Taken back before it reached Claude.';
const CANCELLED = '🛑 Cancelled before it reached Claude.';
const NO_LONGER_WAITING = '⌛ No longer waiting. If Claude never answered it, send it again.';
const PARKED = "🔔 Set aside. I'll ask when Claude is done.";
const REMINDER = '🔔 You set this aside. Still want to send it?';
const SENT = '📤 Sent.';
const DROPPED = '🗑 Dropped before it reached Claude.';
const NOT_YOURS = 'Only the person who sent this, or an admin, can do that.';

/** An update carrying a message, the only kind this file holds on to. */
type MessageUpdate = Update & { message: NonNullable<Update['message']> };

interface QueuedMessage {
  chatId: number;
  threadId: number | undefined;
  sessionKey: SessionKey;
  messageId: number;
  senderId: number | undefined;
  update: MessageUpdate;
  /** Bound for Claude, so it also waits for whatever Claude is doing. */
  forClaude: boolean;
  takenBack: boolean;
  /** Set aside: it leaves the line the way a taken-back message does, but isn't gone. */
  parked: boolean;
  /** Set until the ack is due, and cleared early if it never becomes due. */
  ackTimer: NodeJS.Timeout | null;
  /** The ack on its way, resolving to its message id. Undefined if it never landed. */
  ack: Promise<number | undefined> | null;
}

/** From arrival until the message is let through or dropped, keyed by entryKey. */
const queued = new Map<string, QueuedMessage>();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const parkedMessageSchema = z.object({
  chatId: z.number(),
  threadId: z.number().optional(),
  sessionKey: z.string(),
  messageId: z.number(),
  senderId: z.number().optional(),
  /** Kept whole, because any handler may read any of it. */
  update: z.custom<MessageUpdate>((value) => isRecord(value) && isRecord(value.message)),
  /** The ack, now saying the message is set aside. Taken down when the question goes up. */
  noticeId: z.number().optional(),
  /** The question, once it's gone up. */
  reminderId: z.number().optional(),
});

type ParkedMessage = z.infer<typeof parkedMessageSchema>;

/** From the tap until it's sent or dropped, keyed by entryKey. Mirrored on disk. */
const parked = new Map<string, ParkedMessage>();

/**
 * Messages from arrival until their handler returns, per session. isProcessing
 * can't stand in for this, because a message let through a moment ago, or a voice
 * note still being transcribed, isn't a turn yet.
 */
const inFlight = new Map<SessionKey, number>();

/** Replays a message on Send, and posts the questions. */
let botRef: Bot | undefined;
let reminderTimer: NodeJS.Timeout | null = null;
let reminding = false;
/** Messages whose chat refused the question. Tried again after a restart. */
const unreachable = new Set<string>();

function entryKey(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`;
}

/**
 * Whether a message would go to Claude, or null for one with nothing to take
 * back: a video gets told it isn't supported, a sticker gets nothing. A slash
 * command the bot doesn't handle is typed at Claude, so it counts as a message.
 */
function boundForClaude(msg: Message): boolean | null {
  if (msg.text !== undefined) {
    const command = msg.text.match(/^\/(\w+)/)?.[1];
    return command === undefined || !getBotCommandNames().has(command);
  }
  return msg.voice || msg.photo || msg.document ? true : null;
}

function ackText(sessionKey: SessionKey): string {
  return !isProcessing(sessionKey) && getPtyProvider().isSessionGenerating(sessionKey)
    ? BEHIND_OWN_TURN
    : BEHIND_TURN;
}

function takeBackButton(messageId: number) {
  return { text: '🗑 Take back', callback_data: `${CALLBACK_PREFIX}${messageId}` };
}

async function postAck(api: Api, entry: QueuedMessage): Promise<number | undefined> {
  const buttons = [takeBackButton(entry.messageId)];
  // A bot command has no answer to read first, so there's nothing to decide after.
  if (entry.forClaude) {
    buttons.push({ text: '🔔 Ask me after', callback_data: `${CALLBACK_PREFIX}park:${entry.messageId}` });
  }
  try {
    const sent = await api.sendMessage(entry.chatId, ackText(entry.sessionKey), {
      // It's answering the message it hangs off, and the person who sent that
      // is looking at the chat, so a buzz would say nothing. Sent regardless of
      // whether that message still exists: deleting it doesn't recall it.
      reply_parameters: { message_id: entry.messageId, allow_sending_without_reply: true },
      reply_markup: { inline_keyboard: [buttons] },
      disable_notification: true,
      ...(entry.threadId !== undefined ? { message_thread_id: entry.threadId } : {}),
    });
    return sent.message_id;
  } catch (err) {
    console.warn('[Queued] Could not post the ack:', sanitizeError(err));
    return undefined;
  }
}

function stopAckTimer(entry: QueuedMessage): void {
  if (!entry.ackTimer) return;
  clearTimeout(entry.ackTimer);
  entry.ackTimer = null;
}

/** Note a message that has just arrived. Null when it isn't one we track. */
function noteArrival(ctx: Context): QueuedMessage | null {
  const msg = ctx.message;
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!msg || !keyInfo || isStaleMessage(msg.date)) return null;

  const forClaude = boundForClaude(msg);
  if (forClaude === null) return null;

  // Telegram redelivering one that's already waiting. Its copy passes through
  // to the handlers, which have their own duplicate check.
  const key = entryKey(keyInfo.chatId, msg.message_id);
  if (queued.has(key)) return null;

  if (forClaude && config.CANCEL_ON_NEW_MESSAGE && isProcessing(keyInfo.sessionKey)) {
    takeBackAllQueued(ctx.api, keyInfo.sessionKey);
    clearQueue(keyInfo.sessionKey);
    void cancelRequest(keyInfo.sessionKey);
  }

  const { api } = ctx;
  const entry: QueuedMessage = {
    chatId: keyInfo.chatId,
    threadId: keyInfo.threadId,
    sessionKey: keyInfo.sessionKey,
    messageId: msg.message_id,
    senderId: ctx.from?.id,
    update: ctx.update as MessageUpdate,
    forClaude,
    takenBack: false,
    parked: false,
    ackTimer: null,
    ack: null,
  };
  entry.ackTimer = setTimeout(() => {
    entry.ackTimer = null;
    entry.ack = postAck(api, entry);
  }, ACK_DELAY_MS);
  queued.set(key, entry);
  inFlight.set(entry.sessionKey, (inFlight.get(entry.sessionKey) ?? 0) + 1);
  return entry;
}

function noteHandled(sessionKey: SessionKey): void {
  const remaining = (inFlight.get(sessionKey) ?? 0) - 1;
  if (remaining > 0) inFlight.set(sessionKey, remaining);
  else inFlight.delete(sessionKey);
}

/** The wait is over and the message is going through, so the ack has served. */
function release(api: Api, entry: QueuedMessage): void {
  const key = entryKey(entry.chatId, entry.messageId);
  if (queued.get(key) !== entry) return;
  queued.delete(key);
  stopAckTimer(entry);
  void entry.ack
    ?.then((ackId) => (ackId === undefined ? undefined : api.deleteMessage(entry.chatId, ackId)))
    .catch((err: unknown) => console.warn('[Queued] Could not remove the ack:', sanitizeError(err)));
}

/**
 * Mark a message so `holdQueuedMessage` drops it, and say so on its ack. It stays
 * registered until it gets there, so the update can still be told apart from one
 * that was never tracked.
 */
function takeBack(api: Api, entry: QueuedMessage, notice: string): void {
  entry.takenBack = true;
  stopAckTimer(entry);
  void entry.ack
    ?.then((ackId) => (ackId === undefined
      ? undefined
      : api.editMessageText(entry.chatId, ackId, notice, { reply_markup: { inline_keyboard: [] } })))
    .catch((err: unknown) => console.warn('[Queued] Could not update the ack:', sanitizeError(err)));
}

/**
 * Drop every message waiting in a session. Call this before stopping the running
 * turn, because the end of that turn is what lets the next message through. One
 * set aside isn't going anywhere by itself, so it stays set aside.
 */
export function takeBackAllQueued(api: Api, sessionKey: SessionKey): number {
  let count = 0;
  for (const entry of queued.values()) {
    if (entry.sessionKey !== sessionKey || entry.takenBack || entry.parked) continue;
    takeBack(api, entry, CANCELLED);
    count++;
  }
  return count;
}

function parkedFile(): string {
  return path.join(getStateDir(), `parked-messages-${BOT_ID}.json`);
}

function saveParked(): void {
  ensureStateDir(getStateDir(), 'Queued');
  writeJsonFile(parkedFile(), { messages: [...parked.values()] }, 'Queued');
}

/** Called once, before updates flow, so a tap on an old question finds its message. */
export function initParkedMessages(bot: Bot): void {
  botRef = bot;
  const schema = z.object({ messages: z.array(parkedMessageSchema) });
  for (const message of readJsonFile(parkedFile(), schema, 'Queued')?.messages ?? []) {
    parked.set(entryKey(message.chatId, message.messageId), message);
  }
}

/** Forget what's in memory, leaving the file. Test seam, standing in for a restart. */
export function forgetParkedMessages(): void {
  parked.clear();
  unreachable.clear();
  if (reminderTimer) clearInterval(reminderTimer);
  reminderTimer = null;
  reminding = false;
}

/**
 * Whether the session has nothing left that would change the answer the question
 * is about. Background tasks don't count: they can run for hours with the session
 * free, and if one reports back, a question already asked still stands.
 */
function sessionIsIdle(sessionKey: SessionKey): boolean {
  return !inFlight.has(sessionKey)
    && !isProcessing(sessionKey)
    && !getPtyProvider().isSessionGenerating(sessionKey)
    && !hasSelfStartedTurn(sessionKey);
}

async function postReminder(api: Api, key: string, message: ParkedMessage): Promise<void> {
  try {
    const sent = await api.sendMessage(message.chatId, REMINDER, {
      // Unlike the ack this does buzz: its whole job is to reach someone who has
      // looked away. The message it hangs off is what shows what's being asked
      // about, and stays right if that message is edited.
      reply_parameters: { message_id: message.messageId, allow_sending_without_reply: true },
      reply_markup: {
        inline_keyboard: [[
          { text: '📤 Send', callback_data: `${CALLBACK_PREFIX}send:${message.messageId}` },
          { text: '🗑 Drop', callback_data: `${CALLBACK_PREFIX}drop:${message.messageId}` },
        ]],
      },
      ...(message.threadId !== undefined ? { message_thread_id: message.threadId } : {}),
    });
    const { noticeId } = message;
    message.reminderId = sent.message_id;
    delete message.noticeId;
    saveParked();
    if (noticeId !== undefined) {
      void api.deleteMessage(message.chatId, noticeId)
        .catch((err: unknown) => console.warn('[Queued] Could not remove the notice:', sanitizeError(err)));
    }
  } catch (err) {
    console.warn(`[Queued] Could not ask about message ${message.messageId}:`, sanitizeError(err));
    // Telegram said no, so asking again every poll won't help. Anything else has
    // been through auto-retry already, and the next poll is one more try.
    if (err instanceof GrammyError) unreachable.add(key);
  }
}

async function remindWhereIdle(): Promise<void> {
  if (reminding) return;
  reminding = true;
  try {
    const due = [...parked].filter(([key, message]) => message.reminderId === undefined && !unreachable.has(key));
    if (due.length === 0 && reminderTimer) {
      clearInterval(reminderTimer);
      reminderTimer = null;
    }
    for (const [key, message] of due) {
      if (!botRef || !sessionIsIdle(message.sessionKey)) continue;
      // A turn Claude started itself is only over once its reply is in the chat,
      // and the question belongs below that.
      await whenRepliesSent(message.sessionKey);
      if (parked.get(key) === message) await postReminder(botRef.api, key, message);
    }
  } finally {
    reminding = false;
  }
}

/**
 * Start looking for the moment to ask, until nothing is left to ask about. It
 * polls because the turn ending is only one of the things it's waiting for, and
 * the poll only runs while a message is set aside and not yet asked about.
 */
export function armReminders(): void {
  if (reminderTimer) return;
  reminderTimer = setInterval(() => void remindWhereIdle(), REMIND_POLL_MS);
  reminderTimer.unref();
}

/** Back through the whole chain, as if it had just arrived. */
function sendParked(message: ParkedMessage): void {
  const { update } = message;
  // Handlers ignore a message from before the bot started, which this is after
  // any restart since it arrived.
  update.message.date = Math.floor(Date.now() / 1000);
  markAlreadyAddressed(update);
  void botRef?.handleUpdate(update).catch((err: unknown) => {
    console.error(`[Queued] Sending set-aside message ${message.messageId} failed:`, sanitizeError(err));
  });
}

/** Until nothing stands between this message and Claude, or it left the line. */
async function waitForClaude(entry: QueuedMessage): Promise<void> {
  let ownTurnSince: number | null = null;
  while (!entry.takenBack && !entry.parked) {
    if (isProcessing(entry.sessionKey)) {
      ownTurnSince = null;
    } else if (!getPtyProvider().isSessionGenerating(entry.sessionKey)) {
      return;
    } else {
      ownTurnSince ??= Date.now();
      if (Date.now() - ownTurnSince >= OWN_TURN_CEILING_MS) return;
    }
    await new Promise((resolve) => setTimeout(resolve, HOLD_POLL_MS));
  }
}

/** Registered just ahead of sequentialize. */
export const trackQueuedMessage: MiddlewareFn<Context> = async (ctx, next) => {
  const entry = noteArrival(ctx);
  if (!entry) return next();
  try {
    await next();
  } finally {
    // Long gone on the normal path. This is for a chain that threw before it
    // reached holdQueuedMessage, which would otherwise leave the entry behind.
    release(ctx.api, entry);
    noteHandled(entry.sessionKey);
  }
};

/** Registered just behind sequentialize. */
export const holdQueuedMessage: MiddlewareFn<Context> = async (ctx, next) => {
  const msg = ctx.message;
  const chatId = ctx.chat?.id;
  const entry = msg && chatId !== undefined ? queued.get(entryKey(chatId, msg.message_id)) : undefined;
  if (!entry) return next();

  if (entry.forClaude) await waitForClaude(entry);

  if (entry.takenBack || entry.parked) {
    queued.delete(entryKey(entry.chatId, entry.messageId));
    const why = entry.takenBack ? 'taken back before it reached Claude' : 'set aside until its sender decides';
    console.log(`[Queued] Dropped message ${entry.messageId} in ${entry.sessionKey}: ${why}`);
    return;
  }
  release(ctx.api, entry);
  return next();
};

/**
 * An edit to a message that hasn't gone out yet is what should go out. Telegram
 * sends the whole message again, and the handlers read the update only when the
 * wait is over, so swapping it in is all there is to it.
 */
export async function handleEditedMessage(ctx: Context): Promise<void> {
  const edited = ctx.editedMessage;
  if (!edited) return;
  const key = entryKey(edited.chat.id, edited.message_id);
  const waiting = queued.get(key) ?? parked.get(key);
  if (!waiting) return;

  if (wasBatched(waiting.update.message)) {
    console.log(`[Queued] Ignored an edit to message ${edited.message_id}: merged with the messages after it`);
    return;
  }
  // The gate did this for the message as it arrived, and passes edits untouched.
  if (config.GROUP_REQUIRE_MENTION) stripBotMention(edited, ctx.me);
  waiting.update.message = edited;
  if (parked.has(key)) saveParked();
}

function maySettle(ctx: Context, senderId: number | undefined): boolean {
  return ctx.from?.id === senderId || isAdmin(ctx.from?.id);
}

async function answerNoLongerWaiting(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery({ text: 'This message is no longer waiting.' });
  // A restart forgets what was waiting and leaves its ack standing, promising
  // a delivery that won't come.
  try {
    await ctx.editMessageText(NO_LONGER_WAITING, { reply_markup: { inline_keyboard: [] } });
  } catch {
    // Its turn has started, and the ack is already gone or about to be.
  }
}

async function handleTakeBackTap(ctx: Context, key: string): Promise<void> {
  const entry = queued.get(key);
  // Set aside, perhaps with its place in line long gone.
  const setAside = parked.get(key);
  const sender = entry ?? setAside;
  if (!sender) return answerNoLongerWaiting(ctx);

  if (entry?.takenBack) {
    await ctx.answerCallbackQuery({ text: 'Already taken back.' });
    return;
  }

  if (!maySettle(ctx, sender.senderId)) {
    await ctx.answerCallbackQuery({ text: NOT_YOURS, show_alert: true });
    return;
  }

  if (setAside) {
    parked.delete(key);
    saveParked();
  }
  if (entry) {
    takeBack(ctx.api, entry, TAKEN_BACK);
  } else {
    try {
      await ctx.editMessageText(TAKEN_BACK, { reply_markup: { inline_keyboard: [] } });
    } catch (err) {
      console.warn('[Queued] Could not update the notice:', sanitizeError(err));
    }
  }
  await ctx.answerCallbackQuery({ text: 'Taken back.' });
}

async function handleParkTap(ctx: Context, key: string): Promise<void> {
  const entry = queued.get(key);
  if (!entry) return answerNoLongerWaiting(ctx);

  if (entry.takenBack || entry.parked) {
    await ctx.answerCallbackQuery({ text: entry.takenBack ? 'Already taken back.' : 'Already set aside.' });
    return;
  }

  if (!maySettle(ctx, entry.senderId)) {
    await ctx.answerCallbackQuery({ text: NOT_YOURS, show_alert: true });
    return;
  }

  // Before anything that awaits, or the turn could end and let the message through.
  entry.parked = true;
  parked.set(key, {
    chatId: entry.chatId,
    threadId: entry.threadId,
    sessionKey: entry.sessionKey,
    messageId: entry.messageId,
    senderId: entry.senderId,
    update: entry.update,
    noticeId: ctx.callbackQuery?.message?.message_id,
  });
  saveParked();
  armReminders();

  await ctx.answerCallbackQuery({ text: 'Set aside.' });
  try {
    await ctx.editMessageText(PARKED, { reply_markup: { inline_keyboard: [[takeBackButton(entry.messageId)]] } });
  } catch (err) {
    console.warn('[Queued] Could not update the ack:', sanitizeError(err));
  }
}

async function handleReminderTap(ctx: Context, key: string, action: 'send' | 'drop'): Promise<void> {
  const message = parked.get(key);
  if (!message) {
    await ctx.answerCallbackQuery({ text: 'Already dealt with.' });
    try {
      await ctx.editMessageReplyMarkup();
    } catch {
      // The tap that dealt with it took the buttons off already.
    }
    return;
  }

  if (!maySettle(ctx, message.senderId)) {
    await ctx.answerCallbackQuery({ text: NOT_YOURS, show_alert: true });
    return;
  }

  parked.delete(key);
  saveParked();
  if (action === 'send') sendParked(message);

  await ctx.answerCallbackQuery({ text: action === 'send' ? 'Sent.' : 'Dropped.' });
  try {
    await ctx.editMessageText(action === 'send' ? SENT : DROPPED, { reply_markup: { inline_keyboard: [] } });
  } catch (err) {
    console.warn('[Queued] Could not update the question:', sanitizeError(err));
  }
}

/** The buttons in this file. Registered ahead of sequentialize, or they'd wait in line too. */
export async function handleQueuedCallback(ctx: Context): Promise<void> {
  const match = ctx.callbackQuery?.data?.match(CALLBACK_PATTERN);
  const chatId = ctx.chat?.id;
  if (!match || chatId === undefined) return;

  const action = match[1];
  const key = entryKey(chatId, Number(match[2]));
  if (action === 'park') return handleParkTap(ctx, key);
  if (action === 'send' || action === 'drop') return handleReminderTap(ctx, key, action);
  return handleTakeBackTap(ctx, key);
}
