import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// botname-settings persists cooldowns / last-sent names under ~/.claudegram.
// Redirect HOME before the module is ever imported so the suite can't read or
// clobber the developer's real state.
beforeAll(() => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-botname-'));
  vi.stubEnv('HOME', tmpHome);
});

// The sync is once-per-process by design, so every case needs a fresh module.
async function freshModule() {
  vi.resetModules();
  return import('../../src/telegram/botname-settings.js');
}

/** Fake bot api. BOT_NAME defaults to "TeleCoder" under the test env. */
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

  it('preserves the dynamic " — project" suffix', async () => {
    const { syncBotNameOnStartup } = await freshModule();
    const api = fakeApi('TeleCoder — telecoder');

    const result = await syncBotNameOnStartup(api);

    expect(result.status).toBe('no_change');
    expect(api.sent).toEqual([]);
  });

  it('defers to a name another path already pushed this process', async () => {
    const { syncBotNameOnStartup, rateLimitedSetMyName } = await freshModule();
    const api = fakeApi('Claudegram 1');

    // e.g. auto-resume restoring a session and pushing "BOT_NAME — project".
    await rateLimitedSetMyName(api, (n) => api.setMyName(n), 'TeleCoder — telecoder');
    const result = await syncBotNameOnStartup(api);

    expect(result.status).toBe('no_change');
    expect(api.sent).toEqual(['TeleCoder — telecoder']);
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
});
