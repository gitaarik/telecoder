/**
 * A deleted thread is let go of — its turn stopped, its claude ended, its
 * session, name and settings dropped — when /deletethread deletes it, or when
 * a send into it fails the way a send into a deleted thread does. The parts
 * that hold the state are stubbed, so these tests see what gets let go.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Bot, Context } from 'grammy';
import { GrammyError } from 'grammy';

const stopTurn = vi.fn(async () => ({ stopped: true, dropped: 0 }));
vi.mock('../../src/bot/middleware/queued-messages.js', () => ({ stopTurn }));
const clearConversation = vi.fn();
vi.mock('../../src/providers/provider-router.js', () => ({ clearConversation }));
const releaseHeldQuery = vi.fn(() => false);
vi.mock('../../src/claude/held-query.js', () => ({ releaseHeldQuery }));
const clearSession = vi.fn();
vi.mock('../../src/claude/session-manager.js', () => ({ sessionManager: { clearSession } }));
const forgetThreadTitle = vi.fn();
vi.mock('../../src/telegram/thread-titles.js', () => ({ forgetThreadTitle }));
const forgetPrefs = vi.fn();
vi.mock('../../src/providers/user-preferences.js', () => ({ userPreferences: { forgetThread: forgetPrefs } }));

const { forgetThread, isThreadGoneError, watchForDeletedThreads, resetDeletedThreadsForTest } =
  await import('../../src/bot/deleted-threads.js');
const { handleDeleteThread, handleDeleteThreadCallback } = await import('../../src/bot/handlers/command/thread.js');

const CHAT = 37620077;
const THREAD = 4242;
const KEY = `${CHAT}:${THREAD}`;
const api = {} as never;

function letGo(): boolean {
  return clearConversation.mock.calls.some(([key]) => key === KEY);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDeletedThreadsForTest();
});

describe('isThreadGoneError', () => {
  it('knows the answers Telegram gives for a deleted thread', () => {
    expect(isThreadGoneError('Bad Request: message thread not found')).toBe(true);
    expect(isThreadGoneError('Bad Request: TOPIC_ID_INVALID')).toBe(true);
  });

  it('leaves other failures alone', () => {
    expect(isThreadGoneError('Bad Request: message is not modified')).toBe(false);
    expect(isThreadGoneError('Forbidden: bot was blocked by the user')).toBe(false);
    expect(isThreadGoneError(undefined)).toBe(false);
  });
});

describe('forgetThread', () => {
  it('stops the turn and drops everything the thread had', async () => {
    expect(await forgetThread(api, KEY, 'test')).toBe(true);
    expect(stopTurn).toHaveBeenCalledWith(api, KEY);
    expect(releaseHeldQuery).toHaveBeenCalledWith(KEY);
    expect(clearSession).toHaveBeenCalledWith(KEY);
    expect(forgetThreadTitle).toHaveBeenCalledWith(KEY);
    expect(forgetPrefs).toHaveBeenCalledWith(KEY);
    expect(letGo()).toBe(true);
  });

  it('acts once, however often the news comes', async () => {
    await forgetThread(api, KEY, 'first');
    expect(await forgetThread(api, KEY, 'second')).toBe(false);
    expect(clearConversation).toHaveBeenCalledTimes(1);
  });

  it('never touches a chat itself, only its threads', async () => {
    expect(await forgetThread(api, String(CHAT), 'test')).toBe(false);
    expect(clearConversation).not.toHaveBeenCalled();
  });

  it('still lets go when stopping the turn fails', async () => {
    stopTurn.mockRejectedValueOnce(new Error('boom'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await forgetThread(api, KEY, 'test');
    expect(letGo()).toBe(true);
  });
});

describe('watchForDeletedThreads', () => {
  type Transformer = (prev: (...a: unknown[]) => Promise<unknown>, method: string, payload: unknown) => Promise<unknown>;
  function install(): Transformer {
    let transformer: Transformer | undefined;
    const bot = { api: { config: { use: (t: Transformer) => { transformer = t; } } } } as unknown as Bot;
    watchForDeletedThreads(bot);
    return transformer!;
  }
  const failing = (description: string) => async () => ({ ok: false, error_code: 400, description });

  it('lets go of the thread a send failed on as deleted', async () => {
    const transform = install();
    const res = await transform(failing('Bad Request: message thread not found'), 'sendMessage', { chat_id: CHAT, message_thread_id: THREAD, text: 'hi' });
    expect(res).toMatchObject({ ok: false });
    await vi.waitFor(() => expect(letGo()).toBe(true));
  });

  it('ignores other failures, and failures with no thread to blame', async () => {
    const transform = install();
    await transform(failing('Bad Request: message is not modified'), 'editMessageText', { chat_id: CHAT, message_thread_id: THREAD });
    await transform(failing('Bad Request: message thread not found'), 'editMessageText', { chat_id: CHAT, message_id: 5 });
    await transform(async () => ({ ok: true, result: true }), 'sendMessage', { chat_id: CHAT, message_thread_id: THREAD });
    await new Promise((r) => setTimeout(r, 0));
    expect(clearConversation).not.toHaveBeenCalled();
  });
});

describe('/deletethread', () => {
  function ctxFor(opts: { threadId?: number; text?: string; callback?: string; deleteForumTopic?: () => Promise<unknown> }) {
    const message = {
      message_id: 1,
      chat: { id: CHAT },
      text: opts.text ?? '/deletethread',
      is_topic_message: opts.threadId !== undefined,
      message_thread_id: opts.threadId,
    };
    const deleteForumTopic = vi.fn(opts.deleteForumTopic ?? (async () => true));
    const ctx = {
      chat: { id: CHAT },
      message: opts.callback ? undefined : message,
      callbackQuery: opts.callback ? { data: opts.callback, message } : undefined,
      api: { deleteForumTopic, editMessageText: vi.fn(async () => true) },
      reply: vi.fn(async () => ({})),
      answerCallbackQuery: vi.fn(async () => true),
    };
    return { ctx: ctx as unknown as Context, raw: ctx, deleteForumTopic };
  }

  it('asks first, and says where to send it outside a thread', async () => {
    const outside = ctxFor({});
    await handleDeleteThread(outside.ctx);
    expect(outside.raw.reply).toHaveBeenCalledWith(expect.stringContaining('inside the thread'));
    expect(outside.deleteForumTopic).not.toHaveBeenCalled();

    const inside = ctxFor({ threadId: THREAD });
    await handleDeleteThread(inside.ctx);
    expect(inside.deleteForumTopic).not.toHaveBeenCalled();
    expect(letGo()).toBe(false);
  });

  it('deletes the thread and lets it go on confirm', async () => {
    const { ctx, deleteForumTopic } = ctxFor({ threadId: THREAD, callback: 'delthread:confirm' });
    await handleDeleteThreadCallback(ctx);
    expect(deleteForumTopic).toHaveBeenCalledWith(CHAT, THREAD);
    expect(letGo()).toBe(true);
  });

  it('skips the question with -y', async () => {
    const { ctx, deleteForumTopic } = ctxFor({ threadId: THREAD, text: '/deletethread -y' });
    await handleDeleteThread(ctx);
    expect(deleteForumTopic).toHaveBeenCalledWith(CHAT, THREAD);
    expect(letGo()).toBe(true);
  });

  it('keeps the session when Telegram refuses to delete the thread', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const refused = new GrammyError('refused', { ok: false, error_code: 400, description: 'Bad Request: not enough rights' }, 'deleteForumTopic', {});
    const { ctx, raw } = ctxFor({ threadId: THREAD, callback: 'delthread:confirm', deleteForumTopic: async () => { throw refused; } });
    await handleDeleteThreadCallback(ctx);
    expect(letGo()).toBe(false);
    expect(raw.answerCallbackQuery).toHaveBeenCalledWith({ text: "Couldn't delete the thread." });
  });

  it('lets go of a thread that was already deleted by hand', async () => {
    const gone = new GrammyError('gone', { ok: false, error_code: 400, description: 'Bad Request: TOPIC_ID_INVALID' }, 'deleteForumTopic', {});
    const { ctx } = ctxFor({ threadId: THREAD, callback: 'delthread:confirm', deleteForumTopic: async () => { throw gone; } });
    await handleDeleteThreadCallback(ctx);
    expect(letGo()).toBe(true);
  });

  it('keeps the thread on cancel', async () => {
    const { ctx, deleteForumTopic } = ctxFor({ threadId: THREAD, callback: 'delthread:cancel' });
    await handleDeleteThreadCallback(ctx);
    expect(deleteForumTopic).not.toHaveBeenCalled();
    expect(letGo()).toBe(false);
  });
});
