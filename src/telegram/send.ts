/**
 * Sending formatted text to Telegram: every message goes out as plain text
 * plus entities (see ./entities.ts), never with a parse mode.
 *
 * These wrap the three things a handler does with text — reply, send to a
 * chat, edit — so a call site hands over an {@link EntityMessage} (or
 * markdown) and the splitting, trimming and the plain-text fallback happen in
 * one place.
 */

import { GrammyError, type Api, type Context } from 'grammy';
import type { Message, MessageEntity } from 'grammy/types';
import { trimMessage, plain, type EntityMessage } from './entities.js';
import { formatMarkdown, splitEntityMessage, MAX_ENTITIES, MAX_MESSAGE_LENGTH } from './markdown.js';

type SendOther = Parameters<Api['sendMessage']>[2];
type EditOther = Parameters<Api['editMessageText']>[3];

/** Text, or a message already built with entities. A string is sent unformatted. */
export type Formatted = string | EntityMessage;

function asMessage(text: Formatted): EntityMessage {
  return trimMessage(typeof text === 'string' ? plain(text) : text);
}

/**
 * Telegram turned the formatting down rather than the message. It only does
 * that for an entity it won't accept — a link it can't open, an offset off
 * the end — and the same text without them will go through.
 */
export function isEntityError(error: unknown): boolean {
  if (!(error instanceof GrammyError) || error.error_code !== 400) return false;
  return /entit|can't parse|wrong (?:http )?url|url host is empty|unsupported url protocol/i.test(error.description);
}

/** `other` with the message's entities on it, and no parse mode. */
function withEntities<T extends object | undefined>(other: T, entities: MessageEntity[]): T {
  const { parse_mode: _ignored, ...rest } = (other ?? {}) as { parse_mode?: unknown };
  return { ...rest, entities } as T;
}

type Poster = (text: string, other: SendOther) => Promise<Message.TextMessage>;

/** Post one message through `post`, unformatted again if Telegram refuses the formatting. */
async function postOne(post: Poster, text: Formatted, other?: SendOther): Promise<Message.TextMessage> {
  const message = fitOne(asMessage(text));
  try {
    return await post(message.text || '…', withEntities(other, message.entities));
  } catch (error) {
    if (!isEntityError(error) || message.entities.length === 0) throw error;
    console.error('[Send] Telegram refused the formatting, sending plain text:', (error as GrammyError).description);
    return post(message.text, withEntities(other, []));
  }
}

function apiPoster(api: Api, chatId: number | string): Poster {
  return (text, other) => api.sendMessage(chatId, text, other);
}

/** `ctx.reply`, which keeps a reply in the forum topic it answers. */
function replyPoster(ctx: Context): Poster {
  return (text, other) => ctx.reply(text, other);
}

/**
 * Send one message — it must fit in one; see {@link sendParts} for anything
 * longer. Retries once unformatted if Telegram refuses the formatting.
 */
export async function sendFormatted(
  api: Api,
  chatId: number | string,
  text: Formatted,
  other?: SendOther,
): Promise<Message.TextMessage> {
  return postOne(apiPoster(api, chatId), text, other);
}

/** {@link sendFormatted} as a reply in the chat (and topic) `ctx` came from. */
export async function replyFormatted(ctx: Context, text: Formatted, other?: SendOther): Promise<Message.TextMessage> {
  return postOne(replyPoster(ctx), text, other);
}

/**
 * Edit a message's text. A message that has grown past Telegram's limit is
 * clipped: an edit can't split, so whoever needs the rest must send it.
 * Retries unformatted if Telegram refuses the formatting.
 */
export async function editFormatted(
  api: Api,
  chatId: number | string,
  messageId: number,
  text: Formatted,
  other?: EditOther,
): Promise<void> {
  const message = fitOne(asMessage(text));
  try {
    await api.editMessageText(chatId, messageId, message.text || '…', withEntities(other, message.entities));
  } catch (error) {
    if (!isEntityError(error) || message.entities.length === 0) throw error;
    console.error('[Send] Telegram refused the formatting, editing to plain text:', (error as GrammyError).description);
    await api.editMessageText(chatId, messageId, message.text, withEntities(other, []));
  }
}

/** {@link editFormatted} on the message a callback query's button sits on. */
export async function editCallbackMessage(ctx: Context, text: Formatted, other?: EditOther): Promise<void> {
  const message = ctx.callbackQuery?.message;
  const chatId = message?.chat.id ?? ctx.chat?.id;
  if (!message || chatId === undefined) throw new Error('editCallbackMessage: no message on this update');
  await editFormatted(ctx.api, chatId, message.message_id, text, other);
}

/**
 * Send a message of any length as however many parts it needs. `other` goes on
 * every part except `reply_markup`, which goes on the last, under the end of
 * the text. Returns the parts as sent.
 */
export async function sendParts(
  api: Api,
  chatId: number | string,
  text: Formatted,
  other?: SendOther,
): Promise<Message.TextMessage[]> {
  return postSplit(apiPoster(api, chatId), splitEntityMessage(asMessage(text)), other);
}

/** {@link sendParts} from markdown: the way the model's own text is sent. */
export async function sendMarkdown(
  api: Api,
  chatId: number | string,
  markdown: string,
  other?: SendOther,
): Promise<Message.TextMessage[]> {
  return postSplit(apiPoster(api, chatId), formatMarkdown(markdown), other);
}

/** {@link sendParts} as replies in the chat (and topic) `ctx` came from. */
export async function replyParts(ctx: Context, text: Formatted, other?: SendOther): Promise<Message.TextMessage[]> {
  return postSplit(replyPoster(ctx), splitEntityMessage(asMessage(text)), other);
}

/** {@link sendMarkdown} as replies in the chat (and topic) `ctx` came from. */
export async function replyMarkdown(ctx: Context, markdown: string, other?: SendOther): Promise<Message.TextMessage[]> {
  return postSplit(replyPoster(ctx), formatMarkdown(markdown), other);
}

async function postSplit(post: Poster, parts: EntityMessage[], other?: SendOther): Promise<Message.TextMessage[]> {
  const { reply_markup, ...rest } = other ?? {};
  const sent: Message.TextMessage[] = [];
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    sent.push(await postOne(post, parts[i], last && reply_markup ? { ...rest, reply_markup } : rest));
  }
  return sent;
}

/** A message cut down to one Telegram message, ending in an ellipsis. */
function fitOne(message: EntityMessage): EntityMessage {
  if (message.text.length <= MAX_MESSAGE_LENGTH && message.entities.length <= MAX_ENTITIES) return message;
  const [first] = splitEntityMessage(message, MAX_MESSAGE_LENGTH - 1, { markers: false });
  return { text: first.text + '…', entities: first.entities };
}
