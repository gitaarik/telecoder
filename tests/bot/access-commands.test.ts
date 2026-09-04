import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Context } from 'grammy';
import * as fs from 'fs';
import * as path from 'path';
import * as realOs from 'os';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: actual, homedir: () => process.env.TELECODER_TEST_HOME ?? actual.homedir() };
});

let testHome: string;

beforeAll(() => {
  testHome = fs.mkdtempSync(path.join(realOs.tmpdir(), 'telecoder-access-'));
  process.env.TELECODER_TEST_HOME = testHome;
});

afterAll(() => {
  delete process.env.TELECODER_TEST_HOME;
  fs.rmSync(testHome, { recursive: true, force: true });
});

// Test env (vitest.config.ts): ALLOWED_USER_IDS=1,2,3 — with ADMIN_USER_IDS
// unset, all three are admins.
const { handleAllow, handleDeny, handleUsers, handleAccessCallback } = await import(
  '../../src/bot/handlers/command/access.js'
);
const { isAllowedUser, admitUser, noteSeenUser, resetRosterCache } = await import(
  '../../src/utils/user-roster.js'
);
const { buildAccessRequestMessage, accessKeyboard } = await import(
  '../../src/telegram/access-request.js'
);
const { resolveRole, configureGroupAccessStore } = await import(
  '../../src/bot/access/group-access.js'
);

const ADMIN = 1;

const GROUP = -1009990001;

/**
 * `chat` decides which half of `/allow` is under test: in a DM it admits to the
 * global roster, in the allow-listed group it grants contributor there. The
 * default is a DM, because that is the layer these first blocks are about.
 */
function makeCtx(opts: {
  text?: string;
  replyTo?: { id: number; first_name?: string; username?: string; is_bot?: boolean };
  from?: number;
  chat?: 'private' | 'group';
}) {
  const reply = vi.fn().mockResolvedValue(undefined);
  const answerCallbackQuery = vi.fn().mockResolvedValue(undefined);
  const editMessageText = vi.fn().mockResolvedValue(undefined);
  const ctx = {
    from: { id: opts.from ?? ADMIN },
    chat:
      opts.chat === 'group'
        ? { id: GROUP, type: 'supergroup' }
        : { id: opts.from ?? ADMIN, type: 'private' },
    message: {
      text: opts.text,
      ...(opts.replyTo ? { reply_to_message: { from: opts.replyTo } } : {}),
    },
    reply,
    answerCallbackQuery,
    editMessageText,
  } as unknown as Context;
  return { ctx, reply, answerCallbackQuery, editMessageText };
}

function makeCallbackCtx(data: string, from = ADMIN) {
  const answerCallbackQuery = vi.fn().mockResolvedValue(undefined);
  const editMessageText = vi.fn().mockResolvedValue(undefined);
  const ctx = {
    from: { id: from },
    callbackQuery: { data },
    answerCallbackQuery,
    editMessageText,
  } as unknown as Context;
  return { ctx, answerCallbackQuery, editMessageText };
}

/** The single string a handler replied with. */
const said = (reply: ReturnType<typeof vi.fn>): string => reply.mock.calls[0][0] as string;

