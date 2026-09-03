import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { config } from '../../src/config.js';
import {
  configureGroupAccessStore,
  grantAccess,
  isOwner,
  listGroupAccess,
  rememberUsername,
  resolveRole,
  resolveUserRef,
  revokeAccess,
} from '../../src/bot/access/group-access.js';

// Test env (vitest.config.ts): ALLOWED_USER_IDS=1,2,3
const OWNER = 2;
const GROUP = -1009990001;
const OTHER_GROUP = -1009990002;
const FRIEND = 999;

let dir: string;

function withDefault(value: 'contributor' | 'spectator', run: () => void): void {
  const previous = config.GROUP_MEMBERS_DEFAULT;
  config.GROUP_MEMBERS_DEFAULT = value;
  try {
    run();
  } finally {
    config.GROUP_MEMBERS_DEFAULT = previous;
  }
}

describe('group access store', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-access-'));
    configureGroupAccessStore(dir);
  });

  afterEach(() => {
    configureGroupAccessStore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('treats an ALLOWED_USER_IDS member as an owner anywhere', () => {
    expect(isOwner(OWNER)).toBe(true);
    expect(resolveRole(GROUP, OWNER)).toBe('owner');
    withDefault('spectator', () => {
      expect(resolveRole(GROUP, OWNER)).toBe('owner');
    });
  });

  it('treats an allow-listed non-owner as a contributor without a stored grant', () => {
    const previous = config.OWNER_USER_IDS;
    (config as { OWNER_USER_IDS: number[] }).OWNER_USER_IDS = [1];
    try {
      withDefault('spectator', () => {
        expect(resolveRole(GROUP, 1)).toBe('owner');
        expect(resolveRole(GROUP, 3)).toBe('contributor'); // allow-listed, not an owner
        expect(resolveRole(GROUP, FRIEND)).toBe('spectator');

        revokeAccess(GROUP, 3);
        expect(resolveRole(GROUP, 3)).toBe('spectator'); // a /deny still reaches them
      });
    } finally {
      (config as { OWNER_USER_IDS: number[] }).OWNER_USER_IDS = previous;
    }
  });

  it('falls back to GROUP_MEMBERS_DEFAULT for an ungranted member', () => {
    withDefault('contributor', () => {
      expect(resolveRole(GROUP, FRIEND)).toBe('contributor');
    });
    withDefault('spectator', () => {
      expect(resolveRole(GROUP, FRIEND)).toBe('spectator');
    });
  });

  it('grants and revokes, with the latest write winning either way', () => {
    withDefault('spectator', () => {
      expect(grantAccess(GROUP, FRIEND)).toBe('spectator');
      expect(resolveRole(GROUP, FRIEND)).toBe('contributor');
      expect(revokeAccess(GROUP, FRIEND)).toBe('contributor');
      expect(resolveRole(GROUP, FRIEND)).toBe('spectator');
      grantAccess(GROUP, FRIEND);
      expect(resolveRole(GROUP, FRIEND)).toBe('contributor');
    });
  });

  it('revokes under a contributor default too', () => {
    withDefault('contributor', () => {
      revokeAccess(GROUP, FRIEND);
      expect(resolveRole(GROUP, FRIEND)).toBe('spectator');
    });
  });

  it('scopes a grant to the group it was made in', () => {
    withDefault('spectator', () => {
      grantAccess(GROUP, FRIEND);
      expect(resolveRole(GROUP, FRIEND)).toBe('contributor');
      expect(resolveRole(OTHER_GROUP, FRIEND)).toBe('spectator');
    });
  });

  it('survives a reload from disk', () => {
    grantAccess(GROUP, FRIEND, { username: 'friend', grantedBy: OWNER });
    configureGroupAccessStore(dir); // drops the in-memory cache

    withDefault('spectator', () => {
      expect(resolveRole(GROUP, FRIEND)).toBe('contributor');
    });
    const { allow } = listGroupAccess(GROUP);
    expect(allow).toHaveLength(1);
    expect(allow[0]).toMatchObject({ userId: FRIEND, username: 'friend', grantedBy: OWNER });
  });

  it('keeps the state file owner-readable only', () => {
    grantAccess(GROUP, FRIEND);
    const file = fs.readdirSync(dir).find((f) => f.startsWith('group-access-'));
    expect(file).toBeDefined();
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(dir, file!)).mode & 0o777).toBe(0o600);
    }
  });

  it('lists explicit grants and denials separately', () => {
    grantAccess(GROUP, FRIEND, { username: 'friend' });
    revokeAccess(GROUP, 1234, { username: 'lurker' });

    const { allow, deny } = listGroupAccess(GROUP);
    expect(allow.map((m) => m.userId)).toEqual([FRIEND]);
    expect(deny.map((m) => m.userId)).toEqual([1234]);
  });

  it('resolves a user reference by id, by cached handle, or not at all', () => {
    expect(resolveUserRef('999')).toBe(999);
    expect(resolveUserRef('@nobody')).toBeUndefined();

    rememberUsername(FRIEND, 'Friend');
    expect(resolveUserRef('@friend')).toBe(FRIEND);
    expect(resolveUserRef('FRIEND')).toBe(FRIEND);
    expect(resolveUserRef('  @Friend ')).toBe(FRIEND);
  });

  it('only writes the username cache when the pair actually changes', () => {
    rememberUsername(FRIEND, 'friend');
    const file = path.join(dir, fs.readdirSync(dir).find((f) => f.startsWith('group-access-'))!);
    const firstWrite = fs.statSync(file).mtimeMs;

    rememberUsername(FRIEND, 'friend');
    expect(fs.statSync(file).mtimeMs).toBe(firstWrite);

    rememberUsername(4242, 'friend'); // handle changed hands
    expect(resolveUserRef('@friend')).toBe(4242);
  });
});
