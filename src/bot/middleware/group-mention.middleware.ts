/**
 * "Is this message actually for the bot?" — the group-chat gate.
 *
 * With Telegram's privacy mode disabled (required for the bot to see ordinary
 * text at all), every message in the group reaches us, including people
 * talking to each other. Running an agent turn on all of it makes the bot
 * unusable in a group that has human conversation in it, so in groups a
 * message has to address the bot to get through.
 *
 * Addressed means one of:
 *   - an @mention of this bot's username
 *   - a reply to something this bot sent (how ForceReply prompts like
 *     /project and /plan get answered — those replies carry no mention)
 *   - a slash command meant for this bot (`/status` or `/status@this_bot`)
 *
 * ...unless the message opens with GROUP_IGNORE_PREFIX, which opts it out
 * whatever else it looks like.
 *
 * Private chats are never gated: a DM is addressed to the bot by definition.
 */

import { type Context, type MiddlewareFn } from 'grammy';
import type { MessageEntity, UserFromGetMe } from 'grammy/types';
import { config } from '../../config.js';

type TextAndEntities = { text: string; entities: MessageEntity[] };

/** A message's text or its media caption, whichever carries the words. */
function textAndEntities(msg: NonNullable<Context['message']>): TextAndEntities {
  if (typeof msg.text === 'string') return { text: msg.text, entities: msg.entities ?? [] };
  return { text: msg.caption ?? '', entities: msg.caption_entities ?? [] };
}

/** True if `@username` (or a text_mention of the bot's user) appears in the message. */
function mentionsBot({ text, entities }: TextAndEntities, me: UserFromGetMe): boolean {
  const handle = `@${me.username.toLowerCase()}`;
  return entities.some((e) => {
    if (e.type === 'text_mention') return e.user.id === me.id;
    if (e.type !== 'mention') return false;
    return text.slice(e.offset, e.offset + e.length).toLowerCase() === handle;
  });
}

/**
 * True if the message opens with a slash command this bot should see.
 *
 * `/status@other_bot` in a group with several bots is not ours; a bare
 * `/status` is, and grammy's command handlers decide from there.
 */
function isCommandForBot({ text, entities }: TextAndEntities, me: UserFromGetMe): boolean {
  const cmd = entities.find((e) => e.type === 'bot_command' && e.offset === 0);
  if (!cmd) return false;
  const token = text.slice(cmd.offset, cmd.offset + cmd.length);
  const at = token.indexOf('@');
  return at === -1 || token.slice(at + 1).toLowerCase() === me.username.toLowerCase();
}

/**
 * The opt-out: a message opening with GROUP_IGNORE_PREFIX is never a prompt,
 * even when it replies to the bot or mentions it.
 *
 * Replying is how you quote a message in Telegram, so people need a way to
 * point at something the bot said while talking to each other about it. The
 * prefix stays visible in the chat, which makes "the bot is sitting this one
 * out" obvious to everyone reading.
 */
function isOptedOut(text: string): boolean {
  const prefix = config.GROUP_IGNORE_PREFIX;
  return prefix !== '' && text.trimStart().startsWith(prefix);
}

/**
 * Whether an update should reach the handlers. Non-message updates (callback
 * queries from inline keyboards, edits, service messages) pass untouched —
 * a button tap is already an explicit interaction with the bot.
 */
export function isAddressedToBot(ctx: Context): boolean {
  const chatType = ctx.chat?.type;
  if (chatType !== 'group' && chatType !== 'supergroup') return true;

  const msg = ctx.message;
  if (!msg) return true;

  const content = textAndEntities(msg);
  if (isOptedOut(content.text)) return false;

  if (msg.reply_to_message?.from?.id === ctx.me.id) return true;

  return isCommandForBot(content, ctx.me) || mentionsBot(content, ctx.me);
}

/**
 * Remove the bot's @mention from the prompt so the agent reads "what's the
 * state of this project?" rather than "@this_bot what's the state of this
 * project?". Nothing downstream reads entities, so rewriting the text in
 * place is safe; a message that is *only* a mention keeps its text, since an
 * empty prompt is worse than a redundant one.
 */
function stripBotMention(msg: NonNullable<Context['message']>, me: UserFromGetMe): void {
  const { text, entities } = textAndEntities(msg);
  if (!text) return;

  const handle = `@${me.username.toLowerCase()}`;
  const mentions = entities.filter(
    (e) => e.type === 'mention' && text.slice(e.offset, e.offset + e.length).toLowerCase() === handle,
  );
  if (mentions.length === 0) return;

  let stripped = text;
  // Right to left, so each removal leaves the earlier offsets valid.
  for (const e of [...mentions].sort((a, b) => b.offset - a.offset)) {
    stripped = stripped.slice(0, e.offset) + stripped.slice(e.offset + e.length);
  }
  stripped = stripped.replace(/\s{2,}/g, ' ').trim();
  if (!stripped) return;

  if (typeof msg.text === 'string') (msg as { text: string }).text = stripped;
  else (msg as { caption: string }).caption = stripped;
}

/**
 * Drop group messages that aren't addressed to the bot. Silent by design —
 * the point is that people can talk to each other without the bot chiming in
 * or logging a line per message.
 */
export const groupMentionMiddleware: MiddlewareFn<Context> = async (ctx, next) => {
  if (!config.GROUP_REQUIRE_MENTION) return next();
  if (!isAddressedToBot(ctx)) return;
  if (ctx.message) stripBotMention(ctx.message, ctx.me);
  return next();
};
