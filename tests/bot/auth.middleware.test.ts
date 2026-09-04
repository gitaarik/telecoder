import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { Context, NextFunction } from 'grammy';
import * as fs from 'fs';
import * as path from 'path';
import * as realOs from 'os';

// The middleware now records who it has seen, which persists under
// os.homedir()/.claudegram. Point that at a scratch dir so the suite never
// reads or writes the developer's real roster.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: actual, homedir: () => process.env.TELECODER_TEST_HOME ?? actual.homedir() };
});

let testHome: string;

beforeAll(() => {
  testHome = fs.mkdtempSync(path.join(realOs.tmpdir(), 'telecoder-auth-'));
  process.env.TELECODER_TEST_HOME = testHome;
});

afterAll(() => {
  delete process.env.TELECODER_TEST_HOME;
  fs.rmSync(testHome, { recursive: true, force: true });
});

const { authMiddleware } = await import('../../src/bot/middleware/auth.middleware.js');
const { admitUser, resetRosterCache, listPending } = await import('../../src/utils/user-roster.js');
const { resetAccessCooldowns } = await import('../../src/telegram/access-request.js');

// Test env (vitest.config.ts): ALLOWED_USER_IDS=1,2,3  ALLOWED_GROUP_IDS=-1009990001
const ALLOWED_GROUP = -1009990001;
const GROUP_ANONYMOUS_BOT_ID = 1087968824;

interface FakeCtxOptions {
  userId?: number;
  username?: string;
  firstName?: string;
  chatId?: number;
  chatType?: string;
  newMembers?: { id: number; is_bot?: boolean; first_name?: string; username?: string }[];
}

function makeCtx(opts: FakeCtxOptions) {
  const reply = vi.fn().mockResolvedValue(undefined);
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const getChatMember = vi
    .fn()
    .mockResolvedValue({ user: { id: 1, first_name: 'Admin', is_bot: false } });
  const ctx = {
    from:
      opts.userId === undefined
        ? undefined
        : { id: opts.userId, username: opts.username, first_name: opts.firstName },
    chat:
      opts.chatId === undefined && opts.chatType === undefined
        ? undefined
        : { id: opts.chatId ?? 1, type: opts.chatType ?? 'private' },
    message: opts.newMembers ? { new_chat_members: opts.newMembers } : undefined,
    api: { sendMessage, getChatMember },
    reply,
  } as unknown as Context;
  return { ctx, reply, sendMessage };
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

  it('allows any user in an allow-listed group (membership is the gate)', async () => {
    const { ctx, reply } = makeCtx({
      userId: 999, // not in ALLOWED_USER_IDS
      chatId: ALLOWED_GROUP,
      chatType: 'supergroup',
    });
    await authMiddleware(ctx, next);
    expect(next).toHaveBeenCalledOnce();
    expect(reply).not.toHaveBeenCalled();
  });

  it('allows anonymous admin posts in an allow-listed group', async () => {
    const { ctx, reply } = makeCtx({
      userId: GROUP_ANONYMOUS_BOT_ID,
      chatId: ALLOWED_GROUP,
      chatType: 'supergroup',
    });
    await authMiddleware(ctx, next);
    expect(next).toHaveBeenCalledOnce();
    expect(reply).not.toHaveBeenCalled();
  });

  it('rejects an unknown user in a non-allow-listed group', async () => {
    const { ctx, reply } = makeCtx({
      userId: 999,
      chatId: -42, // not in ALLOWED_GROUP_IDS
      chatType: 'supergroup',
    });
    await authMiddleware(ctx, next);
    expect(next).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledOnce();
  });

  it('rejects an unknown user in DM even if the same user could speak in an allow-listed group', async () => {
    // Prevents the "kicked from group but keeps DM access" escape hatch.
    const { ctx, reply } = makeCtx({ userId: 999, chatType: 'private' });
    await authMiddleware(ctx, next);
    expect(next).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledOnce();
  });
});

