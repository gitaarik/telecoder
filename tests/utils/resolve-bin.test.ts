import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The behaviour the pty provider leans on: find the CLI when PATH does not.
 *
 * A systemd user unit runs with the bare default PATH — no ~/.local/bin, which
 * is where the native installer puts `claude`. Passing a bare name to node-pty
 * there fails as execvp("No such file or directory"), which surfaces as a
 * session that produced nothing and a bot reporting that the input box never
 * appeared. @code_share1_bot ran that way from the day it moved to systemd.
 */
const savedEnv = { ...process.env };

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: actual, homedir: () => process.env.TELECODER_TEST_HOME ?? actual.homedir() };
});

// The module freezes its search dirs at import, so the fake home has to exist
// and be pointed at before the import — not in a beforeEach.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-bin-'));
const binDir = path.join(home, '.local', 'bin');
fs.mkdirSync(binDir, { recursive: true });
process.env.TELECODER_TEST_HOME = home;

const { resolveBin } = await import('../../src/utils/resolve-bin.js');

afterEach(() => {
  process.env = { ...savedEnv, TELECODER_TEST_HOME: home };
});

afterAll(() => {
  delete process.env.TELECODER_TEST_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('resolveBin', () => {
  it('finds a binary in ~/.local/bin when PATH does not contain it', () => {
    const name = `telecoder-probe-${process.pid}`;
    const target = path.join(binDir, name);
    fs.writeFileSync(target, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    // The PATH a systemd user unit actually gets.
    process.env.PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

    expect(resolveBin(name)).toBe(target);
  });

  it('leaves a name it cannot place alone, rather than inventing a path', () => {
    const missing = `telecoder-absent-${process.pid}`;
    process.env.PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
    expect(resolveBin(missing)).toBe(missing);
  });

  it('ignores a match that is not executable', () => {
    const name = `telecoder-noexec-${process.pid}`;
    fs.writeFileSync(path.join(binDir, name), 'not executable', { mode: 0o644 });
    process.env.PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
    expect(resolveBin(name)).toBe(name);
  });

  it('refuses a name carrying path separators', () => {
    expect(() => resolveBin('../../etc/passwd')).toThrow(/path separators/);
  });
});
