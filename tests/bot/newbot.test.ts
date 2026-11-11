import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ADMIN = 100;
const STRANGER = 200;
let workspace: string;

const addInstance = vi.fn((entry: { name: string }) => entry.name);
vi.mock('../../src/utils/instances.js', () => ({ addInstance }));
vi.mock('../../src/utils/admins.js', () => ({ isAdmin: (id: number) => id === ADMIN }));
vi.mock('../../src/utils/workspace-guard.js', () => ({ getWorkspaceRoot: () => workspace }));
vi.mock('../../src/claude/session-manager.js', () => ({
  sessionManager: { getSession: () => ({ workingDirectory: path.join(workspace, 'telecoder') }) },
}));

const primedTokens: string[] = [];
const primeGetUpdates = vi.fn(async () => []);
vi.mock('grammy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('grammy')>();
  class Api {
    constructor(token: string) { primedTokens.push(token); }
    getUpdates = primeGetUpdates;
  }
  return { ...actual, Api };
});

const nb = await import('../../src/bot/handlers/newbot.handler.js');

function ctxFor(opts: { text?: string; from?: number; canManage?: boolean; created?: { id: number; first_name: string; username?: string } }) {
  const reply = vi.fn().mockResolvedValue({});
  const api = {
    getMe: vi.fn().mockResolvedValue({ can_manage_bots: opts.canManage ?? true }),
    sendMessage: vi.fn().mockResolvedValue({}),
    getManagedBotToken: vi.fn().mockResolvedValue('555:secret'),
    setManagedBotAccessSettings: vi.fn().mockResolvedValue(true),
  };
  const ctx = {
    chat: { id: opts.from ?? ADMIN, type: 'private' },
    from: { id: opts.from ?? ADMIN },
    message: {
      text: opts.text,
      ...(opts.created ? { managed_bot_created: { bot: { is_bot: true, ...opts.created } } } : {}),
    },
    reply,
    api,
  };
  return { ctx: ctx as never, reply, api };
}

describe('/newbot', () => {
  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-newbot-'));
    fs.mkdirSync(path.join(workspace, 'sjs'));
    fs.mkdirSync(path.join(workspace, 'telecoder'));
    addInstance.mockClear();
    nb.resetNewBotForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('suggests a valid username for any project name', () => {
    expect(nb.suggestedBotUsername('sjs')).toBe('sjs_telecoder_bot');
    expect(nb.suggestedBotUsername('My Site.nl')).toBe('my_site_nl_telecoder_bot');
    const long = nb.suggestedBotUsername('a-very-long-project-name-indeed');
    expect(long.length).toBeLessThanOrEqual(32);
    expect(long).toMatch(/^[a-z0-9_]+_telecoder_bot$/);
    expect(long).not.toMatch(/__/);
  });

  it('offers the create-a-bot button for the project', async () => {
    const { ctx, api } = ctxFor({ text: '/newbot sjs' });
    await nb.handleNewBot(ctx);

    expect(api.sendMessage.mock.calls[0][0]).toBe(ADMIN);
    const button = api.sendMessage.mock.calls[0][2].reply_markup.keyboard[0][0];
    expect(button.request_managed_bot).toMatchObject({ suggested_name: 'TeleCoder — sjs', suggested_username: 'sjs_telecoder_bot' });
  });

  it("uses the chat's project when none is given", async () => {
    const { ctx, api } = ctxFor({ text: '/newbot' });
    await nb.handleNewBot(ctx);

    expect(api.sendMessage.mock.calls[0][2].reply_markup.keyboard[0][0].request_managed_bot.suggested_name).toBe('TeleCoder — telecoder');
  });

  it('says so on a bot without Bot Management Mode, and for a missing folder', async () => {
    const off = ctxFor({ text: '/newbot sjs', canManage: false });
    await nb.handleNewBot(off.ctx);
    expect(off.reply.mock.calls[0][0]).toMatch(/Bot Management Mode/);

    const missing = ctxFor({ text: '/newbot nope' });
    await nb.handleNewBot(missing.ctx);
    expect(missing.reply.mock.calls[0][0]).toMatch(/no project folder/);
  });

  it('adopts the bot it asked for: token, lock, instances.json with its home project', async () => {
    await nb.handleNewBot(ctxFor({ text: '/newbot sjs' }).ctx);
    const { ctx, api, reply } = ctxFor({ created: { id: 555, first_name: 'TeleCoder — sjs', username: 'sjs_telecoder_bot' } });
    await nb.handleManagedBotCreated(ctx);

    expect(api.getManagedBotToken).toHaveBeenCalledWith(555);
    expect(api.setManagedBotAccessSettings).toHaveBeenCalledWith(555, true, { added_user_ids: [ADMIN] });
    // Asks for the new bot's updates once, so Telegram keeps a /start sent before its worker is up.
    expect(primedTokens).toContain('555:secret');
    expect(primeGetUpdates).toHaveBeenCalledWith({ timeout: 0, limit: 1 });
    expect(addInstance).toHaveBeenCalledWith({
      name: 'TeleCoder — sjs',
      token: '555:secret',
      overrides: { HOME_PROJECT: path.join(workspace, 'sjs') },
    });
    const [text, opts] = reply.mock.calls[0];
    expect(text).toContain('✅ @sjs_telecoder_bot is set up for sjs');
    expect(opts.entities).toContainEqual(expect.objectContaining({
      type: 'text_link', offset: 2, length: '@sjs_telecoder_bot'.length, url: 'https://t.me/sjs_telecoder_bot',
    }));
    expect(text).not.toContain('secret');
    expect(opts.reply_markup).toEqual({ remove_keyboard: true });
  });

  it("ignores a bot someone else created through the bot's link", async () => {
    const { ctx, api, reply } = ctxFor({ from: STRANGER, created: { id: 556, first_name: 'Theirs' } });
    await nb.handleManagedBotCreated(ctx);

    expect(api.getManagedBotToken).not.toHaveBeenCalled();
    expect(addInstance).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });

  it('adopts a bot without a home project once the /newbot has expired', async () => {
    vi.useFakeTimers();
    await nb.handleNewBot(ctxFor({ text: '/newbot sjs' }).ctx);
    vi.advanceTimersByTime(2 * 60 * 60_000);
    const { ctx, reply } = ctxFor({ created: { id: 555, first_name: 'Late' } });
    await nb.handleManagedBotCreated(ctx);

    expect(addInstance).toHaveBeenCalledWith(expect.objectContaining({ overrides: {} }));
    expect(reply.mock.calls[0][0]).toMatch(/expired/);
  });

  it('lets the agent offer the button in the thread it was asked in', async () => {
    const { api } = ctxFor({});
    const result = await nb.offerNewBotForSession(api as never, `${ADMIN}:369357`, 'sjs');

    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/until they tap/);
    const [chatId, , opts] = api.sendMessage.mock.calls[0];
    expect(chatId).toBe(ADMIN);
    expect(opts.message_thread_id).toBe(369357);
    expect(opts.reply_markup.keyboard[0][0].request_managed_bot.suggested_name).toBe('TeleCoder — sjs');
  });

  it("won't offer it in a group, to a non-admin, or for a missing folder", async () => {
    const { api } = ctxFor({});

    expect((await nb.offerNewBotForSession(api as never, '-100123:7', 'sjs')).ok).toBe(false);
    expect((await nb.offerNewBotForSession(api as never, String(STRANGER), 'sjs')).message).toMatch(/admin/);
    expect((await nb.offerNewBotForSession(api as never, String(ADMIN), 'nope')).message).toMatch(/no project folder/);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
});
