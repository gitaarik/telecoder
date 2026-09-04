import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context, NextFunction } from 'grammy';
import type { MessageEntity } from 'grammy/types';
import { groupMentionMiddleware, isAddressedToBot } from '../../src/bot/middleware/group-mention.middleware.js';
import { rememberForceReplyPrompt, clearForceReplyPrompts } from '../../src/telegram/force-reply-tracker.js';
import { config } from '../../src/config.js';

const BOT_ID = 8833142947;
const BOT_USERNAME = 'code_share1_bot';
const GROUP = -1009990001;
const PROMPT_MSG_ID = 4242;

/**
 * Build the entities Telegram would attach: a bot_command at offset 0 and a
 * mention per @handle. Keeps the tests readable — they pass plain strings.
 */
function entitiesFor(text: string): MessageEntity[] {
  const entities: MessageEntity[] = [];
  const command = text.match(/^\/[\w@]+/);
  if (command) entities.push({ type: 'bot_command', offset: 0, length: command[0].length });
  const mention = /@\w+/g;
  for (let m = mention.exec(text); m; m = mention.exec(text)) {
    if (command && m.index < command[0].length) continue; // part of /cmd@bot
    entities.push({ type: 'mention', offset: m.index, length: m[0].length });
  }
  return entities;
}

interface FakeCtxOptions {
  text?: string;
  caption?: string;
  chatType?: string;
  replyFromId?: number;
  replyToId?: number;
  entities?: MessageEntity[];
  noMessage?: boolean;
}

function makeCtx(opts: FakeCtxOptions) {
  const body = opts.text ?? opts.caption ?? '';
  const message = opts.noMessage
    ? undefined
    : {
        ...(opts.caption === undefined ? { text: body } : { caption: body }),
        ...(opts.caption === undefined
          ? { entities: opts.entities ?? entitiesFor(body) }
          : { caption_entities: opts.entities ?? entitiesFor(body) }),
        ...(opts.replyFromId === undefined
          ? {}
          : { reply_to_message: { from: { id: opts.replyFromId }, message_id: opts.replyToId ?? PROMPT_MSG_ID } }),
      };
  const ctx = {
    chat: { id: GROUP, type: opts.chatType ?? 'group' },
    message,
    me: { id: BOT_ID, username: BOT_USERNAME, is_bot: true, first_name: 'TeleCoder Shared' },
  } as unknown as Context;
  return ctx;
}

