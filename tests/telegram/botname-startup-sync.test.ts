import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// botname-settings persists cooldowns / last-sent names under ~/.telecoder.
// Redirect HOME before the module is ever imported so the suite can't read or
// clobber the developer's real state.
let tmpHome: string;
beforeAll(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-botname-'));
  vi.stubEnv('HOME', tmpHome);
  vi.stubEnv('BOT_NAME', 'TeleCoder');
});

/** The file /botname writes, for the test bot's id. */
function botNameFile(): string {
  return path.join(tmpHome, '.telecoder', 'botname-123456789.json');
}

// The sync is once-per-process by design, so every case needs a fresh module.
async function freshModule() {
  vi.resetModules();
  return import('../../src/telegram/botname-settings.js');
}

/** Fake bot api. BOT_NAME is set to "TeleCoder" for the suite. */
function fakeApi(currentName: string) {
  const sent: string[] = [];
  return {
    sent,
    getMyName: async () => ({ name: currentName }),
    setMyName: async (name: string) => { sent.push(name); return true; },
  };
}

describe('syncBotNameOnStartup', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('renames a bot still carrying a stale display name', async () => {
    const { syncBotNameOnStartup } = await freshModule();
    const api = fakeApi('Claudegram 1');

    const result = await syncBotNameOnStartup(api);

    expect(result.status).toBe('sent');
    expect(api.sent).toEqual(['TeleCoder']);
  });

  it('leaves a name that already matches BOT_NAME alone', async () => {
    const { syncBotNameOnStartup } = await freshModule();
    const api = fakeApi('TeleCoder');

    const result = await syncBotNameOnStartup(api);

    expect(result.status).toBe('no_change');
    expect(api.sent).toEqual([]);
  });

  it('renames a bot still carrying the project suffix of the old dynamic name', async () => {
    const { syncBotNameOnStartup } = await freshModule();
    const api = fakeApi('TeleCoder — telecoder');

    const result = await syncBotNameOnStartup(api);

    expect(result.status).toBe('sent');
    expect(api.sent).toEqual(['TeleCoder']);
  });

  it('prefers the name set with /botname over BOT_NAME', async () => {
    fs.mkdirSync(path.dirname(botNameFile()), { recursive: true });
    fs.writeFileSync(botNameFile(), JSON.stringify({ name: 'Rik\u2019s Coder' }));
    try {
      const { syncBotNameOnStartup } = await freshModule();
      const api = fakeApi('TeleCoder');

      const result = await syncBotNameOnStartup(api);

      expect(result.status).toBe('sent');
      expect(api.sent).toEqual(['Rik\u2019s Coder']);
    } finally {
      fs.rmSync(botNameFile(), { force: true });
    }
  });

  it('renames to the /botname name even when BOT_NAME is not set', async () => {
    vi.stubEnv('BOT_NAME', '');
    fs.mkdirSync(path.dirname(botNameFile()), { recursive: true });
    fs.writeFileSync(botNameFile(), JSON.stringify({ name: 'Named in chat' }));
    try {
      const { syncBotNameOnStartup } = await freshModule();
      const api = fakeApi('My Own Bot');

      const result = await syncBotNameOnStartup(api);

      expect(result.status).toBe('sent');
      expect(api.sent).toEqual(['Named in chat']);
    } finally {
      fs.rmSync(botNameFile(), { force: true });
      vi.stubEnv('BOT_NAME', 'TeleCoder');
    }
  });

  it('does not throw when getMyName fails', async () => {
    const { syncBotNameOnStartup } = await freshModule();
    const api = {
      sent: [] as string[],
      getMyName: async () => { throw new Error('network down'); },
      setMyName: async (name: string) => { api.sent.push(name); return true; },
    };

    const result = await syncBotNameOnStartup(api);

    expect(result.status).toBe('no_change');
    expect(api.sent).toEqual([]);
  });

  it('keeps the BotFather name when BOT_NAME is not set', async () => {
    vi.stubEnv('BOT_NAME', '');
    try {
      const { syncBotNameOnStartup } = await freshModule();
      const api = fakeApi('My Own Bot');

      const result = await syncBotNameOnStartup(api);

      expect(result.status).toBe('no_change');
      expect(api.sent).toEqual([]);
    } finally {
      vi.stubEnv('BOT_NAME', 'TeleCoder');
    }
  });
});
