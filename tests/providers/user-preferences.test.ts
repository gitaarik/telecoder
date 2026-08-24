import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// BOT_ID is derived from TELEGRAM_BOT_TOKEN, pinned in vitest.config.ts.
const BOT_ID = '123456789';

let stateDir: string;

// Redirect the store at the shared state dir helper rather than at $HOME, so
// the real read/write/atomic-rename path is exercised against a temp dir.
vi.mock('../../src/utils/json-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/json-store.js')>();
  return { ...actual, getStateDir: () => stateDir };
});

function prefsPath(botId = BOT_ID): string {
  return path.join(stateDir, `user-preferences-${botId}.json`);
}

function legacyPath(): string {
  return path.join(stateDir, 'user-preferences.json');
}

function writePrefs(file: string, users: Record<string, unknown>): void {
  fs.writeFileSync(file, JSON.stringify({ users }));
}

function readPrefs(file: string): Record<string, { model?: string; effort?: string }> {
  return JSON.parse(fs.readFileSync(file, 'utf-8')).users;
}

/** Fresh import of the module singleton, which loads on construction. */
async function loadStore() {
  vi.resetModules();
  const mod = await import('../../src/providers/user-preferences.js');
  return mod.userPreferences;
}

describe('userPreferences storage', () => {
  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-prefs-'));
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('writes to a file scoped to this bot, not the shared one', async () => {
    const store = await loadStore();
    store.setModel(42, 'sonnet');

    expect(fs.existsSync(prefsPath())).toBe(true);
    expect(readPrefs(prefsPath())['42'].model).toBe('sonnet');
    // The pre-split shared file is never written to again.
    expect(fs.existsSync(legacyPath())).toBe(false);
  });

  it('seeds from the shared file on first start so nothing resets', async () => {
    writePrefs(legacyPath(), {
      '42': { model: 'opus', effort: 'high', lastUpdated: '2026-01-01T00:00:00.000Z' },
    });

    const store = await loadStore();

    expect(store.getModel(42)).toBe('opus');
    expect(store.getEffort(42)).toBe('high');
    // Claimed immediately rather than on the next change.
    expect(fs.existsSync(prefsPath())).toBe(true);
    expect(readPrefs(prefsPath())['42'].model).toBe('opus');
  });

  it('leaves the shared file in place for siblings that have not started yet', async () => {
    writePrefs(legacyPath(), {
      '42': { model: 'opus', lastUpdated: '2026-01-01T00:00:00.000Z' },
    });

    const store = await loadStore();
    store.setModel(42, 'haiku');

    expect(readPrefs(legacyPath())['42'].model).toBe('opus');
    expect(readPrefs(prefsPath())['42'].model).toBe('haiku');
  });

  it('prefers its own file over the shared one once it exists', async () => {
    writePrefs(legacyPath(), { '42': { model: 'opus', lastUpdated: '2026-01-01T00:00:00.000Z' } });
    writePrefs(prefsPath(), { '42': { model: 'haiku', lastUpdated: '2026-02-01T00:00:00.000Z' } });

    const store = await loadStore();

    expect(store.getModel(42)).toBe('haiku');
  });

  it("does not touch another bot's file", async () => {
    const sibling = prefsPath('999888777');
    writePrefs(sibling, { '42': { model: 'opus', lastUpdated: '2026-01-01T00:00:00.000Z' } });

    const store = await loadStore();
    store.setModel(42, 'haiku');
    store.setEffort(42, 'low');

    // The regression this split exists for: one bot saving any setting used to
    // rewrite the whole shared file from its own snapshot, wiping the other's.
    expect(readPrefs(sibling)['42'].model).toBe('opus');
  });

  it('starts empty when there is nothing to seed from', async () => {
    const store = await loadStore();

    expect(store.getModel(42)).toBeUndefined();
    // No prefs, no file — an untouched bot shouldn't litter the state dir.
    expect(fs.existsSync(prefsPath())).toBe(false);
  });
});
