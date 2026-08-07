/**
 * Helpers shared by the startup routines that speak to Telegram.
 *
 * Each of auto-resume, auto-continue, the interrupted-task notice and the
 * restart confirmation had its own copy of the allowlist set and the
 * thread-options object, and three of them repeated the same
 * try-MarkdownV2-then-fall-back-to-plain-text delivery loop.
 */

import type { Bot } from 'grammy';
import { config } from '../config.js';
import { splitMessage, escapeMarkdownV2, processMessageForTelegram } from '../telegram/markdown.js';

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
 * Deliver a possibly-long block of text, preferring MarkdownV2 and falling
 * back to unformatted chunks if Telegram rejects the markup.
 *
 * `mode` picks how the text becomes MarkdownV2: 'escape' treats it as literal
 * user input (so a stray `*` stays a `*`), 'render' runs it through the same
 * formatter normal assistant responses use, preserving bold/code/links.
 *
 * On the first parse failure it abandons the formatted attempt entirely and
 * re-sends the whole text as plain chunks, rather than continuing to push
 * parts that will fail the same way.
 */
export async function sendBlockWithPlainFallback(
  bot: Bot,
  chatId: number,
  opts: ThreadOpts,
  text: string,
  label: string,
  mode: 'escape' | 'render' = 'escape',
): Promise<void> {
  const parts = mode === 'render'
    ? processMessageForTelegram(text)
    : splitMessage(escapeMarkdownV2(text));

  for (const part of parts) {
    try {
      await bot.api.sendMessage(chatId, part, { parse_mode: 'MarkdownV2', ...opts });
    } catch (error) {
      console.error(`[${label}] MarkdownV2 send failed, falling back to plain text:`, error);
      for (const chunk of splitMessage(text)) {
        await bot.api.sendMessage(chatId, chunk, opts);
      }
      return;
    }
  }
}
