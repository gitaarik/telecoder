import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ADMIN = 100;
let stateDir: string;

vi.mock('../../src/utils/json-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/json-store.js')>();
  return { ...actual, getStateDir: () => stateDir };
});
vi.mock('../../src/utils/admins.js', () => ({ isAdmin: (id?: number) => id === ADMIN }));
vi.mock('../../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config.js')>();
  return { ...actual, config: { ...actual.config, HOME_PROJECT: '/w/sjs' } };
});

type Middleware = (ctx: unknown, next: () => Promise<void>) => Promise<unknown>;

/** A fresh module on a fake bot whose threads are off until `turnOn()`. */
async function load() {
  vi.resetModules();
  const mod = await import('../../src/telegram/threads-setup.js');
  let topics = false;
  let middleware: Middleware | undefined;
  const bot = {
    botInfo: { username: 'sjs_ops_telecoder_bot', has_topics_enabled: false },
    api: {
      getMe: vi.fn(async () => ({ username: 'sjs_ops_telecoder_bot', has_topics_enabled: topics })),
      sendMessage: vi.fn().mockResolvedValue({}),
    },
    use: (fn: Middleware) => { middleware = fn; },
  };
  mod.initThreadsSetup(bot as never);
  const send = async (from: number, chatType = 'private') => {
    const reply = vi.fn().mockResolvedValue({});
    const next = vi.fn(async () => {});
    await middleware!({ me: bot.botInfo, chat: { id: from, type: chatType }, from: { id: from }, reply }, next);
    return { reply, next };
  };
  return { ...mod, bot, send, turnOn: () => { topics = true; } };
}

describe('threads setup', () => {
  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-threads-setup-'));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("sends the steps with an admin's first message, once, and lets the message through", async () => {
    const t = await load();

    const first = await t.send(ADMIN);
    const second = await t.send(ADMIN);

    expect(first.reply).toHaveBeenCalledTimes(1);
    expect(first.reply.mock.calls[0][0]).toContain('@sjs_ops_telecoder_bot');
    expect(first.reply.mock.calls[0][1].reply_markup.inline_keyboard[0][0].url).toBe('https://t.me/BotFather');
    expect(first.next).toHaveBeenCalled();
    expect(second.reply).not.toHaveBeenCalled();
  });

  it('stays quiet to non-admins, in groups, and once threads are on', async () => {
    const t = await load();

    expect((await t.send(200)).reply).not.toHaveBeenCalled();
    expect((await t.send(ADMIN, 'supergroup')).reply).not.toHaveBeenCalled();
    t.bot.botInfo.has_topics_enabled = true;
    expect((await t.send(ADMIN)).reply).not.toHaveBeenCalled();
  });

  it('notices threads going on, takes them into botInfo and says so', async () => {
    const t = await load();
    await t.send(ADMIN);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.bot.api.sendMessage).not.toHaveBeenCalled();

    t.turnOn();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(t.bot.botInfo.has_topics_enabled).toBe(true);
    expect(t.bot.api.sendMessage).toHaveBeenCalledWith(ADMIN, expect.stringContaining('Threads are on'));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(t.bot.api.getMe).toHaveBeenCalledTimes(2);
  });

  it('picks the checking back up after a restart, without repeating the steps', async () => {
    const before = await load();
    await before.send(ADMIN);
    before.resetThreadsSetupForTest();

    const after = await load();
    after.resumeThreadsSetup(after.bot as never);
    expect((await after.send(ADMIN)).reply).not.toHaveBeenCalled();

    after.turnOn();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(after.bot.api.sendMessage).toHaveBeenCalledWith(ADMIN, expect.stringContaining('Threads are on'));
  });
});
