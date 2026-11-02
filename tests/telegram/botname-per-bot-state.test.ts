/**
 * Each bot is its own process, and they all keep state under the same
 * ~/.claudegram. What one bot remembers about its display name must survive
 * another bot saving its own: a wrong "last sent" name makes a real rename look
 * like no change, and a lost block sends a call Telegram has already refused.
 *
 * A fresh module instance stands in for a process here. It holds its own copy
 * of whatever it loaded, and only the disk is shared.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-botname-state-'));
  vi.stubEnv('HOME', home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

/** Start (or restart) a bot: a new process with that bot's token, on the shared state dir. */
async function startBot(id: string) {
  vi.stubEnv('TELEGRAM_BOT_TOKEN', `${id}:TEST_TOKEN`);
  vi.resetModules();
  const { rateLimitedSetMyName } = await import('../../src/telegram/botname-settings.js');

  const sentToTelegram: string[] = [];
  const api = {};
  return {
    sentToTelegram,
    rename: (name: string) =>
      rateLimitedSetMyName(api, async (n) => { sentToTelegram.push(n); }, name),
    /** A rename Telegram refuses, as it does once the bot is over its limit. */
    renameRefused: (name: string) =>
      rateLimitedSetMyName(api, async () => {
        throw new Error('Call to setMyName failed! (429: Too Many Requests: retry after 3600)');
      }, name),
  };
}

describe('the name a bot last sent', () => {
  it('survives another bot saving its own', async () => {
    const before = await startBot('222');
    await before.rename('Bot 2 — telecoder');

    // Bot 3 starts now, so the copy it loads has bot 2 on telecoder.
    const sibling = await startBot('333');

    // Bot 2 moves on. The record has to say sjs-ops from here on.
    const moved = await startBot('222');
    await moved.rename('Bot 2 — sjs-ops');
    await sibling.rename('Bot 3 — triallab');

    // Back to telecoder after a restart. Telegram shows sjs-ops, so this has to go out.
    const restarted = await startBot('222');
    const result = await restarted.rename('Bot 2 — telecoder');

    expect(result.status).toBe('sent');
    expect(restarted.sentToTelegram).toEqual(['Bot 2 — telecoder']);
  });

  it('still saves a call after a restart when the name is unchanged', async () => {
    const before = await startBot('222');
    await before.rename('Bot 2 — telecoder');

    const restarted = await startBot('222');
    const result = await restarted.rename('Bot 2 — telecoder');

    expect(result.status).toBe('no_change');
    expect(restarted.sentToTelegram).toEqual([]);
  });

  it("isn't mistaken for another bot's", async () => {
    const bot2 = await startBot('222');
    await bot2.rename('Same name');

    const bot3 = await startBot('333');
    const result = await bot3.rename('Same name');

    expect(result.status).toBe('sent');
    expect(bot3.sentToTelegram).toEqual(['Same name']);
  });
});

describe('a block from Telegram', () => {
  it('survives another bot being blocked too', async () => {
    const bot2 = await startBot('222');
    const sibling = await startBot('333');

    expect((await bot2.renameRefused('Bot 2 — telecoder')).status).toBe('newly_blocked');
    expect((await sibling.renameRefused('Bot 3 — triallab')).status).toBe('newly_blocked');

    const restarted = await startBot('222');
    const result = await restarted.rename('Bot 2 — sjs-ops');

    expect(result.status).toBe('still_blocked');
    expect(restarted.sentToTelegram).toEqual([]);
  });

  it("doesn't hold back another bot", async () => {
    const blocked = await startBot('222');
    await blocked.renameRefused('Bot 2 — telecoder');

    const bot3 = await startBot('333');
    const result = await bot3.rename('Bot 3 — triallab');

    expect(result.status).toBe('sent');
    expect(bot3.sentToTelegram).toEqual(['Bot 3 — triallab']);
  });

  it('ends when the time Telegram gave has passed', async () => {
    const blocked = await startBot('222');
    await blocked.renameRefused('Bot 2 — telecoder');

    const later = Date.now() + 2 * 60 * 60 * 1000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(later);
    try {
      const restarted = await startBot('222');
      const result = await restarted.rename('Bot 2 — telecoder');

      expect(result.status).toBe('sent');
      expect(restarted.sentToTelegram).toEqual(['Bot 2 — telecoder']);
    } finally {
      clock.mockRestore();
    }
  });
});
