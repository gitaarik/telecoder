/**
 * /botname renames the bot: the name is saved per bot, wins over BOT_NAME,
 * goes to Telegram at once when Telegram allows, and the reply says what
 * happened when it doesn't.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Context } from 'grammy';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-botname-cmd-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('BOT_NAME', 'TeleCoder');
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

function chat(command: string, telegramName = 'TeleCoder', setMyName?: (name: string) => Promise<unknown>) {
  const reply = vi.fn(async (_text: string, _opts?: Record<string, unknown>) => ({}));
  const sent: string[] = [];
  const api = {
    getMyName: async () => ({ name: telegramName }),
    setMyName: setMyName ?? (async (name: string) => { sent.push(name); return true; }),
  };
  const ctx = { chat: { id: 77, type: 'private' }, message: { text: command }, reply, api } as unknown as Context;
  return { ctx, reply, sent };
}

const refused = async () => {
  throw new Error('Call to setMyName failed! (429: Too Many Requests: retry after 7200)');
};

async function load() {
  const { handleBotName } = await import('../../src/bot/handlers/command/botname.js');
  const { config, getBotNameSource } = await import('../../src/config.js');
  return { handleBotName, config, getBotNameSource };
}

describe('/botname <name>', () => {
  it('renames the bot on Telegram and in the running config, and saves it', async () => {
    const { handleBotName, config, getBotNameSource } = await load();
    const { ctx, reply, sent } = chat('/botname Rik_s (coder)');

    await handleBotName(ctx);

    expect(sent).toEqual(['Rik_s (coder)']);
    expect(config.BOT_NAME).toBe('Rik_s (coder)');
    expect(getBotNameSource()).toBe('command');
    const file = path.join(home, '.telecoder', 'botname-123456789.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({ name: 'Rik_s (coder)' });
    const [text, opts] = reply.mock.calls[0];
    expect(text).toBe('✅ Bot name: Rik_s (coder)\nTelegram shows it now.');
    expect(opts).not.toHaveProperty('parse_mode');
  });

  it('says so when Telegram refuses, and keeps the name for later', async () => {
    const { handleBotName, config } = await load();
    const { ctx, reply } = chat('/botname Later', 'TeleCoder', refused);

    await handleBotName(ctx);

    expect(config.BOT_NAME).toBe('Later');
    const [text] = reply.mock.calls[0];
    expect(text).toContain('✅ Bot name: Later');
    expect(text).toContain('rate-limiting renames');
    expect(text).toContain('sent again in ~2h');
  });

  it('rejects a name over Telegram\'s limit', async () => {
    const { handleBotName, config } = await load();
    const { ctx, reply, sent } = chat(`/botname ${'x'.repeat(65)}`);

    await handleBotName(ctx);

    expect(sent).toEqual([]);
    expect(config.BOT_NAME).toBe('TeleCoder');
    expect(reply.mock.calls[0][0]).toContain('at most 64 characters');
  });
});

describe('/botname reset', () => {
  it('goes back to BOT_NAME and removes the saved name', async () => {
    const { handleBotName, config, getBotNameSource } = await load();
    await handleBotName(chat('/botname Temporary').ctx);
    const { ctx, reply, sent } = chat('/botname reset', 'Temporary');

    await handleBotName(ctx);

    expect(sent).toEqual(['TeleCoder']);
    expect(config.BOT_NAME).toBe('TeleCoder');
    expect(getBotNameSource()).toBe('env');
    expect(fs.existsSync(path.join(home, '.telecoder', 'botname-123456789.json'))).toBe(false);
    expect(reply.mock.calls[0][0]).toContain('back to BOT_NAME');
  });
});

describe('/botname', () => {
  it('shows the Telegram name, where the wanted name comes from, and a pending cooldown', async () => {
    const { handleBotName } = await load();
    await handleBotName(chat('/botname Wanted', 'Old', refused).ctx);
    const { ctx, reply } = chat('/botname', 'Old');

    await handleBotName(ctx);

    const [text, opts] = reply.mock.calls[0];
    expect(text).toContain('Telegram shows: Old');
    expect(text).toContain('Set with /botname: Wanted');
    expect(text).toContain('rate-limiting renames');
    expect(text).toContain('~2h');
    expect(opts).not.toHaveProperty('parse_mode');
  });

  it('says the BotFather name is kept when nothing names the bot', async () => {
    vi.stubEnv('BOT_NAME', '');
    vi.resetModules();
    const { handleBotName } = await load();
    const { ctx, reply } = chat('/botname', 'My Own Bot');

    await handleBotName(ctx);

    const [text] = reply.mock.calls[0];
    expect(text).toContain('Telegram shows: My Own Bot');
    expect(text).toContain('As chosen in BotFather');
  });
});
