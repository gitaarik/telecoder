import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Test env (vitest.config.ts): ALLOWED_USER_IDS=1,2,3
//
// The admin roster is read off the frozen `config` object, which parses env at
// import time — so anything that changes ADMIN_USER_IDS has to stub the env and
// re-import the module graph rather than mutating config in place.
async function loadAdmins(adminIds?: string, allowedIds?: string) {
  vi.resetModules();
  if (adminIds === undefined) vi.stubEnv('ADMIN_USER_IDS', '');
  else vi.stubEnv('ADMIN_USER_IDS', adminIds);
  // config.ts refuses to start when ADMIN_USER_IDS names an id ALLOWED_USER_IDS
  // does not, so a test using an unusual admin id has to widen both.
  if (allowedIds !== undefined) vi.stubEnv('ALLOWED_USER_IDS', allowedIds);
  return import('../../src/utils/admins.js');
}

describe('admin roster', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('treats every allowed user as an admin when ADMIN_USER_IDS is unset', async () => {
    const { getAdminIds, isAdmin, hasGuestUsers } = await loadAdmins();
    expect(getAdminIds()).toEqual([1, 2, 3]);
    expect(isAdmin(1)).toBe(true);
    expect(isAdmin(3)).toBe(true);
    expect(hasGuestUsers()).toBe(false);
  });

  it('narrows to the configured subset and reports the rest as guests', async () => {
    const { getAdminIds, getGuestIds, isAdmin, hasGuestUsers } = await loadAdmins('1');
    expect(getAdminIds()).toEqual([1]);
    expect(getGuestIds()).toEqual([2, 3]);
    expect(isAdmin(1)).toBe(true);
    expect(isAdmin(2)).toBe(false);
    expect(hasGuestUsers()).toBe(true);
  });

  it('does not count a roster listing everyone as having guests', async () => {
    const { hasGuestUsers, getGuestIds } = await loadAdmins('1,2,3');
    expect(hasGuestUsers()).toBe(false);
    expect(getGuestIds()).toEqual([]);
  });

  it('rejects an unknown user and an absent user id', async () => {
    const { isAdmin } = await loadAdmins('1');
    expect(isAdmin(999)).toBe(false);
    expect(isAdmin(undefined)).toBe(false);
  });

  it('never treats the anonymous-admin bot as an admin', async () => {
    // The reachable case: the auth middleware lets this id through in an
    // allow-listed group, so it can be in ALLOWED_USER_IDS. With no explicit
    // roster the admins fall back to the whole allow-list, which would adopt it.
    const { isAdmin, GROUP_ANONYMOUS_BOT_ID } = await loadAdmins(undefined, `1,2,3,${1087968824}`);
    expect(GROUP_ANONYMOUS_BOT_ID).toBe(1087968824);
    expect(isAdmin(GROUP_ANONYMOUS_BOT_ID)).toBe(false);
  });

  it('never treats the anonymous-admin bot as an admin even when listed explicitly', async () => {
    // Any Telegram group admin can post anonymously, so honouring it would
    // turn group-admin rights into bot-admin rights.
    const { isAdmin } = await loadAdmins(`1,${1087968824}`, `1,2,3,${1087968824}`);
    expect(isAdmin(1087968824)).toBe(false);
    expect(isAdmin(1)).toBe(true);
  });

  it('tolerates whitespace and blank entries in the list', async () => {
    const { getAdminIds } = await loadAdmins(' 1 , 2 ');
    expect(getAdminIds()).toEqual([1, 2]);
  });
});

/**
 * An admin id the allow-list does not carry can never act, so it is always a
 * typo or the "I set ADMIN_USER_IDS instead of ALLOWED_USER_IDS" mistake.
 * Refusing to start says so while the person is still looking at the env file,
 * rather than leaving it to surface as an approval that went to the wrong
 * person days later.
 */
describe('orphaned admin ids', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  async function loadConfig(adminIds: string): Promise<void> {
    vi.resetModules();
    vi.stubEnv('ADMIN_USER_IDS', adminIds);
    await import('../../src/config.js');
  }

  it('refuses to start, naming the id and both variables', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    await expect(loadConfig('1,4242')).rejects.toThrow('process.exit(1)');

    const said = error.mock.calls.flat().join('\n');
    expect(said).toContain('4242');
    expect(said).toContain('ALLOWED_USER_IDS');
  });

  it('starts when every admin id is also an allowed id', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exited');
    }) as never);

    await expect(loadConfig('1,2')).resolves.toBeUndefined();
    expect(exit).not.toHaveBeenCalled();
  });

  it('leaves a single-user install alone when ADMIN_USER_IDS is unset', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exited');
    }) as never);

    await expect(loadConfig('')).resolves.toBeUndefined();
    expect(exit).not.toHaveBeenCalled();
  });
});
