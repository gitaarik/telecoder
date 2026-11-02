/**
 * Each bot has its own roster. "Who can use this bot" is what /users, /allow and
 * /deny have always said, bots can differ in who `.env` lets in, and a first
 * guest switches on a bot's guardrails. So neither a guest nor a /deny may spill
 * over to the other bots on the machine.
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
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-roster-'));
  vi.stubEnv('HOME', home);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

/** Start (or restart) a bot: a new process with that bot's token, on the shared state dir. */
async function startBot(id: string) {
  vi.stubEnv('TELEGRAM_BOT_TOKEN', `${id}:TEST_TOKEN`);
  vi.resetModules();
  const roster = await import('../../src/utils/user-roster.js');
  // Every bot reads its roster as it boots, to log who it lets in (src/index.ts).
  roster.listAdmitted();
  return { ...roster, ...(await import('../../src/utils/admins.js')) };
}

const stateFile = (name: string) => path.join(home, '.claudegram', name);

/** The file every bot shared before rosters were per-bot. */
function writeSharedRoster(guests: number[], seen: { id: number; username: string }[] = []): void {
  fs.mkdirSync(path.dirname(stateFile('user-roster.json')), { recursive: true });
  fs.writeFileSync(stateFile('user-roster.json'), JSON.stringify({
    admitted: guests.map((id) => ({ id, admittedAt: '2026-09-03T00:00:00.000Z', admittedBy: ADMIN })),
    seen: seen.map((user) => ({ ...user, seenAt: '2026-09-03T00:00:00.000Z' })),
  }));
}

const ADMIN = 1;
const GUEST = { id: 555, username: 'guest' };
const NEWCOMER = { id: 777, username: 'newcomer' };

describe('a bot with its own roster', () => {
  it('lets a guest into the bot they were admitted on, and no other', async () => {
    const first = await startBot('222');
    first.admitUser(GUEST, ADMIN);

    const second = await startBot('333');
    expect(first.isAllowedUser(GUEST.id)).toBe(true);
    expect(second.isAllowedUser(GUEST.id)).toBe(false);
  });

  it("switches on a guest's guardrails only where the guest is", async () => {
    const first = await startBot('222');
    first.admitUser(GUEST, ADMIN);

    const second = await startBot('333');
    expect(first.hasGuestUsers()).toBe(true);
    expect(second.hasGuestUsers()).toBe(false);
  });

  it('keeps a guest when another bot saves', async () => {
    const first = await startBot('222');
    const second = await startBot('333');

    first.admitUser(GUEST, ADMIN);
    second.noteSeenUser(NEWCOMER);

    const restarted = await startBot('222');
    expect(restarted.isAllowedUser(GUEST.id)).toBe(true);
  });

  it('keeps a /deny when another bot saves', async () => {
    const first = await startBot('222');
    first.admitUser(GUEST, ADMIN);
    const second = await startBot('333');

    first.revokeUser(GUEST.id);
    second.noteSeenUser(NEWCOMER);

    const restarted = await startBot('222');
    expect(restarted.isAllowedUser(GUEST.id)).toBe(false);
  });

  it('keeps who it has seen apart from who another bot has seen', async () => {
    const first = await startBot('222');
    first.noteSeenUser(NEWCOMER);

    const second = await startBot('333');
    expect(second.resolveUser('@newcomer')).toBeUndefined();
  });
});

describe('the first start after rosters became per-bot', () => {
  it('inherits the shared roster, so nobody loses access', async () => {
    writeSharedRoster([GUEST.id], [NEWCOMER]);

    const bot = await startBot('222');

    expect(bot.isAllowedUser(GUEST.id)).toBe(true);
    expect(bot.resolveUser('@newcomer')?.id).toBe(NEWCOMER.id);
  });

  it('gives every bot its own copy and leaves the shared file as it was', async () => {
    writeSharedRoster([GUEST.id]);
    const before = fs.readFileSync(stateFile('user-roster.json'), 'utf-8');

    await startBot('222');
    await startBot('333');

    expect(fs.existsSync(stateFile('user-roster-222.json'))).toBe(true);
    expect(fs.existsSync(stateFile('user-roster-333.json'))).toBe(true);
    expect(fs.readFileSync(stateFile('user-roster.json'), 'utf-8')).toBe(before);
  });

  it('no longer needs the shared file afterwards', async () => {
    writeSharedRoster([GUEST.id]);
    await startBot('222');
    fs.rmSync(stateFile('user-roster.json'));

    expect((await startBot('222')).isAllowedUser(GUEST.id)).toBe(true);
  });

  it('never brings back a guest denied since, though the shared file still lists them', async () => {
    writeSharedRoster([GUEST.id]);
    (await startBot('222')).revokeUser(GUEST.id);

    expect((await startBot('222')).isAllowedUser(GUEST.id)).toBe(false);
  });

  it('takes a /deny as being about this bot, so an inherited guest stays on the others', async () => {
    writeSharedRoster([GUEST.id]);
    const first = await startBot('222');
    const second = await startBot('333');

    first.revokeUser(GUEST.id);

    expect(first.isAllowedUser(GUEST.id)).toBe(false);
    expect(second.isAllowedUser(GUEST.id)).toBe(true);
  });
});
