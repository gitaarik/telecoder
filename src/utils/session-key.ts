/**
 * Session key utilities for forum topic support.
 *
 * In regular chats, the session key is just the chatId as a string: "12345"
 * In forum topics, it combines chatId and threadId: "12345:42"
 * This allows each forum topic to have an independent session.
 */

export type SessionKey = string;

export function buildSessionKey(chatId: number, threadId?: number): SessionKey {
  return threadId !== undefined ? `${chatId}:${threadId}` : String(chatId);
}

export function parseSessionKey(key: SessionKey): { chatId: number; threadId?: number } {
  const colonIdx = key.indexOf(':');
  if (colonIdx === -1) {
    return { chatId: Number(key) };
  }
  return {
    chatId: Number(key.slice(0, colonIdx)),
    threadId: Number(key.slice(colonIdx + 1)),
  };
}

/**
 * What a per-conversation setting (model, effort, transport…) is stored under:
 * a session key, so each forum topic or private-chat thread keeps its own, or
 * a bare chat id for the chat-wide value every thread falls back to. A plain
 * chat's session key is its chat id, so there the two are the same entry.
 */
export type SettingsScope = SessionKey | number;

/** The chat a settings scope belongs to. */
export function scopeChatId(scope: SettingsScope): number {
  return typeof scope === 'number' ? scope : parseSessionKey(scope).chatId;
}

interface SessionKeyInfo {
  chatId: number;
  threadId?: number;
  sessionKey: SessionKey;
}

/**
 * Extract session key info from a Grammy context.
 * Uses message_thread_id only when is_topic_message is true (forum topics).
 */
export function getSessionKeyFromCtx(ctx: { chat?: { id: number }; message?: { is_topic_message?: boolean; message_thread_id?: number } | undefined; callbackQuery?: { message?: { is_topic_message?: boolean; message_thread_id?: number } | undefined } | undefined }): SessionKeyInfo | null {
  const chatId = ctx.chat?.id;
  if (!chatId) return null;

  const msg = ctx.message ?? ctx.callbackQuery?.message;

  const threadId = msg?.is_topic_message ? msg.message_thread_id : undefined;
  return { chatId, threadId, sessionKey: buildSessionKey(chatId, threadId) };
}
