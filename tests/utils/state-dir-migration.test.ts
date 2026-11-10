import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// getStateDir() reads os.homedir(), so the suite gets a home of its own that
// each test can lay out as it likes.
let home = '';
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => home }, homedir: () => home };
});

const { migrateLegacyStateDir } = await import('../../src/utils/state-dir-migration.js');
const { getStateDir } = await import('../../src/utils/json-store.js');

const legacy = (): string => path.join(home, '.claudegram');
const current = (): string => path.join(home, '.telecoder');

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-statedir-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('migrateLegacyStateDir', () => {
  it('moves ~/.claudegram to ~/.telecoder with everything in it, and links the old path', () => {
    fs.mkdirSync(legacy(), { mode: 0o700 });
    fs.writeFileSync(path.join(legacy(), 'sessions-42.json'), '{"sessions":{}}');

    expect(migrateLegacyStateDir(home)).toEqual({ outcome: 'moved', linked: true });

    expect(fs.readFileSync(path.join(current(), 'sessions-42.json'), 'utf-8')).toBe('{"sessions":{}}');
    expect(fs.lstatSync(legacy()).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(legacy())).toBe('.telecoder');
    // A process still holding the old path reads and writes the same files.
    expect(fs.readFileSync(path.join(legacy(), 'sessions-42.json'), 'utf-8')).toBe('{"sessions":{}}');
    fs.writeFileSync(path.join(legacy(), 'late-write.json'), '{}');
    expect(fs.existsSync(path.join(current(), 'late-write.json'))).toBe(true);
  });

  it('keeps the directory owner-only', () => {
    fs.mkdirSync(legacy(), { mode: 0o700 });
    migrateLegacyStateDir(home);
    expect(fs.statSync(current()).mode & 0o777).toBe(0o700);
  });

  it('does nothing on a fresh install', () => {
    expect(migrateLegacyStateDir(home)).toEqual({ outcome: 'none' });
    expect(fs.existsSync(current())).toBe(false);
  });

  it('does nothing a second time: the old path is only the link now', () => {
    fs.mkdirSync(legacy());
    migrateLegacyStateDir(home);
    expect(migrateLegacyStateDir(home)).toEqual({ outcome: 'none' });
    expect(fs.lstatSync(legacy()).isSymbolicLink()).toBe(true);
  });

  it('replaces an empty ~/.telecoder, which has nothing to lose', () => {
    fs.mkdirSync(legacy());
    fs.writeFileSync(path.join(legacy(), 'tts-settings-1.json'), '{}');
    fs.mkdirSync(current());

    expect(migrateLegacyStateDir(home)).toEqual({ outcome: 'moved', linked: true });
    expect(fs.existsSync(path.join(current(), 'tts-settings-1.json'))).toBe(true);
  });

  it('touches neither when both hold files', () => {
    fs.mkdirSync(legacy());
    fs.writeFileSync(path.join(legacy(), 'old.json'), '{}');
    fs.mkdirSync(current());
    fs.writeFileSync(path.join(current(), 'new.json'), '{}');

    expect(migrateLegacyStateDir(home)).toEqual({ outcome: 'conflict' });
    expect(fs.existsSync(path.join(legacy(), 'old.json'))).toBe(true);
    expect(fs.existsSync(path.join(current(), 'new.json'))).toBe(true);
    expect(fs.existsSync(path.join(current(), 'old.json'))).toBe(false);
  });
});

describe('getStateDir', () => {
  it('is ~/.telecoder on a fresh install', () => {
    expect(getStateDir()).toBe(current());
  });

  it('stays on an unmoved ~/.claudegram, for workers under a launcher that never moves it', () => {
    fs.mkdirSync(legacy());
    expect(getStateDir()).toBe(legacy());
  });

  it('is ~/.telecoder once moved, not the link left behind', () => {
    fs.mkdirSync(legacy());
    migrateLegacyStateDir(home);
    expect(getStateDir()).toBe(current());
  });

  it('prefers ~/.telecoder when both exist', () => {
    fs.mkdirSync(legacy());
    fs.mkdirSync(current());
    expect(getStateDir()).toBe(current());
  });
});
