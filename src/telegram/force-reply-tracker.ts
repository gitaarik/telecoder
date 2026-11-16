/**
 * Remembers which of the bot's own messages were ForceReply prompts, and which
 * flow each one opened.
 *
 * A ForceReply flow (`/project`, `/transcribe`) posts a question and
 * takes the user's reply to it as the answer: Telegram pops the composer open
 * with the reply already attached. Two things need to know a reply answers a
 * prompt:
 *
 *   - the message handlers, to route the answer to the flow that asked, which
 *     {@link forceReplyFlow} tells them from the prompt's id rather than from
 *     its wording — a list of phrases that would drift from the handlers;
 *   - the group mention gate, since in a group the bot only answers when it is
 *     @mentioned and a reply to a prompt has nowhere to put a mention. A
 *     transformer watches outgoing sendMessage calls and records every message
 *     sent with a force_reply keyboard, so that gate holds for a prompt sent
 *     any other way too.
 *
 * The ids live in memory only: these prompts are answered within seconds, and
 * a prompt left hanging across a restart is better re-opened than resurrected.
 */

import type { Bot, Context } from 'grammy';
import type { Formatted } from './send.js';
import { replyFormatted } from './send.js';

export type ForceReplyFlow = 'project' | 'transcribe';

/** Plenty for any realistic number of prompts open at once; bounds the map. */
const MAX_TRACKED = 200;

/** Prompt → the flow it opened, or undefined for one sent outside {@link sendForceReplyPrompt}. */
const prompts = new Map<string, ForceReplyFlow | undefined>();

const key = (chatId: number, messageId: number): string => `${chatId}:${messageId}`;

export function rememberForceReplyPrompt(chatId: number, messageId: number, flow?: ForceReplyFlow): void {
  const k = key(chatId, messageId);
  // Re-inserting moves it to the end, so the oldest entry is always first out.
  // The transformer records a prompt first, without its flow; the sender then
  // names the flow, which must not be lost to a later nameless record.
  const known = prompts.get(k);
  prompts.delete(k);
  prompts.set(k, flow ?? known);
  while (prompts.size > MAX_TRACKED) {
    const oldest = prompts.keys().next();
    if (oldest.done) break;
    prompts.delete(oldest.value);
  }
}

export function isForceReplyPrompt(chatId: number, messageId: number): boolean {
  return prompts.has(key(chatId, messageId));
}

/** The flow a reply to `messageId` answers, or undefined when it answers no open prompt. */
export function forceReplyFlow(chatId: number, messageId: number): ForceReplyFlow | undefined {
  return prompts.get(key(chatId, messageId));
}

/**
 * The flow the message being replied to opened, if it is one of this bot's
 * prompts. Undefined for a message that isn't a reply, replies to a user, or
 * replies to a bot message that was no prompt (or one from before a restart).
 */
export function repliedForceReplyFlow(ctx: Context): ForceReplyFlow | undefined {
  const replyTo = ctx.message?.reply_to_message;
  const chatId = ctx.chat?.id;
  if (!replyTo?.from?.is_bot || chatId === undefined) return undefined;
  return forceReplyFlow(chatId, replyTo.message_id);
}

/**
 * Post a ForceReply prompt for `flow` and remember which flow it opened.
 * `selective` keeps the composer from opening for everyone else in a group.
 */
export async function sendForceReplyPrompt(ctx: Context, flow: ForceReplyFlow, text: Formatted, placeholder: string): Promise<void> {
  const sent = await replyFormatted(ctx, text, {
    reply_markup: {
      force_reply: true,
      input_field_placeholder: placeholder,
      selective: true,
    },
  });
  rememberForceReplyPrompt(sent.chat.id, sent.message_id, flow);
}

/** Test seam — the map is module state that would otherwise leak between cases. */
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
