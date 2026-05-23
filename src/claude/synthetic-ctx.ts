import type { Api, Context } from 'grammy';
import { parseSessionKey } from '../utils/session-key.js';

/**
 * Build a Grammy `Context`-shaped object that targets a specific chat/thread
 * without an inbound Telegram update. Used by the scheduler so a scheduled
 * fire can reuse the same downstream pipeline (`sendToAgent`, `messageSender.*`)
 * that real user turns flow through.
 *
 * Only the surface actually exercised by the streaming + tool-result paths is
 * wired up — `reply`, `replyWith*`, `api`, `chat`, `from`, `message`. Anything
 * else is left undefined; callers that touch it would have to deal with it
 * before scheduled firing could reach that path.
 */

export interface SyntheticCtxArgs {
  api: Api;
  sessionKey: string;
  syntheticText: string;
}

export function buildSyntheticCtx({ api, sessionKey, syntheticText }: SyntheticCtxArgs): Context {
  const { chatId, threadId } = parseSessionKey(sessionKey);
  const threadOpts = threadId !== undefined ? { message_thread_id: threadId } : {};

  // The `message` field mostly matters because `getSessionKeyFromCtx` reads
  // `is_topic_message` + `message_thread_id` off it. We supply the minimum
  // shape so threaded chats route scheduled posts back into the right topic.
  const message = {
    message_id: 0,
    date: Math.floor(Date.now() / 1000),
    text: syntheticText,
    is_topic_message: threadId !== undefined,
    message_thread_id: threadId,
    chat: { id: chatId, type: 'private' as const },
    from: { id: chatId, is_bot: false, first_name: 'scheduler' },
  };

  const ctx = {
    api,
    chat: { id: chatId, type: threadId !== undefined ? 'supergroup' : 'private' },
    from: { id: chatId, is_bot: false, first_name: 'scheduler', username: 'scheduler' },
    message,
    callbackQuery: undefined,
    me: undefined,
    update: { update_id: 0, message },

    async reply(text: string, opts: Record<string, unknown> = {}) {
      return api.sendMessage(chatId, text, { ...threadOpts, ...opts });
    },
    async replyWithDocument(file: unknown, opts: Record<string, unknown> = {}) {
      // Casts mirror Grammy's API which accepts the same union as InputFile.
      return api.sendDocument(chatId, file as never, { ...threadOpts, ...opts });
    },
    async replyWithPhoto(file: unknown, opts: Record<string, unknown> = {}) {
      return api.sendPhoto(chatId, file as never, { ...threadOpts, ...opts });
    },
    async replyWithVideo(file: unknown, opts: Record<string, unknown> = {}) {
      return api.sendVideo(chatId, file as never, { ...threadOpts, ...opts });
    },
    async replyWithAudio(file: unknown, opts: Record<string, unknown> = {}) {
      return api.sendAudio(chatId, file as never, { ...threadOpts, ...opts });
    },
    async replyWithVoice(file: unknown, opts: Record<string, unknown> = {}) {
      return api.sendVoice(chatId, file as never, { ...threadOpts, ...opts });
    },
  };

  // `as unknown as Context` is the contract: we promise the downstream
  // pipeline only reads the methods/fields above. If a new code path starts
  // touching different ctx surface, it'll surface immediately as a runtime
  // error here rather than silently doing the wrong thing.
  return ctx as unknown as Context;
}
