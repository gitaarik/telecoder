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

describe('userPreferences status line defaults', () => {
  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-prefs-'));
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('shows the status line and its topic until a chat turns them off', async () => {
    const store = await loadStore();
    expect(store.getShowStatusLine(42)).toBe(true);
    expect(store.getShowTopicInStatusLine(42)).toBe(true);
    store.setShowStatusLine(42, false);
    store.setShowTopicInStatusLine(42, false);
    expect(store.getShowStatusLine(42)).toBe(false);
    expect(store.getShowTopicInStatusLine(42)).toBe(false);
    // A chat that switched it off before the default changed stays off.
    expect(readPrefs(prefsPath())['42']).toMatchObject({ showStatusLine: false, showTopicInStatusLine: false });
  });

  it('keeps the prompts and the resume command off until a chat turns them on', async () => {
    const store = await loadStore();
    expect(store.getShowPromptInStatusLine(42)).toBe(false);
    expect(store.getShowSessionInStatusLine(42)).toBe(false);
    store.setShowPromptInStatusLine(42, true);
    store.setShowSessionInStatusLine(42, true);
    expect(store.getShowPromptInStatusLine(42)).toBe(true);
    expect(store.getShowSessionInStatusLine(42)).toBe(true);
  });
});

describe('userPreferences per thread', () => {
  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-prefs-'));
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('keeps a thread its own setting, apart from its siblings and the chat', async () => {
    const store = await loadStore();
    store.setModel('42:7', 'haiku');

    expect(store.getModel('42:7')).toBe('haiku');
    expect(store.getModel('42:8')).toBeUndefined();
    expect(store.getModel(42)).toBeUndefined();
    // Survives a restart under its own key.
    expect(readPrefs(prefsPath())['42:7'].model).toBe('haiku');
  });

  it('falls back to the chat for whatever the thread never set', async () => {
    const store = await loadStore();
    store.setModel(42, 'opus');
    store.setMethod(42, 'pty');
    store.setEffort('42:7', 'low');

    expect(store.getModel('42:7')).toBe('opus');
    expect(store.getMethod('42:7')).toBe('pty');
    expect(store.getEffort('42:7')).toBe('low');
    expect(store.getEffort(42)).toBeUndefined();
  });

  it("resets a thread to the default, not to the chat's choice", async () => {
    const store = await loadStore();
    store.setModel(42, 'opus');
    store.setModel('42:7', 'haiku');
    store.clearModel('42:7');

    expect(store.getModel('42:7')).toBeUndefined();
    expect(store.getModel(42)).toBe('opus');

    // And that reset survives a reload rather than reverting to the chat's.
    const reloaded = await loadStore();
    expect(reloaded.getModel('42:7')).toBeUndefined();
  });

  it('reads a plain chat session key as the chat-wide entry', async () => {
    const store = await loadStore();
    store.setModel('42', 'sonnet');

    expect(store.getModel(42)).toBe('sonnet');
    store.clearModel('42');
    expect(readPrefs(prefsPath())['42']).not.toHaveProperty('model');
  });

  it('loads files written before threads had settings of their own', async () => {
    writePrefs(prefsPath(), { '42': { model: 'opus', lastUpdated: '2026-01-01T00:00:00.000Z' } });

    const store = await loadStore();

    expect(store.getModel(42)).toBe('opus');
    expect(store.getModel('42:7')).toBe('opus');
  });

  it("starts a forked thread with the settings its source thread chose", async () => {
    const store = await loadStore();
    store.setModel(42, 'opus');
    store.setModel('42:7', 'haiku');
    store.setMethod('42:7', 'pty');

    store.copyScope('42:7', '42:9');

    expect(store.getModel('42:9')).toBe('haiku');
    expect(store.getMethod('42:9')).toBe('pty');
    // The copy is the new thread's own: changing the source leaves it be.
    store.setModel('42:7', 'sonnet');
    expect(store.getModel('42:9')).toBe('haiku');
  });

  it('copies nothing from a chat-wide scope, which the thread falls back to anyway', async () => {
    const store = await loadStore();
    store.setModel(42, 'opus');

    store.copyScope(42, '42:9');

    expect(readPrefs(prefsPath())['42:9']).toBeUndefined();
    expect(store.getModel('42:9')).toBe('opus');
  });
});
