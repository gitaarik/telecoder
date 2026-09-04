import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Context, NextFunction } from 'grammy';
import { config } from '../../src/config.js';
import {
  configureGroupAccessStore,
  grantAccess,
  revokeAccess,
} from '../../src/bot/access/group-access.js';
import {
  groupRoleMiddleware,
  resetSpectatorReminders,
} from '../../src/bot/middleware/group-role.middleware.js';
import { resetAccessCooldowns } from '../../src/telegram/access-request.js';

// Test env (vitest.config.ts): ALLOWED_USER_IDS=1,2,3  ALLOWED_GROUP_IDS=-1009990001
const ADMIN = 2;
const GROUP = -1009990001;
const FRIEND = 999;
const BOT_ID = 8833142947;

interface FakeCtxOptions {
  userId?: number;
  username?: string;
  chatType?: string;
  text?: string;
  callbackData?: string;
}

function makeCtx(opts: FakeCtxOptions) {
  const reply = vi.fn().mockResolvedValue(undefined);
  const answerCallbackQuery = vi.fn().mockResolvedValue(undefined);
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const getChatMember = vi.fn().mockResolvedValue({ user: { id: ADMIN, first_name: 'Admin' } });
  const ctx = {
    api: { sendMessage, getChatMember },
    from: { id: opts.userId ?? FRIEND, username: opts.username },
    chat: { id: GROUP, type: opts.chatType ?? 'supergroup' },
    me: { id: BOT_ID, username: 'code_share1_bot' },
    message: opts.callbackData ? undefined : { text: opts.text ?? 'hello' },
    callbackQuery: opts.callbackData ? { data: opts.callbackData } : undefined,
    reply,
    answerCallbackQuery,
  } as unknown as Context;
  return { ctx, reply, answerCallbackQuery, sendMessage };
}

let dir: string;
let next: NextFunction & ReturnType<typeof vi.fn>;
let previousDefault: 'contributor' | 'spectator';

describe('groupRoleMiddleware', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-role-'));
    configureGroupAccessStore(dir);
    resetSpectatorReminders();
    resetAccessCooldowns();
    previousDefault = config.GROUP_MEMBERS_DEFAULT;
    config.GROUP_MEMBERS_DEFAULT = 'spectator';
    next = vi.fn().mockResolvedValue(undefined) as unknown as NextFunction & ReturnType<typeof vi.fn>;
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    config.GROUP_MEMBERS_DEFAULT = previousDefault;
    configureGroupAccessStore();
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('lets a private chat straight through (auth already limits DMs to the roster)', async () => {
    const { ctx, reply } = makeCtx({ userId: ADMIN, chatType: 'private' });
    await groupRoleMiddleware(ctx, next);
    expect(next).toHaveBeenCalledOnce();
    expect(reply).not.toHaveBeenCalled();
  });

  it('turns away a spectator and tells them how to get access', async () => {
    const { ctx, reply } = makeCtx({ text: '@code_share1_bot fix the build' });
    await groupRoleMiddleware(ctx, next);
    expect(next).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledOnce();
    expect(reply.mock.calls[0][0]).toMatch(/\/allow/);
  });

  it('only reminds a spectator once per interval, so they cannot flood the group', async () => {
    const first = makeCtx({});
    await groupRoleMiddleware(first.ctx, next);
    expect(first.reply).toHaveBeenCalledOnce();

    for (let i = 0; i < 3; i++) {
      const again = makeCtx({});
      await groupRoleMiddleware(again.ctx, next);
      expect(again.reply).not.toHaveBeenCalled();
    }
    expect(next).not.toHaveBeenCalled();
  });

  it('lets a granted contributor through', async () => {
    grantAccess(GROUP, FRIEND);
    const { ctx, reply } = makeCtx({ text: 'fix the build' });
    await groupRoleMiddleware(ctx, next);
    expect(next).toHaveBeenCalledOnce();
    expect(reply).not.toHaveBeenCalled();
  });

  it('turns away a denied member even under a contributor default', async () => {
    config.GROUP_MEMBERS_DEFAULT = 'contributor';
    revokeAccess(GROUP, FRIEND);
    const { ctx, reply } = makeCtx({});
    await groupRoleMiddleware(ctx, next);
    expect(next).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledOnce();
  });

  it('lets a contributor use the everyday commands', async () => {
    grantAccess(GROUP, FRIEND);
    for (const text of ['/status', '/cancel', '/model', '/members']) {
      next.mockClear();
      const { ctx } = makeCtx({ text });
      await groupRoleMiddleware(ctx, next);
      expect(next, text).toHaveBeenCalledOnce();
    }
  });

  it('lets an admin through whatever the default is', async () => {
    const { ctx, reply } = makeCtx({ userId: ADMIN, text: '/restartbot' });
    await groupRoleMiddleware(ctx, next);
    expect(next).toHaveBeenCalledOnce();
    expect(reply).not.toHaveBeenCalled();
  });

  it('leaves a membership update alone rather than chatting back at it', async () => {
    // my_chat_member and friends carry a `from` but no message and no button,
    // and reach no handler — the gate must not answer them.
    const reply = vi.fn().mockResolvedValue(undefined);
    const ctx = {
      from: { id: FRIEND },
      chat: { id: GROUP, type: 'supergroup' },
      me: { id: BOT_ID, username: 'code_share1_bot' },
      reply,
    } as unknown as Context;

    await groupRoleMiddleware(ctx, next);
    expect(next).toHaveBeenCalledOnce();
    expect(reply).not.toHaveBeenCalled();
  });

  it('puts the decision in front of an admin, not only a no to the spectator', async () => {
    // The two "turned away" paths were separate before the access layers were
    // reconciled: the door posted a tap-to-approve card, the role gate only
    // told the person no. A refusal an admin can act on with one tap is the
    // useful half, so the gate that now does the refusing posts the card.
    const { ctx, reply, sendMessage } = makeCtx({ text: '@code_share1_bot do a thing' });
    await groupRoleMiddleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledOnce();
    const [chatId, text, opts] = sendMessage.mock.calls[0];
    expect(chatId).toBe(GROUP);
    expect(text).toContain('Access requested');
    expect(opts.reply_markup.inline_keyboard[0]).toHaveLength(2);
    expect(reply.mock.calls[0][0]).toMatch(/read along/i);
  });

  it('does not let a spectator page the admins by typing repeatedly', async () => {
    const first = makeCtx({ text: 'hello bot' });
    await groupRoleMiddleware(first.ctx, next);
    const second = makeCtx({ text: 'hello again' });
    await groupRoleMiddleware(second.ctx, next);

    expect(first.sendMessage).toHaveBeenCalledOnce();
    expect(second.sendMessage).not.toHaveBeenCalled();
  });

  it('answers a spectator on the button rather than in the group', async () => {
    const { ctx, answerCallbackQuery, reply } = makeCtx({ callbackData: 'model:opus' });
    await groupRoleMiddleware(ctx, next);
    expect(next).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    expect(answerCallbackQuery).toHaveBeenCalledOnce();
  });

});
