/**
 * Remembers which of the bot's own messages were ForceReply prompts.
 *
 * In a group the bot only answers when it is @mentioned, but the ForceReply
 * flows (`/project`, `/plan`, `/file`, …) are answered by replying to the
 * prompt — Telegram pops the composer open with the reply already attached,
 * and there is nowhere to put a mention. Those replies have to stay
 * addressed, so the gate needs to tell "answering a prompt" apart from
 * "quoting something the bot said".
 *
 * Rather than re-deriving that from the prompt's wording (a list that would
 * drift from the handlers), a transformer watches outgoing sendMessage calls
 * and records the id of any message sent with a force_reply keyboard.
 *
 * The ids live in memory only: these prompts are answered within seconds, and
 * a prompt left hanging across a restart is better re-opened than resurrected.
 */

import type { Bot } from 'grammy';

/** Plenty for any realistic number of prompts open at once; bounds the set. */
const MAX_TRACKED = 200;

const prompts = new Set<string>();

const key = (chatId: number, messageId: number): string => `${chatId}:${messageId}`;

export function rememberForceReplyPrompt(chatId: number, messageId: number): void {
  const k = key(chatId, messageId);
  // Re-inserting moves it to the end, so the oldest entry is always first out.
  prompts.delete(k);
  prompts.add(k);
  while (prompts.size > MAX_TRACKED) {
    const oldest = prompts.values().next();
    if (oldest.done) break;
    prompts.delete(oldest.value);
  }
}

export function isForceReplyPrompt(chatId: number, messageId: number): boolean {
  return prompts.has(key(chatId, messageId));
}

/** Test seam — the set is module state that would otherwise leak between cases. */
export function clearForceReplyPrompts(): void {
  prompts.clear();
}

/** Record every ForceReply prompt this bot sends. Call once, at startup. */
export function trackForceReplyPrompts(bot: Bot): void {
  bot.api.config.use(async (prev, method, payload, signal) => {
    const res = await prev(method, payload, signal);
    if (method !== 'sendMessage' || !res.ok) return res;

    const markup = (payload as { reply_markup?: { force_reply?: boolean } }).reply_markup;
    if (!markup?.force_reply) return res;

    const sent = res.result as unknown as { message_id?: number; chat?: { id?: number } };
    if (typeof sent?.message_id === 'number' && typeof sent.chat?.id === 'number') {
      rememberForceReplyPrompt(sent.chat.id, sent.message_id);
    }
    return res;
  });
}