beforeEach(() => {
  fs.rmSync(path.join(testHome, '.claudegram', 'user-roster.json'), { force: true });
  fs.rmSync(path.join(testHome, '.claudegram'), { recursive: true, force: true });
  resetRosterCache();
  configureGroupAccessStore(fs.mkdtempSync(path.join(realOs.tmpdir(), 'telecoder-ga-')));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('/allow', () => {
  it('admits the author of the replied-to message', async () => {
    const { ctx, reply } = makeCtx({
      text: '/allow',
      replyTo: { id: 999, first_name: 'New', username: 'newcomer' },
    });
    await handleAllow(ctx);
    expect(isAllowedUser(999)).toBe(true);
    expect(said(reply)).toMatch(/New/);
    // It says what kind of access they got — guests are supervised.
    expect(said(reply)).toMatch(/guest/i);
  });

  it('admits by @username for someone already seen', async () => {
    noteSeenUser({ id: 999, username: 'newcomer', name: 'New Comer' }, -1009990001);
    const { ctx } = makeCtx({ text: '/allow @newcomer' });
    await handleAllow(ctx);
    expect(isAllowedUser(999)).toBe(true);
  });

  it('admits by raw numeric id', async () => {
    const { ctx } = makeCtx({ text: '/allow 4242' });
    await handleAllow(ctx);
    expect(isAllowedUser(4242)).toBe(true);
  });

  it('explains why an unseen @username cannot be looked up', async () => {
    const { ctx, reply } = makeCtx({ text: '/allow @stranger' });
    await handleAllow(ctx);
    expect(isAllowedUser(999)).toBe(false);
    expect(said(reply)).toMatch(/no way to look up a username/i);
    expect(said(reply)).toMatch(/reply/i);
  });

  it('prefers the reply over a typed name when given both', async () => {
    noteSeenUser({ id: 111, username: 'typed' }, -1009990001);
    const { ctx } = makeCtx({
      text: '/allow @typed',
      replyTo: { id: 999, first_name: 'Replied' },
    });
    await handleAllow(ctx);
    expect(isAllowedUser(999)).toBe(true);
    expect(isAllowedUser(111)).toBe(false);
  });

  it('shows usage when aimed at nobody', async () => {
    const { ctx, reply } = makeCtx({ text: '/allow' });
    await handleAllow(ctx);
    expect(said(reply)).toMatch(/Usage/);
  });

  it('says so when they could already use the bot', async () => {
    const { ctx, reply } = makeCtx({ text: '/allow 2' });
    await handleAllow(ctx);
    expect(said(reply)).toMatch(/already/i);
  });

  it('ignores a reply to a bot message', async () => {
    const { ctx, reply } = makeCtx({
      text: '/allow',
      replyTo: { id: 555, first_name: 'SomeBot', is_bot: true },
    });
    await handleAllow(ctx);
    expect(isAllowedUser(555)).toBe(false);
    expect(said(reply)).toMatch(/Usage/);
  });
});

describe('/deny', () => {
  it('revokes someone admitted at runtime', async () => {
    admitUser({ id: 999, name: 'New' }, ADMIN);
    const { ctx, reply } = makeCtx({ text: '/deny 999' });
    await handleDeny(ctx);
    expect(isAllowedUser(999)).toBe(false);
    expect(said(reply)).toMatch(/is out/i);
  });

  it('refuses an admin and says where their id lives', async () => {
    const { ctx, reply } = makeCtx({ text: '/deny 2' });
    await handleDeny(ctx);
    expect(isAllowedUser(2)).toBe(true);
    expect(said(reply)).toMatch(/admin/i);
    expect(said(reply)).toMatch(/ADMIN_USER_IDS/);
  });

  it('reports an env-configured guest rather than pretending to remove them', async () => {
    vi.resetModules();
    vi.stubEnv('ADMIN_USER_IDS', '1');
    const access = await import('../../src/bot/handlers/command/access.js');
    const roster = await import('../../src/utils/user-roster.js');
    roster.resetRosterCache();

    const { ctx, reply } = makeCtx({ text: '/deny 2' });
    await access.handleDeny(ctx);
    expect(roster.isAllowedUser(2)).toBe(true);
    expect(said(reply)).toMatch(/ALLOWED_USER_IDS/);

    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('is a no-op for someone who never had access', async () => {
    const { ctx, reply } = makeCtx({ text: '/deny 999' });
    await handleDeny(ctx);
    expect(said(reply)).toMatch(/already had no access/i);
  });
});

describe('/users', () => {
  it('reports admins, runtime guests and people seen but not allowed', async () => {
    admitUser({ id: 999, name: 'New Comer', username: 'newcomer' }, ADMIN);
    noteSeenUser({ id: 777, username: 'lurker' }, -1009990001);

    const { ctx, reply } = makeCtx({ text: '/users' });
    await handleUsers(ctx);
    const text = said(reply);

    expect(text).toMatch(/Admins/);
    expect(text).toMatch(/— you/);
    expect(text).toContain('999');
    expect(text).toMatch(/Seen but not allowed/);
    expect(text).toContain('777');
  });

  it('says so plainly when nobody has been admitted yet', async () => {
    const { ctx, reply } = makeCtx({ text: '/users' });
    await handleUsers(ctx);
    expect(said(reply)).toMatch(/none yet/);
  });
});

describe('the access card', () => {
  it('names the user, links their profile and carries the id', () => {
    const { text, entities } = buildAccessRequestMessage({
      user: { id: 999, name: 'New Comer', username: 'newcomer' },
      admins: [{ id: 1, name: 'Admin' }],
    });

    expect(text).toContain('New Comer');
    expect(text).toContain('@newcomer');
    expect(text).toContain('999');
    // A text_mention for the subject makes the card a link to their profile.
    expect(entities.some((e) => e.type === 'text_mention' && e.user?.id === 999)).toBe(true);
    // …and one for the admin, so the card notifies them in a muted group.
    expect(entities.some((e) => e.type === 'text_mention' && e.user?.id === 1)).toBe(true);
  });

  it('still reads correctly for someone with no name or handle', () => {
    const { text } = buildAccessRequestMessage({ user: { id: 999 }, admins: [] });
    expect(text).toContain('Someone wants to use this bot.');
    expect(text).toMatch(/Only an admin can approve/);
  });

  it('keeps callback data inside Telegram’s 64-byte limit', () => {
    // A plausible worst case: Telegram ids are 64-bit.
    const [row] = accessKeyboard(9223372036854775807);
    for (const button of row) {
      expect(Buffer.byteLength(button.callback_data, 'utf-8')).toBeLessThanOrEqual(64);
    }
  });
});

describe('the card buttons', () => {
  it('admits on Allow and replaces the card with the outcome', async () => {
    noteSeenUser({ id: 999, name: 'New Comer' }, -1009990001);
    const { ctx, answerCallbackQuery, editMessageText } = makeCallbackCtx('access:999:y');
    await handleAccessCallback(ctx);

    expect(isAllowedUser(999)).toBe(true);
    expect(answerCallbackQuery).toHaveBeenCalledOnce();
    expect(editMessageText.mock.calls[0][0]).toMatch(/New Comer.*allowed in/);
    // The buttons go: a second admin must not be able to re-decide it.
    expect(editMessageText.mock.calls[0][1].reply_markup.inline_keyboard).toEqual([]);
  });

  it('admits nobody on Ignore', async () => {
    const { ctx, editMessageText } = makeCallbackCtx('access:999:n');
    await handleAccessCallback(ctx);
    expect(isAllowedUser(999)).toBe(false);
    expect(editMessageText.mock.calls[0][0]).toMatch(/not let in/);
  });

  it('ignores malformed callback data instead of throwing', async () => {
    const { ctx, answerCallbackQuery } = makeCallbackCtx('access:notanumber:y');
    await expect(handleAccessCallback(ctx)).resolves.toBeUndefined();
    expect(answerCallbackQuery).toHaveBeenCalledOnce();
  });

  it('ignores callback data for another feature', async () => {
    const { ctx, answerCallbackQuery } = makeCallbackCtx('rebuild:1');
    await handleAccessCallback(ctx);
    expect(answerCallbackQuery).not.toHaveBeenCalled();
  });
});

describe('/allow and /deny inside the shared group', () => {
  // The reconciled model: the same command means the nearer layer. Typed in a
  // group it grants a role *there*; the global roster is left alone, so waving
  // someone into one room never quietly hands them a private channel with the
  // bot as well.
  it('makes someone a contributor here without admitting them everywhere', async () => {
    const { ctx, reply } = makeCtx({
      chat: 'group',
      text: '/allow',
      replyTo: { id: 999, first_name: 'New', username: 'newcomer' },
    });
    await handleAllow(ctx);

    expect(resolveRole(GROUP, 999)).toBe('contributor');
    expect(isAllowedUser(999)).toBe(false);
    expect(said(reply)).toMatch(/this chat/i);
  });

  it('warns that a contributor is being handed the machine', async () => {
    const { ctx, reply } = makeCtx({
      chat: 'group',
      text: '/allow',
      replyTo: { id: 999, first_name: 'New' },
    });
    await handleAllow(ctx);
    expect(said(reply)).toMatch(/running commands on this machine/i);
  });

  it('makes someone a spectator here without touching the global roster', async () => {
    admitUser({ id: 999, username: 'guest' }, ADMIN);
    expect(resolveRole(GROUP, 999)).toBe('contributor');

    const { ctx, reply } = makeCtx({
      chat: 'group',
      text: '/deny',
      replyTo: { id: 999, first_name: 'Guest', username: 'guest' },
    });
    await handleDeny(ctx);

    expect(resolveRole(GROUP, 999)).toBe('spectator');
    // Still on the roster — /deny in the group is about this room only, and
    // the reply has to say so or it reads as a full revocation.
    expect(isAllowedUser(999)).toBe(true);
    expect(said(reply)).toMatch(/spectator/i);
    expect(said(reply)).toMatch(/DM/i);
  });

  it('refuses to demote an admin', async () => {
    const { ctx, reply } = makeCtx({
      chat: 'group',
      text: '/deny',
      replyTo: { id: 2, first_name: 'Admin' },
    });
    await handleDeny(ctx);
    expect(resolveRole(GROUP, 2)).toBe('admin');
    expect(said(reply)).toMatch(/admin/i);
  });

  it('grants in the group when the access card is tapped', async () => {
    const groupCallback = {
      from: { id: ADMIN },
      chat: { id: GROUP, type: 'supergroup' },
      callbackQuery: { data: 'access:999:y' },
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      editMessageText: vi.fn().mockResolvedValue(undefined),
    } as unknown as Context;

    await handleAccessCallback(groupCallback);

    expect(resolveRole(GROUP, 999)).toBe('contributor');
    expect(isAllowedUser(999)).toBe(false);
  });
});
