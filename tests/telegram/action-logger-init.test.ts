/**
 * Regression coverage for ActionLogger.initialize thread resolution.
 *
 * A turn does not always start from a text message. Tapping a suggestion
 * button dispatches through the same streaming pipeline with a callback-query
 * context, where `ctx.message` is undefined and the originating message hangs
 * off `ctx.callbackQuery` instead. Reading `ctx.message` directly threw
 * "Cannot use 'in' operator to search for 'message_thread_id' in undefined"
 * and killed the turn before it started.
 */

import { describe, it, expect } from 'vitest';
import type { Context } from 'grammy';
import { ActionLogger } from '../../src/telegram/action-logger.js';

const asCtx = (ctx: unknown): Context => ctx as Context;

describe('ActionLogger.initialize', () => {
  it('activates a log for a plain message context', async () => {
    const logger = new ActionLogger();
    await logger.initialize(
      asCtx({ chat: { id: 111 }, message: { message_id: 1 } }),
      '111'
    );
    expect(logger.isActive('111')).toBe(true);
  });

  it('activates a log for a callback-query context with no ctx.message', async () => {
    const logger = new ActionLogger();
    await logger.initialize(
      asCtx({ chat: { id: 222 }, callbackQuery: { data: 'sgt:abc', message: { message_id: 9 } } }),
      '222'
    );
    expect(logger.isActive('222')).toBe(true);
  });

  it('picks up the thread from a forum-topic callback query', async () => {
    const logger = new ActionLogger();
    const sessionKey = '333:42';
    await logger.initialize(
      asCtx({
        chat: { id: 333 },
        callbackQuery: {
          data: 'sgt:abc',
          message: { message_id: 9, is_topic_message: true, message_thread_id: 42 },
        },
      }),
      sessionKey
    );
    expect(logger.isActive(sessionKey)).toBe(true);
  });

  it('ignores message_thread_id outside forum topics, matching session-key resolution', async () => {
    const logger = new ActionLogger();
    await logger.initialize(
      asCtx({
        chat: { id: 444 },
        message: { message_id: 1, message_thread_id: 77 },
      }),
      '444'
    );
    expect(logger.isActive('444')).toBe(true);
  });

  it('stays inactive when there is no chat to post into', async () => {
    const logger = new ActionLogger();
    await logger.initialize(asCtx({ callbackQuery: { data: 'sgt:abc' } }), '555');
    expect(logger.isActive('555')).toBe(false);
  });
});
