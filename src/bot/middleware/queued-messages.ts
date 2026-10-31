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
 */

import type { Api, Context, MiddlewareFn } from 'grammy';
import type { Message } from 'grammy/types';
import { config } from '../../config.js';
import { getBotCommandNames } from '../../claude/command-parser.js';
import { cancelRequest, clearQueue, isProcessing } from '../../claude/request-queue.js';
import { getPtyProvider } from '../../providers/claude-provider.js';
import { isAdmin } from '../../utils/admins.js';
import { sanitizeError } from '../../utils/sanitize.js';
import { getSessionKeyFromCtx, type SessionKey } from '../../utils/session-key.js';
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

const CALLBACK_PREFIX = 'queued:';

const BEHIND_TURN = '⏳ Queued behind the running turn.';
const BEHIND_OWN_TURN = '⏳ Queued behind a turn Claude started itself.';
const TAKEN_BACK = '🗑 Taken back before it reached Claude.';
const CANCELLED = '🛑 Cancelled before it reached Claude.';
const NO_LONGER_WAITING = '⌛ No longer waiting. If Claude never answered it, send it again.';

interface QueuedMessage {
  chatId: number;
  threadId: number | undefined;
  sessionKey: SessionKey;
  messageId: number;
  senderId: number | undefined;
  /** Bound for Claude, so it also waits for whatever Claude is doing. */
  forClaude: boolean;
  takenBack: boolean;
  /** Set until the ack is due, and cleared early if it never becomes due. */
  ackTimer: NodeJS.Timeout | null;
  /** The ack on its way, resolving to its message id. Undefined if it never landed. */
  ack: Promise<number | undefined> | null;
}

/** From arrival until the message is let through or dropped, keyed by entryKey. */
const queued = new Map<string, QueuedMessage>();

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

async function postAck(api: Api, entry: QueuedMessage): Promise<number | undefined> {
  try {
    const sent = await api.sendMessage(entry.chatId, ackText(entry.sessionKey), {
      // It's answering the message it hangs off, and the person who sent that
      // is looking at the chat, so a buzz would say nothing. Sent regardless of
      // whether that message still exists: deleting it doesn't recall it.
      reply_parameters: { message_id: entry.messageId, allow_sending_without_reply: true },
      reply_markup: {
        inline_keyboard: [[{ text: '🗑 Take back', callback_data: `${CALLBACK_PREFIX}${entry.messageId}` }]],
      },
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
    forClaude,
    takenBack: false,
    ackTimer: null,
    ack: null,
  };
  entry.ackTimer = setTimeout(() => {
    entry.ackTimer = null;
    entry.ack = postAck(api, entry);
  }, ACK_DELAY_MS);
  queued.set(key, entry);
  return entry;
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
 * turn, because the end of that turn is what lets the next message through.
 */
export function takeBackAllQueued(api: Api, sessionKey: SessionKey): number {
  let count = 0;
  for (const entry of queued.values()) {
    if (entry.sessionKey !== sessionKey || entry.takenBack) continue;
    takeBack(api, entry, CANCELLED);
    count++;
  }
  return count;
}

/** Until nothing stands between this message and Claude, or it was taken back. */
async function waitForClaude(entry: QueuedMessage): Promise<void> {
  let ownTurnSince: number | null = null;
  while (!entry.takenBack) {
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
  }
};

/** Registered just behind sequentialize. */
export const holdQueuedMessage: MiddlewareFn<Context> = async (ctx, next) => {
  const msg = ctx.message;
  const chatId = ctx.chat?.id;
  const entry = msg && chatId !== undefined ? queued.get(entryKey(chatId, msg.message_id)) : undefined;
  if (!entry) return next();

  if (entry.forClaude) await waitForClaude(entry);

  if (entry.takenBack) {
    queued.delete(entryKey(entry.chatId, entry.messageId));
    console.log(`[Queued] Dropped message ${entry.messageId} in ${entry.sessionKey}: taken back before it reached Claude`);
    return;
  }
  release(ctx.api, entry);
  return next();
};

/** The ack's button. Registered ahead of sequentialize, or it would wait in line too. */
export async function handleQueuedCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  const chatId = ctx.chat?.id;
  if (!data?.startsWith(CALLBACK_PREFIX) || chatId === undefined) return;

  const entry = queued.get(entryKey(chatId, Number(data.slice(CALLBACK_PREFIX.length))));

  if (!entry) {
    await ctx.answerCallbackQuery({ text: 'This message is no longer waiting.' });
    // A restart forgets what was waiting and leaves its ack standing, promising
    // a delivery that won't come.
    try {
      await ctx.editMessageText(NO_LONGER_WAITING, { reply_markup: { inline_keyboard: [] } });
    } catch {
      // Its turn has started, and the ack is already gone or about to be.
    }
    return;
  }

  if (entry.takenBack) {
    await ctx.answerCallbackQuery({ text: 'Already taken back.' });
    return;
  }

  if (ctx.from?.id !== entry.senderId && !isAdmin(ctx.from?.id)) {
    await ctx.answerCallbackQuery({
      text: 'Only the person who sent this, or an admin, can take it back.',
      show_alert: true,
    });
    return;
  }

  takeBack(ctx.api, entry, TAKEN_BACK);
  await ctx.answerCallbackQuery({ text: 'Taken back.' });
}
