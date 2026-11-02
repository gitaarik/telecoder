/**
 * Favorites are one list per chat, shared by every bot: the same person moves
 * their bots across the same projects. Each bot is its own process, so none of
 * them may act on a copy it loaded earlier.
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
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-favorites-'));
  vi.stubEnv('HOME', home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

/** Start (or restart) a bot: a new process on the shared state dir. */
async function startBot() {
  vi.resetModules();
  return (await import('../../src/providers/project-favorites.js')).projectFavorites;
}

const CHAT = '37620077';
const favoritesFile = () => path.join(home, '.claudegram', 'project-favorites.json');
const paths = (favorites: { path: string }[]) => favorites.map((f) => f.path);

describe('favorites across bots', () => {
  it('shows a favorite added on another bot straight away', async () => {
    const first = await startBot();
    const second = await startBot();

    first.add(CHAT, '/srv/telecoder');

    expect(paths(second.list(CHAT))).toEqual(['/srv/telecoder']);
    expect(second.has(CHAT, '/srv/telecoder')).toBe(true);
  });

  it('keeps a favorite added on another bot when this one saves', async () => {
    const first = await startBot();
    const second = await startBot();

    first.add(CHAT, '/srv/telecoder');
    second.add(CHAT, '/srv/triallab');

    expect(paths((await startBot()).list(CHAT))).toEqual(['/srv/telecoder', '/srv/triallab']);
  });

  it('keeps a removal made on another bot when this one saves', async () => {
    const first = await startBot();
    first.add(CHAT, '/srv/telecoder');
    const second = await startBot();
    second.list(CHAT);

    first.remove(CHAT, '/srv/telecoder');
    second.add(CHAT, '/srv/triallab');

    expect(paths((await startBot()).list(CHAT))).toEqual(['/srv/triallab']);
  });

  it("won't add one another bot already added", async () => {
    const first = await startBot();
    const second = await startBot();

    first.add(CHAT, '/srv/telecoder');

    expect(second.add(CHAT, '/srv/telecoder')).toBe(false);
    expect(paths(second.list(CHAT))).toEqual(['/srv/telecoder']);
  });

  it('can remove one another bot added', async () => {
    const first = await startBot();
    const second = await startBot();

    first.add(CHAT, '/srv/telecoder');

    expect(second.remove(CHAT, '/srv/telecoder')).toBe(true);
    expect(first.list(CHAT)).toEqual([]);
  });
});

describe('favorites on one bot', () => {
  it('keeps them in the order they were added, and each chat to itself', async () => {
    const bot = await startBot();
    bot.add(CHAT, '/srv/b');
    bot.add(CHAT, '/srv/a');
    bot.add('other', '/srv/c');

    expect(paths(bot.list(CHAT))).toEqual(['/srv/b', '/srv/a']);
    expect(paths(bot.list('other'))).toEqual(['/srv/c']);
  });

  it('says when there was nothing to do', async () => {
    const bot = await startBot();

    expect(bot.add(CHAT, '/srv/a')).toBe(true);
    expect(bot.add(CHAT, '/srv/a/')).toBe(false);
    expect(bot.remove(CHAT, '/srv/missing')).toBe(false);
  });

  it('survives a restart', async () => {
    (await startBot()).add(CHAT, '/srv/a');
    expect(paths((await startBot()).list(CHAT))).toEqual(['/srv/a']);
  });
});

describe('a favorites file that goes wrong', () => {
  it("keeps what it last read when the file can't be read, rather than wiping it on the next save", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const bot = await startBot();
    bot.add(CHAT, '/srv/a');
    fs.writeFileSync(favoritesFile(), 'not json');

    expect(paths(bot.list(CHAT))).toEqual(['/srv/a']);

    bot.add(CHAT, '/srv/b');
    expect(paths((await startBot()).list(CHAT))).toEqual(['/srv/a', '/srv/b']);
  });

  it('starts empty when a bot has never been able to read it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fs.mkdirSync(path.dirname(favoritesFile()), { recursive: true });
    fs.writeFileSync(favoritesFile(), 'not json');

    expect((await startBot()).list(CHAT)).toEqual([]);
  });

  it('takes a deleted file as no favorites', async () => {
    const bot = await startBot();
    bot.add(CHAT, '/srv/a');
    fs.rmSync(favoritesFile());

    expect(bot.list(CHAT)).toEqual([]);
  });
});
