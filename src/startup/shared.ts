/**
 * Helpers shared by the startup routines that speak to Telegram.
 *
 * Each of auto-resume, auto-continue, the interrupted-task notice and the
 * restart confirmation had its own copy of the allowlist set and the
 * thread-options object, and three of them repeated the same chunked
 * delivery loop.
 */

import type { Bot } from 'grammy';
import { config } from '../config.js';
import { sendParts, sendMarkdown } from '../telegram/send.js';

/** Options spread into a sendMessage call to keep a reply in its forum thread. */
export type ThreadOpts = { message_thread_id?: number };

/** Chat ids this instance is allowed to talk to — users and groups combined. */
export function allowedChatIds(): Set<number> {
  return new Set([
    ...config.ALLOWED_USER_IDS,
    ...config.ALLOWED_GROUP_IDS,
  ]);
}

/** Thread-scoping options for a send, empty when the chat has no thread. */
export function threadOpts(threadId: number | undefined): ThreadOpts {
  return threadId !== undefined ? { message_thread_id: threadId } : {};
}

/**
 * Deliver a possibly-long block of text, split into as many messages as it
 * needs.
 *
 * `mode` picks how the text is formatted: 'escape' treats it as literal user
 * input (so a stray `*` stays a `*`), 'render' runs it through the same
 * markdown-to-entities conversion normal assistant responses use, preserving
 * bold/code/links. A part whose formatting Telegram refuses goes out again as
 * plain text (see ../telegram/send.ts).
 */
export async function sendBlockWithPlainFallback(
  bot: Bot,
  chatId: number,
  opts: ThreadOpts,
  text: string,
  label: string,
  mode: 'escape' | 'render' = 'escape',
): Promise<void> {
  try {
    if (mode === 'render') await sendMarkdown(bot.api, chatId, text, opts);
    else await sendParts(bot.api, chatId, text, opts);
  } catch (error) {
    console.error(`[${label}] Failed to deliver block:`, error);
    throw error;
  }
}
