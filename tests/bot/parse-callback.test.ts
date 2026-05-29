import { describe, it, expect } from 'vitest';
import type { Context } from 'grammy';
import { parseCallback } from '../../src/bot/handlers/command.handler.js';

function cbCtx(opts: { chatId?: number; data?: string; topicId?: number }): Context {
  return {
    chat: opts.chatId === undefined ? undefined : { id: opts.chatId, type: 'private' },
    callbackQuery: {
      data: opts.data,
      message:
        opts.topicId === undefined
          ? undefined
          : { is_topic_message: true, message_thread_id: opts.topicId },
    },
  } as unknown as Context;
}

describe('parseCallback', () => {
  it('returns session key + data when the prefix matches', () => {
    const res = parseCallback(cbCtx({ chatId: 42, data: 'tts:voice:nova' }), 'tts:');
    expect(res).toEqual({ chatId: 42, threadId: undefined, sessionKey: '42', data: 'tts:voice:nova' });
  });

  it('carries the forum thread into the session key', () => {
    const res = parseCallback(cbCtx({ chatId: 42, data: 'project:x', topicId: 7 }), 'project:');
    expect(res?.sessionKey).toBe('42:7');
    expect(res?.threadId).toBe(7);
  });

  it('returns null when the data does not start with the prefix', () => {
    expect(parseCallback(cbCtx({ chatId: 42, data: 'other:thing' }), 'tts:')).toBeNull();
  });

  it('returns null when there is no callback data', () => {
    expect(parseCallback(cbCtx({ chatId: 42 }), 'tts:')).toBeNull();
  });

  it('returns null when there is no chat (no session key)', () => {
    expect(parseCallback(cbCtx({ data: 'tts:x' }), 'tts:')).toBeNull();
  });
});
