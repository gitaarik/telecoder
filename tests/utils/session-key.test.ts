import { describe, it, expect } from 'vitest';
import {
  buildSessionKey,
  parseSessionKey,
  getSessionKeyFromCtx,
} from '../../src/utils/session-key.js';

describe('buildSessionKey', () => {
  it('returns just the chatId in regular chats', () => {
    expect(buildSessionKey(12345)).toBe('12345');
  });

  it('combines chatId and threadId for forum topics', () => {
    expect(buildSessionKey(12345, 42)).toBe('12345:42');
  });

  it('treats threadId 0 as present (not undefined)', () => {
    expect(buildSessionKey(12345, 0)).toBe('12345:0');
  });

  it('handles negative group chat ids', () => {
    expect(buildSessionKey(-1001234567890, 7)).toBe('-1001234567890:7');
  });
});

describe('parseSessionKey', () => {
  it('parses a plain chatId', () => {
    expect(parseSessionKey('12345')).toEqual({ chatId: 12345 });
  });

  it('parses a chatId:threadId key', () => {
    expect(parseSessionKey('12345:42')).toEqual({ chatId: 12345, threadId: 42 });
  });

  it('round-trips with buildSessionKey', () => {
    expect(parseSessionKey(buildSessionKey(-100, 5))).toEqual({ chatId: -100, threadId: 5 });
  });
});

describe('getSessionKeyFromCtx', () => {
  it('returns null when there is no chat', () => {
    expect(getSessionKeyFromCtx({})).toBeNull();
  });

  it('uses chatId only for non-topic messages', () => {
    const result = getSessionKeyFromCtx({ chat: { id: 999 }, message: {} });
    expect(result).toEqual({ chatId: 999, threadId: undefined, sessionKey: '999' });
  });

  it('includes threadId only when is_topic_message is true', () => {
    const result = getSessionKeyFromCtx({
      chat: { id: 999 },
      message: { is_topic_message: true, message_thread_id: 8 },
    });
    expect(result).toEqual({ chatId: 999, threadId: 8, sessionKey: '999:8' });
  });

  it('ignores message_thread_id when is_topic_message is falsy', () => {
    const result = getSessionKeyFromCtx({
      chat: { id: 999 },
      message: { message_thread_id: 8 },
    });
    expect(result?.sessionKey).toBe('999');
  });

  it('falls back to callbackQuery.message when message is absent', () => {
    const result = getSessionKeyFromCtx({
      chat: { id: 7 },
      callbackQuery: { message: { is_topic_message: true, message_thread_id: 3 } },
    });
    expect(result).toEqual({ chatId: 7, threadId: 3, sessionKey: '7:3' });
  });
});
