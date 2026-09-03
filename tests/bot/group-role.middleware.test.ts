import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Context, NextFunction } from 'grammy';
import { config } from '../../src/config.js';
import {
  configureGroupAccessStore,
  grantAccess,
  resolveUserRef,
  revokeAccess,
} from '../../src/bot/access/group-access.js';
import {
  groupRoleMiddleware,
  leadingCommand,
  learnHandlesMiddleware,
  resetSpectatorReminders,
} from '../../src/bot/middleware/group-role.middleware.js';

// Test env (vitest.config.ts): ALLOWED_USER_IDS=1,2,3  ALLOWED_GROUP_IDS=-1009990001
const OWNER = 2;
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
  const ctx = {
    from: { id: opts.userId ?? FRIEND, username: opts.username },
    chat: { id: GROUP, type: opts.chatType ?? 'supergroup' },
    me: { id: BOT_ID, username: 'code_share1_bot' },
    message: opts.callbackData ? undefined : { text: opts.text ?? 'hello' },
    callbackQuery: opts.callbackData ? { data: opts.callbackData } : undefined,
    reply,
    answerCallbackQuery,
  } as unknown as Context;
  return { ctx, reply, answerCallbackQuery };
}

let dir: string;
let next: NextFunction & ReturnType<typeof vi.fn>;
let previousDefault: 'contributor' | 'spectator';

describe('groupRoleMiddleware', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-role-'));
    configureGroupAccessStore(dir);
    resetSpectatorReminders();
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

  it('lets a private chat straight through (auth already limits DMs to owners)', async () => {
    const { ctx, reply } = makeCtx({ userId: OWNER, chatType: 'private' });
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

  it('blocks a contributor from an owner-only command', async () => {
    grantAccess(GROUP, FRIEND);
    const { ctx, reply } = makeCtx({ text: '/restartbot' });
    await groupRoleMiddleware(ctx, next);
    expect(next).not.toHaveBeenCalled();
    expect(reply.mock.calls[0][0]).toMatch(/owner-only/i);
  });

  it('blocks an owner-only command addressed with @botname', async () => {
    grantAccess(GROUP, FRIEND);
    const { ctx } = makeCtx({ text: '/project@code_share1_bot /srv/app' });
    await groupRoleMiddleware(ctx, next);
    expect(next).not.toHaveBeenCalled();
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

  it('lets an owner run the owner-only commands', async () => {
    const { ctx, reply } = makeCtx({ userId: OWNER, text: '/restartbot' });
    await groupRoleMiddleware(ctx, next);
    expect(next).toHaveBeenCalledOnce();
    expect(reply).not.toHaveBeenCalled();
  });

  it("does not mistake a pasted path for the command it starts with", async () => {
    grantAccess(GROUP, FRIEND);
    const { ctx } = makeCtx({ text: '/updates/are/a/directory not a command' });
    await groupRoleMiddleware(ctx, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('stops a contributor tapping an owner-only inline button', async () => {
    grantAccess(GROUP, FRIEND);
    const { ctx, answerCallbackQuery, reply } = makeCtx({ callbackData: 'restartbot:confirm' });
    await groupRoleMiddleware(ctx, next);
    expect(next).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled(); // answered on the button, not in the group
    expect(answerCallbackQuery).toHaveBeenCalledOnce();
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

  it('answers a spectator on the button rather than in the group', async () => {
    const { ctx, answerCallbackQuery, reply } = makeCtx({ callbackData: 'model:opus' });
    await groupRoleMiddleware(ctx, next);
    expect(next).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    expect(answerCallbackQuery).toHaveBeenCalledOnce();
  });

});

describe('learnHandlesMiddleware', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-handles-'));
    configureGroupAccessStore(dir);
    next = vi.fn().mockResolvedValue(undefined) as unknown as NextFunction & ReturnType<typeof vi.fn>;
  });

  afterEach(() => {
    configureGroupAccessStore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('learns a handle from a message that never addresses the bot', async () => {
    const { ctx } = makeCtx({ username: 'masterwork964', text: 'morning everyone' });
    await learnHandlesMiddleware(ctx, next);
    expect(next).toHaveBeenCalledOnce();
    expect(resolveUserRef('@masterwork964')).toBe(FRIEND);
  });

  it('passes through someone with no handle set', async () => {
    const { ctx } = makeCtx({});
    await learnHandlesMiddleware(ctx, next);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('leadingCommand', () => {
  it('reads the command a message opens with', () => {
    expect(leadingCommand('/status')).toBe('status');
    expect(leadingCommand('  /Status extra')).toBe('status');
    expect(leadingCommand('/status@some_bot now')).toBe('status');
  });

  it('ignores text that merely starts with a slash', () => {
    expect(leadingCommand('/home/me/notes')).toBeUndefined();
    expect(leadingCommand('not a command')).toBeUndefined();
    expect(leadingCommand(undefined)).toBeUndefined();
  });
});
