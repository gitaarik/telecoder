import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as realOs from 'os';

// The roster persists under os.homedir()/.claudegram; point it at a scratch dir
// so the suite never reads or writes the developer's real state.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: actual, homedir: () => process.env.TELECODER_TEST_HOME ?? actual.homedir() };
});

let home: string;

beforeAll(() => {
  home = fs.mkdtempSync(path.join(realOs.tmpdir(), 'telecoder-roster-'));
  process.env.TELECODER_TEST_HOME = home;
});

afterAll(() => {
  delete process.env.TELECODER_TEST_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

// Imported after the mock so getStateDir() resolves under the scratch home.
// Test env (vitest.config.ts): ALLOWED_USER_IDS=1,2,3
const {
  isAllowedUser,
  allAllowedUserIds,
  admitUser,
  revokeUser,
  noteSeenUser,
  resolveUser,
  listAdmitted,
  listPending,
  describeUser,
  envAllowedIds,
  resetRosterCache,
} = await import('../../src/utils/user-roster.js');

const ADMIN = 1;
const ROSTER_FILE = () => path.join(home, '.claudegram', 'user-roster.json');

beforeEach(() => {
  fs.rmSync(ROSTER_FILE(), { force: true });
  resetRosterCache();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('isAllowedUser', () => {
  it('accepts an id from ALLOWED_USER_IDS', () => {
    expect(isAllowedUser(2)).toBe(true);
  });

  it('rejects an unknown id', () => {
    expect(isAllowedUser(999)).toBe(false);
  });

  it('rejects undefined rather than throwing', () => {
    expect(isAllowedUser(undefined)).toBe(false);
  });

  it('accepts an id admitted at runtime, with no restart', () => {
    expect(isAllowedUser(999)).toBe(false);
    admitUser({ id: 999, username: 'newcomer' }, ADMIN);
    expect(isAllowedUser(999)).toBe(true);
  });
});

describe('admitUser', () => {
  it('reports already-allowed for an env id and does not duplicate it', () => {
    expect(admitUser({ id: 2 }, ADMIN)).toBe('already-allowed');
    expect(listAdmitted()).toHaveLength(0);
  });

  it('reports already-allowed the second time round', () => {
    expect(admitUser({ id: 999 }, ADMIN)).toBe('admitted');
    expect(admitUser({ id: 999 }, ADMIN)).toBe('already-allowed');
    expect(listAdmitted()).toHaveLength(1);
  });

  it('records who admitted them and when', () => {
    admitUser({ id: 999, username: 'newcomer', name: 'New Comer' }, ADMIN);
    const [entry] = listAdmitted();
    expect(entry).toMatchObject({ id: 999, username: 'newcomer', name: 'New Comer', admittedBy: ADMIN });
    expect(Date.parse(entry.admittedAt)).not.toBeNaN();
  });

  it('survives a reload — the whole point of persisting it', () => {
    admitUser({ id: 999, username: 'newcomer' }, ADMIN);
    resetRosterCache();
    expect(isAllowedUser(999)).toBe(true);
  });

  it('widens the effective allow-list', () => {
    admitUser({ id: 999 }, ADMIN);
    expect(allAllowedUserIds().sort((a, b) => a - b)).toEqual([1, 2, 3, 999]);
    // …without rewriting what .env said.
    expect(envAllowedIds()).toEqual([1, 2, 3]);
  });
});

describe('revokeUser', () => {
  it('removes someone admitted at runtime', () => {
    admitUser({ id: 999 }, ADMIN);
    expect(revokeUser(999)).toBe('revoked');
    expect(isAllowedUser(999)).toBe(false);
  });

  it('refuses an env-configured id instead of pretending to remove it', () => {
    expect(revokeUser(2)).toBe('env-configured');
    expect(isAllowedUser(2)).toBe(true);
  });

  it('reports not-allowed for someone who never had access', () => {
    expect(revokeUser(999)).toBe('not-allowed');
  });

  it('persists the removal', () => {
    admitUser({ id: 999 }, ADMIN);
    revokeUser(999);
    resetRosterCache();
    expect(isAllowedUser(999)).toBe(false);
  });
});

describe('resolveUser', () => {
  it('finds a seen user by @handle, case-insensitively', () => {
    noteSeenUser({ id: 999, username: 'NewComer', name: 'New Comer' }, -100);
    expect(resolveUser('@newcomer')).toMatchObject({ id: 999 });
    expect(resolveUser('NEWCOMER')).toMatchObject({ id: 999 });
  });

  it('returns undefined for a handle never seen — the bot cannot ask Telegram', () => {
    expect(resolveUser('@stranger')).toBeUndefined();
  });

  it('accepts a raw numeric id even for someone never seen', () => {
    expect(resolveUser('4242')).toEqual({ id: 4242 });
  });

  it('carries the known name back for a numeric id that has been seen', () => {
    noteSeenUser({ id: 4242, username: 'known', name: 'Known Person' }, -100);
    expect(resolveUser('4242')).toMatchObject({ id: 4242, name: 'Known Person' });
  });

  it('resolves a re-used handle to whoever carries it now', () => {
    noteSeenUser({ id: 111, username: 'shared' }, -100);
    noteSeenUser({ id: 222, username: 'shared' }, -100);
    expect(resolveUser('@shared')).toMatchObject({ id: 222 });
  });

  it('ignores empty and whitespace queries', () => {
    expect(resolveUser('')).toBeUndefined();
    expect(resolveUser('   ')).toBeUndefined();
    expect(resolveUser('@')).toBeUndefined();
  });
});

describe('noteSeenUser', () => {
  it('does not rewrite the file when nothing identifying changed', () => {
    noteSeenUser({ id: 999, username: 'same' }, -100);
    const first = fs.statSync(ROSTER_FILE()).mtimeMs;
    const before = fs.readFileSync(ROSTER_FILE(), 'utf-8');
    noteSeenUser({ id: 999, username: 'same' }, -100);
    expect(fs.readFileSync(ROSTER_FILE(), 'utf-8')).toBe(before);
    expect(fs.statSync(ROSTER_FILE()).mtimeMs).toBe(first);
  });

  it('updates a changed username', () => {
    noteSeenUser({ id: 999, username: 'old' }, -100);
    noteSeenUser({ id: 999, username: 'new' }, -100);
    expect(resolveUser('@new')).toMatchObject({ id: 999 });
    expect(resolveUser('@old')).toBeUndefined();
  });

  it('keeps one entry per user', () => {
    noteSeenUser({ id: 999, username: 'a' }, -100);
    noteSeenUser({ id: 999, username: 'b' }, -100);
    expect(listPending().filter((u) => u.id === 999)).toHaveLength(1);
  });
});

describe('listPending', () => {
  it('lists only people who cannot currently use the bot', () => {
    noteSeenUser({ id: 2 }, -100); // in .env
    noteSeenUser({ id: 999 }, -100); // stranger
    expect(listPending().map((u) => u.id)).toEqual([999]);
  });

  it('drops someone once they are admitted', () => {
    noteSeenUser({ id: 999 }, -100);
    admitUser({ id: 999 }, ADMIN);
    expect(listPending().map((u) => u.id)).not.toContain(999);
  });
});

describe('describeUser', () => {
  it('prefers name with handle', () => {
    expect(describeUser({ id: 1, name: 'Ada', username: 'ada' })).toBe('Ada (@ada)');
  });

  it('falls back through name, handle, then id', () => {
    expect(describeUser({ id: 1, name: 'Ada' })).toBe('Ada');
    expect(describeUser({ id: 1, username: 'ada' })).toBe('@ada');
    expect(describeUser({ id: 1 })).toBe('id 1');
  });
});

describe('corrupt state', () => {
  it('starts from empty rather than throwing', () => {
    fs.mkdirSync(path.dirname(ROSTER_FILE()), { recursive: true });
    fs.writeFileSync(ROSTER_FILE(), 'not json at all');
    resetRosterCache();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(isAllowedUser(999)).toBe(false);
    expect(isAllowedUser(2)).toBe(true);
  });
});
