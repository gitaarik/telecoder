/**
 * Message batching middleware.
 *
 * When Telegram splits a long message into multiple chunks (>4096 chars),
 * they arrive as separate updates in rapid succession. This middleware
 * buffers consecutive text messages per session and combines them into a
 * single message before passing it down the middleware chain.
 *
 * Only a message long enough to be the front part of a split opens a batch, so
 * an ordinary message isn't held up waiting for parts that will never come.
 * Once a batch is open, every text message in the session joins it, however
 * short (the last part usually is) and even if it starts with a slash, since a
 * split can land just before a path.
 *
 * Must be registered BEFORE grammY's `sequentialize` middleware so that
 * concurrent same-session updates are still visible (sequentialize would
 * serialize them and prevent batching).
 */

import { type Context, type MiddlewareFn } from 'grammy';
import { buildSessionKey } from '../../utils/session-key.js';
import { config } from '../../config.js';

interface PendingBatch {
  texts: string[];
  timer: NodeJS.Timeout;
  resolve: () => void;
}

const batches: Map<string, PendingBatch> = new Map();

/**
 * The shortest message that may have more parts coming. Clients split at 4096
 * characters but back up to a paragraph or word break to do it, so the front
 * part can come out well short of that.
 */
export const SPLIT_PART_MIN_LENGTH = 2000;

/**
 * Whether this message carries the text of several. An edit to one of them can't
 * be applied, since it would replace the text of the lot. The mark is on the
 * message itself so it stays with a message saved to disk.
 */
export function wasBatched(message: object): boolean {
  return (message as { batched?: boolean }).batched === true;
}

export function createBatchMiddleware(): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const timeoutMs = config.MESSAGE_BATCH_TIMEOUT_MS;

    // Skip batching if disabled or not a text message
    if (timeoutMs <= 0 || !ctx.message?.text) {
      return next();
    }

    const text = ctx.message.text;

    // Determine session key
    const chatId = ctx.chat?.id;
    if (!chatId) return next();
    const msg = ctx.message as { is_topic_message?: boolean; message_thread_id?: number };
    const threadId = msg.is_topic_message ? msg.message_thread_id : undefined;
    const sessionKey = buildSessionKey(chatId, threadId);

    const existing = batches.get(sessionKey);
    if (existing) {
      // Subsequent message: merge into existing batch, reset timer, drop this update
      existing.texts.push(text);
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => {
        batches.delete(sessionKey);
        existing.resolve();
      }, timeoutMs);
      console.log(`[Batcher] Merged message into batch for ${sessionKey} (${existing.texts.length} parts)`);
      return; // don't call next() — this update is absorbed
    }

    // Don't batch commands, or a message too short to have been split
    if (text.startsWith('/') || text.length < SPLIT_PART_MIN_LENGTH) {
      return next();
    }

    // First message: create batch and await the timer
    const batchTexts: string[] = [text];
    await new Promise<void>((resolve) => {
      batches.set(sessionKey, {
        texts: batchTexts,
        timer: setTimeout(() => {
          batches.delete(sessionKey);
          resolve();
        }, timeoutMs),
        resolve,
      });
    });

    // Timer fired — inject combined text into context
    if (batchTexts.length > 1) {
      console.log(`[Batcher] Combined ${batchTexts.length} messages for ${sessionKey}`);
      Object.assign(ctx.message, { text: batchTexts.join('\n'), batched: true });
    }

    return next();
  };
}
