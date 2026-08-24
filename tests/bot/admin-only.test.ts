import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Context } from 'grammy';

// Test env (vitest.config.ts): ALLOWED_USER_IDS=1,2,3. User 1 is the admin in
// every case below; 2 and 3 are guests.
async function loadAdminOnly(adminIds: string) {
  vi.resetModules();
  vi.stubEnv('ADMIN_USER_IDS', adminIds);
  return import('../../src/bot/middleware/admin-only.js');
}

function makeCommandCtx(userId: number | undefined) {
  const reply = vi.fn().mockResolvedValue(undefined);
  const ctx = {
    from: userId === undefined ? undefined : { id: userId },
    chat: { id: -100, type: 'supergroup' },
    reply,
  } as unknown as Context;
  return { ctx, reply };
}

function makeCallbackCtx(userId: number) {
  const answerCallbackQuery = vi.fn().mockResolvedValue(undefined);
  const ctx = {
    from: { id: userId },
    chat: { id: -100, type: 'supergroup' },
    callbackQuery: { data: 'restartbot:go' },
    answerCallbackQuery,
  } as unknown as Context;
  return { ctx, answerCallbackQuery };
}

describe('adminOnly', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('runs the handler for an admin', async () => {
    const { adminOnly } = await loadAdminOnly('1');
    const handler = vi.fn().mockResolvedValue(undefined);
    const { ctx, reply } = makeCommandCtx(1);

    await adminOnly(handler)(ctx);

    expect(handler).toHaveBeenCalledOnce();
    expect(reply).not.toHaveBeenCalled();
  });

  it('blocks a guest and explains why, without running the handler', async () => {
    const { adminOnly } = await loadAdminOnly('1');
    const handler = vi.fn().mockResolvedValue(undefined);
    const { ctx, reply } = makeCommandCtx(2);

    await adminOnly(handler)(ctx);

    expect(handler).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledOnce();
    expect(reply.mock.calls[0][0]).toMatch(/admins only/i);
  });

  it('answers a blocked callback with an alert rather than a chat message', async () => {
    const { adminOnly } = await loadAdminOnly('1');
    const handler = vi.fn().mockResolvedValue(undefined);
    const { ctx, answerCallbackQuery } = makeCallbackCtx(2);

    await adminOnly(handler)(ctx);

    expect(handler).not.toHaveBeenCalled();
    expect(answerCallbackQuery).toHaveBeenCalledOnce();
    expect(answerCallbackQuery.mock.calls[0][0]).toMatchObject({ show_alert: true });
  });

  it('is transparent when no admin subset is configured', async () => {
    // The single-user install: everyone allowed is an admin, so wrapping a
    // handler must not change who can reach it.
    const { adminOnly } = await loadAdminOnly('');
    const handler = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCommandCtx(3);

    await adminOnly(handler)(ctx);

    expect(handler).toHaveBeenCalledOnce();
  });

  it('blocks an update with no user id', async () => {
    const { adminOnly } = await loadAdminOnly('1');
    const handler = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCommandCtx(undefined);

    await adminOnly(handler)(ctx);

    expect(handler).not.toHaveBeenCalled();
  });
});