describe('isAddressedToBot', () => {
  beforeEach(() => clearForceReplyPrompts());

  it('lets everything through in a private chat', () => {
    expect(isAddressedToBot(makeCtx({ text: 'no mention here', chatType: 'private' }))).toBe(true);
  });

  it('ignores ordinary group chatter between people', () => {
    expect(isAddressedToBot(makeCtx({ text: 'shall we get lunch?' }))).toBe(false);
  });

  it('accepts a message that @mentions the bot', () => {
    expect(isAddressedToBot(makeCtx({ text: `@${BOT_USERNAME} what's the state of this project?` }))).toBe(true);
  });

  it('accepts a mention anywhere in the message, in any case', () => {
    expect(isAddressedToBot(makeCtx({ text: `hey @${BOT_USERNAME.toUpperCase()} take a look` }))).toBe(true);
  });

  it('ignores a mention of a different bot', () => {
    expect(isAddressedToBot(makeCtx({ text: '@some_other_bot are you there?' }))).toBe(false);
  });

  it('ignores a plain reply to the bot — quoting is not addressing', () => {
    expect(isAddressedToBot(makeCtx({ text: 'yes, do that', replyFromId: BOT_ID }))).toBe(false);
  });

  it('accepts a reply to the bot that also mentions it', () => {
    expect(isAddressedToBot(makeCtx({ text: `@${BOT_USERNAME} yes, do that`, replyFromId: BOT_ID }))).toBe(true);
  });

  it('accepts an answer to a ForceReply prompt, which has nowhere for a mention', () => {
    rememberForceReplyPrompt(GROUP, PROMPT_MSG_ID);
    expect(isAddressedToBot(makeCtx({ text: '/home/me/projects/api', replyFromId: BOT_ID }))).toBe(true);
  });

  it('still ignores a reply to a bot message that was not a ForceReply prompt', () => {
    rememberForceReplyPrompt(GROUP, PROMPT_MSG_ID + 1);
    expect(isAddressedToBot(makeCtx({ text: 'nice one', replyFromId: BOT_ID }))).toBe(false);
  });

  it('does not mistake a pasted absolute path for a command', () => {
    expect(isAddressedToBot(makeCtx({ text: '/home/me/projects/api is where it lives' }))).toBe(false);
  });

  it('scopes remembered prompts to their chat', () => {
    rememberForceReplyPrompt(-1009990002, PROMPT_MSG_ID);
    expect(isAddressedToBot(makeCtx({ text: '/home/me/projects/api', replyFromId: BOT_ID }))).toBe(false);
  });

  it('accepts any reply when GROUP_REPLY_IS_MENTION is on', () => {
    const previous = config.GROUP_REPLY_IS_MENTION;
    (config as { GROUP_REPLY_IS_MENTION: boolean }).GROUP_REPLY_IS_MENTION = true;
    try {
      expect(isAddressedToBot(makeCtx({ text: 'yes, do that', replyFromId: BOT_ID }))).toBe(true);
    } finally {
      (config as { GROUP_REPLY_IS_MENTION: boolean }).GROUP_REPLY_IS_MENTION = previous;
    }
  });

  it('ignores a reply to another person', () => {
    expect(isAddressedToBot(makeCtx({ text: 'agreed', replyFromId: 12345 }))).toBe(false);
  });

  it('accepts a command aimed at this bot', () => {
    expect(isAddressedToBot(makeCtx({ text: `/status@${BOT_USERNAME}` }))).toBe(true);
  });

  it('ignores a command aimed at another bot in the same group', () => {
    expect(isAddressedToBot(makeCtx({ text: '/status@some_other_bot' }))).toBe(false);
  });

  it('accepts a bare slash command', () => {
    expect(isAddressedToBot(makeCtx({ text: '/project' }))).toBe(true);
  });

  it('accepts a photo whose caption mentions the bot', () => {
    expect(isAddressedToBot(makeCtx({ caption: `@${BOT_USERNAME} what is this?` }))).toBe(true);
  });

  it('ignores a photo shared between people', () => {
    expect(isAddressedToBot(makeCtx({ caption: 'look at this' }))).toBe(false);
  });

  it('lets non-message updates through (button taps)', () => {
    expect(isAddressedToBot(makeCtx({ noMessage: true }))).toBe(true);
  });

  it('answers a mention that opens with a code comment', () => {
    expect(isAddressedToBot(makeCtx({ text: `// TODO: fix this @${BOT_USERNAME}` }))).toBe(true);
  });

  it('accepts a text_mention of the bot (entity without a handle in the text)', () => {
    const ctx = makeCtx({
      text: 'TeleCoder Shared have a look',
      entities: [{ type: 'text_mention', offset: 0, length: 16, user: { id: BOT_ID, is_bot: true, first_name: 'TeleCoder Shared' } }],
    });
    expect(isAddressedToBot(ctx)).toBe(true);
  });
});

describe('groupMentionMiddleware', () => {
  let next: NextFunction & ReturnType<typeof vi.fn>;

  beforeEach(() => {
    next = vi.fn().mockResolvedValue(undefined) as unknown as NextFunction & ReturnType<typeof vi.fn>;
  });

  it('drops an unaddressed group message without calling next', async () => {
    await groupMentionMiddleware(makeCtx({ text: 'just us talking' }), next);
    expect(next).not.toHaveBeenCalled();
  });

  it('strips the bot mention so the agent gets a clean prompt', async () => {
    const ctx = makeCtx({ text: `@${BOT_USERNAME} what's the state of this project?` });
    await groupMentionMiddleware(ctx, next);
    expect(next).toHaveBeenCalledOnce();
    expect(ctx.message?.text).toBe("what's the state of this project?");
  });

  it('strips a mid-sentence mention and closes the gap', async () => {
    const ctx = makeCtx({ text: `hey @${BOT_USERNAME} can you check the logs?` });
    await groupMentionMiddleware(ctx, next);
    expect(ctx.message?.text).toBe('hey can you check the logs?');
  });

  it('strips a mention from a media caption', async () => {
    const ctx = makeCtx({ caption: `@${BOT_USERNAME} what is this?` });
    await groupMentionMiddleware(ctx, next);
    expect(ctx.message?.caption).toBe('what is this?');
  });

  it('keeps the text of a bare mention rather than passing an empty prompt', async () => {
    const ctx = makeCtx({ text: `@${BOT_USERNAME}` });
    await groupMentionMiddleware(ctx, next);
    expect(next).toHaveBeenCalledOnce();
    expect(ctx.message?.text).toBe(`@${BOT_USERNAME}`);
  });

  it('drops a plain reply to the bot without calling next', async () => {
    await groupMentionMiddleware(makeCtx({ text: 'quoting this for you', replyFromId: BOT_ID }), next);
    expect(next).not.toHaveBeenCalled();
  });

  it('leaves a command untouched for the command handlers', async () => {
    const ctx = makeCtx({ text: `/status@${BOT_USERNAME}` });
    await groupMentionMiddleware(ctx, next);
    expect(next).toHaveBeenCalledOnce();
    expect(ctx.message?.text).toBe(`/status@${BOT_USERNAME}`);
  });
});
