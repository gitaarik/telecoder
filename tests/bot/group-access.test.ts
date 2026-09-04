import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { config } from '../../src/config.js';
import {
  configureGroupAccessStore,
  grantAccess,
  listGroupAccess,
  resolveRole,
  revokeAccess,
} from '../../src/bot/access/group-access.js';
import { isAdmin } from '../../src/utils/admins.js';

// Test env (vitest.config.ts): ALLOWED_USER_IDS=1,2,3
const ADMIN = 2;
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

  it('defaults an ungranted member to spectator', () => {
    // Guard on the safe direction. The group-role work arrived defaulting to
    // contributor, which was right when Telegram membership was the whole
    // gate; layered on top of the roster it would instead widen who can prompt
    // the agent, so the merged default matches what the roster already
    // enforced. Flipping it back should have to be deliberate.
    expect(config.GROUP_MEMBERS_DEFAULT).toBe('spectator');
    expect(resolveRole(GROUP, FRIEND)).toBe('spectator');
  });

  it('treats an ALLOWED_USER_IDS member as an admin anywhere', () => {
    // ADMIN_USER_IDS unset, so isAdmin() falls back to the whole allow-list —
    // which is why this store has no admin list of its own to drift from it.
    expect(isAdmin(ADMIN)).toBe(true);
    expect(resolveRole(GROUP, ADMIN)).toBe('admin');
    withDefault('spectator', () => {
      expect(resolveRole(GROUP, ADMIN)).toBe('admin');
    });
  });

  it('treats an allow-listed non-admin as a contributor without a stored grant', () => {
    const previous = config.ADMIN_USER_IDS;
    (config as { ADMIN_USER_IDS: number[] }).ADMIN_USER_IDS = [1];
    try {
      withDefault('spectator', () => {
        expect(resolveRole(GROUP, 1)).toBe('admin');
        // This is the join between the two layers: the global roster answers
        // "may they use the bot", and that alone makes them a contributor in
        // every group, with no per-group grant recorded anywhere.
        expect(resolveRole(GROUP, 3)).toBe('contributor');
        expect(resolveRole(GROUP, FRIEND)).toBe('spectator');

        revokeAccess(GROUP, 3);
        expect(resolveRole(GROUP, 3)).toBe('spectator'); // a /deny still reaches them
      });
    } finally {
      (config as { ADMIN_USER_IDS: number[] }).ADMIN_USER_IDS = previous;
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
    grantAccess(GROUP, FRIEND, { username: 'friend', grantedBy: ADMIN });
    configureGroupAccessStore(dir); // drops the in-memory cache

    withDefault('spectator', () => {
      expect(resolveRole(GROUP, FRIEND)).toBe('contributor');
    });
    const { allow } = listGroupAccess(GROUP);
    expect(allow).toHaveLength(1);
    expect(allow[0]).toMatchObject({ userId: FRIEND, username: 'friend', grantedBy: ADMIN });
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

  it('keeps no username cache of its own', () => {
    // Handle resolution belongs to the global roster, which already learns one
    // from every message the bot sees. A second cache here would be a second
    // answer to the same question, free to drift from the first — so the file
    // this store writes holds group roles and nothing else.
    grantAccess(GROUP, FRIEND, { username: 'friend' });
    const file = path.join(dir, fs.readdirSync(dir).find((f) => f.startsWith('group-access-'))!);
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));

    expect(Object.keys(written)).toEqual(['groups']);
    expect(written).not.toHaveProperty('usernames');
  });
});
