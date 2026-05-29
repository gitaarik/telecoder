import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context, NextFunction } from 'grammy';
import { authMiddleware } from '../../src/bot/middleware/auth.middleware.js';

// Test env (vitest.config.ts): ALLOWED_USER_IDS=1,2,3  ALLOWED_GROUP_IDS=-1009990001
const ALLOWED_GROUP = -1009990001;
const GROUP_ANONYMOUS_BOT_ID = 1087968824;

interface FakeCtxOptions {
  userId?: number;
  username?: string;
  chatId?: number;
  chatType?: string;
}

function makeCtx(opts: FakeCtxOptions) {
  const reply = vi.fn().mockResolvedValue(undefined);
  const ctx = {
    from: opts.userId === undefined ? undefined : { id: opts.userId, username: opts.username },
    chat:
      opts.chatId === undefined && opts.chatType === undefined
        ? undefined
        : { id: opts.chatId ?? 1, type: opts.chatType ?? 'private' },
    reply,
  } as unknown as Context;
  return { ctx, reply };
}

describe('authMiddleware', () => {
  let next: NextFunction & ReturnType<typeof vi.fn>;

  beforeEach(() => {
    next = vi.fn().mockResolvedValue(undefined) as unknown as NextFunction & ReturnType<typeof vi.fn>;
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('calls next for an allow-listed user', async () => {
    const { ctx, reply } = makeCtx({ userId: 2, chatType: 'private' });
    await authMiddleware(ctx, next);
    expect(next).toHaveBeenCalledOnce();
    expect(reply).not.toHaveBeenCalled();
  });

  it('rejects an unknown user with a notice and no next', async () => {
    const { ctx, reply } = makeCtx({ userId: 999, chatType: 'private' });
    await authMiddleware(ctx, next);
    expect(next).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledOnce();
    expect(reply.mock.calls[0][0]).toMatch(/not authorized/i);
  });

  it('silently drops updates with no user id (no reply, no next)', async () => {
    const { ctx, reply } = makeCtx({ chatType: 'private' });
    await authMiddleware(ctx, next);
    expect(next).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });

  it('allows the anonymous-admin bot only in an allow-listed group', async () => {
    const { ctx, reply } = makeCtx({
      userId: GROUP_ANONYMOUS_BOT_ID,
      chatId: ALLOWED_GROUP,
      chatType: 'supergroup',
    });
    await authMiddleware(ctx, next);
    expect(next).toHaveBeenCalledOnce();
    expect(reply).not.toHaveBeenCalled();
  });

  it('rejects the anonymous-admin bot in a non-allow-listed group', async () => {
    const { ctx, reply } = makeCtx({
      userId: GROUP_ANONYMOUS_BOT_ID,
      chatId: -42, // not in ALLOWED_GROUP_IDS
      chatType: 'supergroup',
    });
    await authMiddleware(ctx, next);
    expect(next).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledOnce();
  });
});
