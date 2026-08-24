import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Test env (vitest.config.ts): ALLOWED_USER_IDS=1,2,3
//
// The admin roster is read off the frozen `config` object, which parses env at
// import time — so anything that changes ADMIN_USER_IDS has to stub the env and
// re-import the module graph rather than mutating config in place.
async function loadAdmins(adminIds?: string) {
  vi.resetModules();
  if (adminIds === undefined) vi.stubEnv('ADMIN_USER_IDS', '');
  else vi.stubEnv('ADMIN_USER_IDS', adminIds);
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
    // Even listed explicitly: any Telegram group admin can post anonymously,
    // so honouring it would make group-admin rights into bot-admin rights.
    const { isAdmin, GROUP_ANONYMOUS_BOT_ID } = await loadAdmins(`1,${1087968824}`);
    expect(GROUP_ANONYMOUS_BOT_ID).toBe(1087968824);
    expect(isAdmin(GROUP_ANONYMOUS_BOT_ID)).toBe(false);
  });

  it('tolerates whitespace and blank entries in the list', async () => {
    const { getAdminIds } = await loadAdmins(' 1 , 2 ');
    expect(getAdminIds()).toEqual([1, 2]);
  });

  it('warns once about an admin who is not in the allow-list', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { getAdminIds } = await loadAdmins('1,4242');
    getAdminIds();
    getAdminIds();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('4242');
  });
});