describe('authMiddleware with RESTRICT_TO_GROUPS', () => {
  // Both vars are read off the parsed `config`, so the module graph has to be
  // rebuilt with them stubbed rather than mutated in place.
  async function load(adminIds: string) {
    vi.resetModules();
    vi.stubEnv('RESTRICT_TO_GROUPS', 'true');
    vi.stubEnv('ADMIN_USER_IDS', adminIds);
    return import('../../src/bot/middleware/auth.middleware.js');
  }

  let next: NextFunction & ReturnType<typeof vi.fn>;

  beforeEach(() => {
    next = vi.fn().mockResolvedValue(undefined) as unknown as NextFunction & ReturnType<typeof vi.fn>;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('turns a guest away from a private chat', async () => {
    const { authMiddleware: guarded } = await load('1');
    const { ctx, reply } = makeCtx({ userId: 2, chatId: 2, chatType: 'private' });
    await guarded(ctx, next);
    expect(next).not.toHaveBeenCalled();
    expect(reply.mock.calls[0][0]).toMatch(/shared group chat/i);
  });

  it('lets a guest through inside the allow-listed group', async () => {
    const { authMiddleware: guarded } = await load('1');
    const { ctx, reply } = makeCtx({ userId: 2, chatId: ALLOWED_GROUP, chatType: 'supergroup' });
    await guarded(ctx, next);
    expect(next).toHaveBeenCalledOnce();
    expect(reply).not.toHaveBeenCalled();
  });

  it('turns a guest away from a group that is not allow-listed', async () => {
    const { authMiddleware: guarded } = await load('1');
    const { ctx } = makeCtx({ userId: 2, chatId: -42, chatType: 'supergroup' });
    await guarded(ctx, next);
    expect(next).not.toHaveBeenCalled();
  });

  it('still lets an admin use a private chat', async () => {
    const { authMiddleware: guarded } = await load('1');
    const { ctx, reply } = makeCtx({ userId: 1, chatId: 1, chatType: 'private' });
    await guarded(ctx, next);
    expect(next).toHaveBeenCalledOnce();
    expect(reply).not.toHaveBeenCalled();
  });

  it('restricts nobody when every allowed user is an admin', async () => {
    const { authMiddleware: guarded } = await load('');
    const { ctx } = makeCtx({ userId: 3, chatId: 3, chatType: 'private' });
    await guarded(ctx, next);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('authMiddleware and the runtime roster', () => {
  let next: NextFunction & ReturnType<typeof vi.fn>;

  beforeEach(() => {
    next = vi.fn().mockResolvedValue(undefined) as unknown as NextFunction & ReturnType<typeof vi.fn>;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    fs.rmSync(path.join(testHome, '.claudegram', 'user-roster.json'), { force: true });
    resetRosterCache();
    resetAccessCooldowns();
  });

  it('lets in someone admitted at runtime, with no restart', async () => {
    const denied = makeCtx({ userId: 999, chatType: 'private' });
    await authMiddleware(denied.ctx, next);
    expect(next).not.toHaveBeenCalled();

    admitUser({ id: 999 }, 1);

    const allowed = makeCtx({ userId: 999, chatType: 'private' });
    await authMiddleware(allowed.ctx, next);
    expect(next).toHaveBeenCalledOnce();
    expect(allowed.reply).not.toHaveBeenCalled();
  });

  it('passes a stranger in the shared group down to the role gate', async () => {
    // The door is Telegram membership of an allow-listed group; what that is
    // worth is group-role.middleware's question. Refusing here instead would
    // answer every human-to-human message in the room with a denial.
    const { ctx, reply, sendMessage } = makeCtx({
      userId: 999,
      username: 'newcomer',
      firstName: 'New',
      chatId: ALLOWED_GROUP,
      chatType: 'supergroup',
    });
    await authMiddleware(ctx, next);

    expect(next).toHaveBeenCalledOnce();
    expect(reply).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('records the stranger so /allow @them can resolve later', async () => {
    const { ctx } = makeCtx({
      userId: 999,
      username: 'newcomer',
      chatId: ALLOWED_GROUP,
      chatType: 'supergroup',
    });
    await authMiddleware(ctx, next);
    expect(listPending().map((u) => u.id)).toContain(999);
  });

  it('posts no card for a stranger in a private chat — only its subject would see it', async () => {
    const { ctx, reply, sendMessage } = makeCtx({ userId: 999, chatId: 999, chatType: 'private' });
    await authMiddleware(ctx, next);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(reply.mock.calls[0][0]).toMatch(/not authorized/i);
    expect(reply.mock.calls[0][0]).not.toMatch(/admin has been asked/i);
    // …and they are not recorded, so a stranger cannot flush the seen list.
    expect(listPending().map((u) => u.id)).not.toContain(999);
  });


  it('asks about someone the moment they join, before they have spoken', async () => {
    const { ctx, reply, sendMessage } = makeCtx({
      userId: 1, // an admin added them
      chatId: ALLOWED_GROUP,
      chatType: 'supergroup',
      newMembers: [{ id: 999, first_name: 'New', username: 'newcomer' }],
    });
    await authMiddleware(ctx, next);

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(listPending().map((u) => u.id)).toContain(999);
    // A join is not a prompt: it must not fall through to the agent, and must
    // not be answered with a denial either.
    expect(next).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });

  it('ignores bots joining', async () => {
    const { ctx, sendMessage } = makeCtx({
      userId: 1,
      chatId: ALLOWED_GROUP,
      chatType: 'supergroup',
      newMembers: [{ id: 555, is_bot: true, first_name: 'SomeBot' }],
    });
    await authMiddleware(ctx, next);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does not ask about a joiner who is already allowed', async () => {
    const { ctx, sendMessage } = makeCtx({
      userId: 1,
      chatId: ALLOWED_GROUP,
      chatType: 'supergroup',
      newMembers: [{ id: 2, first_name: 'Known' }],
    });
    await authMiddleware(ctx, next);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('ignores joins in a group that is not allow-listed', async () => {
    const { ctx, sendMessage } = makeCtx({
      userId: 1,
      chatId: -42,
      chatType: 'supergroup',
      newMembers: [{ id: 999, first_name: 'New' }],
    });
    await authMiddleware(ctx, next);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('a stranger who keeps talking', () => {
  let next: NextFunction & ReturnType<typeof vi.fn>;

  beforeEach(() => {
    next = vi.fn().mockResolvedValue(undefined) as unknown as NextFunction & ReturnType<typeof vi.fn>;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    fs.rmSync(path.join(testHome, '.claudegram', 'user-roster.json'), { force: true });
    resetRosterCache();
    resetAccessCooldowns();
  });

  it('keeps being told the request is pending, not that it vanished', async () => {
    // Outside an allow-listed group the roster is still the whole answer, so
    // this is where the door's own card and cooldown are exercised.
    const first = makeCtx({ userId: 999, chatId: 999, chatType: 'private' });
    await authMiddleware(first.ctx, next);
    const second = makeCtx({ userId: 999, chatId: 999, chatType: 'private' });
    await authMiddleware(second.ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(first.reply.mock.calls[0][0]).toMatch(/not authorized/i);
    expect(second.reply.mock.calls[0][0]).toMatch(/not authorized/i);
  });
});
