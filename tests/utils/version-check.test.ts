/**
 * What /version makes of a build, the code beside it and the branch it tracks.
 *
 * Runs the real stamp script and real git against throwaway checkouts, with a
 * bare repository on disk standing in for the remote.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { readBuildInfo, type BuildInfo } from '../../src/utils/build-info.js';
import {
  checkCode,
  checkRemote,
  describeCodeCheck,
  describeRemoteCheck,
} from '../../src/utils/version-check.js';
// @ts-expect-error A plain script: the build runs it ahead of tsc, so it has no types.
import { hashSource } from '../../scripts/source-hash.mjs';

const STAMP_SCRIPT = fileURLToPath(new URL('../../scripts/stamp-build.mjs', import.meta.url));

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-version-'));
  dirs.push(dir);
  return dir;
}

function git(dir: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
  ).trim();
}

const write = (dir: string, file: string, content: string): void => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
};

function commit(dir: string, subject: string, files: Record<string, string> = {}): void {
  for (const [file, content] of Object.entries(files)) write(dir, file, content);
  git(dir, 'add', '.');
  git(dir, 'commit', '--quiet', '--allow-empty', '-m', subject);
}

/** A project with its first commit made. */
function checkout(): string {
  const dir = tempDir();
  git(dir, 'init', '--quiet', '--initial-branch=main');
  write(dir, '.gitignore', 'dist/\n');
  write(dir, 'package.json', JSON.stringify({ version: '9.9.9' }));
  commit(dir, 'feat: the start', { 'src/a.ts': 'export const a = 1;\n' });
  return dir;
}

/** Run the script as `npm run build` would and read back what it stamped. */
function build(dir: string): BuildInfo {
  execFileSync('node', [STAMP_SCRIPT], { cwd: dir, stdio: 'ignore' });
  return readBuildInfo(path.join(dir, 'dist', 'build-info.json'))!;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

describe('hashing the source', () => {
  const baseline = (): { dir: string; hash: string } => {
    const dir = checkout();
    write(dir, 'tsconfig.json', '{}');
    write(dir, 'package-lock.json', '{}');
    return { dir, hash: hashSource(dir) };
  };

  it('gives the same answer for the same code', () => {
    const { dir, hash } = baseline();

    expect(hashSource(dir)).toBe(hash);
    expect(hashSource(path.relative(process.cwd(), dir))).toBe(hash);
  });

  it.each([
    ['a changed file', 'src/a.ts', 'export const a = 2;\n'],
    ['a new file', 'src/deep/er/b.ts', 'export const b = 1;\n'],
    ['package.json', 'package.json', '{"version":"9.9.10"}'],
    ['the lockfile', 'package-lock.json', '{"lockfileVersion":3}'],
    ['tsconfig.json', 'tsconfig.json', '{"compilerOptions":{}}'],
  ])('notices %s', (_what, file, content) => {
    const { dir, hash } = baseline();

    write(dir, file, content);

    expect(hashSource(dir)).not.toBe(hash);
  });

  it('notices a deleted file and a moved one', () => {
    const { dir, hash } = baseline();
    write(dir, 'src/b.ts', 'export const b = 1;\n');
    const withB = hashSource(dir);

    fs.renameSync(path.join(dir, 'src/b.ts'), path.join(dir, 'src/c.ts'));
    expect(hashSource(dir)).not.toBe(withB);

    fs.rmSync(path.join(dir, 'src/c.ts'));
    expect(hashSource(dir)).toBe(hash);
  });

  it('notices text moving from one file into the next', () => {
    const dir = checkout();
    write(dir, 'src/a.ts', 'one');
    write(dir, 'src/b.ts', 'two');
    const before = hashSource(dir);

    write(dir, 'src/a.ts', 'on');
    write(dir, 'src/b.ts', 'etwo');

    expect(hashSource(dir)).not.toBe(before);
  });

  it("ignores what a build doesn't read", () => {
    const { dir, hash } = baseline();

    write(dir, 'README.md', 'notes\n');
    write(dir, 'docs/index.html', '<html></html>');
    write(dir, 'src/.a.ts.swp', 'swap');
    write(dir, 'src/notes.md', 'notes\n');
    write(dir, 'dist/a.js', 'compiled');

    expect(hashSource(dir)).toBe(hash);
  });

  it('throws where there is no source, rather than hashing nothing', () => {
    expect(() => hashSource(tempDir())).toThrow();
  });
});

describe('comparing a build with the code', () => {
  it('stamps the hash of what it compiled', () => {
    const dir = checkout();

    expect(build(dir).sourceHash).toBe(hashSource(dir));
  });

  it('calls a build of this code current', async () => {
    const dir = checkout();
    const running = build(dir);

    expect(await checkCode(running, running, dir)).toEqual({ kind: 'current' });
  });

  it('stays current through a commit that touches nothing the build reads', async () => {
    const dir = checkout();
    const running = build(dir);

    commit(dir, 'docs: a note', { 'README.md': 'notes\n' });

    expect(await checkCode(running, running, dir)).toEqual({ kind: 'current' });
  });

  it('stays current when what a build compiled gets committed', async () => {
    const dir = checkout();
    write(dir, 'src/a.ts', 'export const a = 2;\n');
    const running = build(dir);
    expect(running.dirty).toBe(true);

    commit(dir, 'fix: what was already built');

    expect(await checkCode(running, running, dir)).toEqual({ kind: 'current' });
  });

  it('stays current through a history rewrite that left the code alone', async () => {
    const dir = checkout();
    const running = build(dir);

    git(dir, 'commit', '--quiet', '--amend', '-m', 'feat: the start, reworded');

    expect(git(dir, 'rev-parse', '--short', 'HEAD')).not.toBe(running.commit);
    expect(await checkCode(running, running, dir)).toEqual({ kind: 'current' });
  });

  it('counts the newer commits, leaving out the ones that touch no code', async () => {
    const dir = checkout();
    const running = build(dir);

    commit(dir, 'fix: one', { 'src/a.ts': 'export const a = 2;\n' });
    commit(dir, 'docs: a note', { 'README.md': 'notes\n' });
    commit(dir, 'fix: two', { 'src/a.ts': 'export const a = 3;\n' });

    expect(await checkCode(running, running, dir)).toEqual({ kind: 'changed', commits: 2, uncommitted: false });
  });

  it('counts a commit that only moves a dependency', async () => {
    const dir = checkout();
    const running = build(dir);

    commit(dir, 'chore: bump', { 'package-lock.json': '{"lockfileVersion":3}' });

    expect(await checkCode(running, running, dir)).toEqual({ kind: 'changed', commits: 1, uncommitted: false });
  });

  it('says when the difference is uncommitted', async () => {
    const dir = checkout();
    const running = build(dir);

    write(dir, 'src/a.ts', 'export const a = 2;\n');

    expect(await checkCode(running, running, dir)).toEqual({ kind: 'changed', commits: 0, uncommitted: true });
  });

  it('gives both when there are both', async () => {
    const dir = checkout();
    const running = build(dir);

    commit(dir, 'fix: one', { 'src/a.ts': 'export const a = 2;\n' });
    write(dir, 'src/b.ts', 'export const b = 1;\n');

    expect(await checkCode(running, running, dir)).toEqual({ kind: 'changed', commits: 1, uncommitted: true });
  });

  it("won't count commits when the build's commit has left the branch", async () => {
    const dir = checkout();
    commit(dir, 'feat: more', { 'src/b.ts': 'export const b = 1;\n' });
    const running = build(dir);

    // Rewritten, so that everything since the rewrite point would count as new.
    git(dir, 'commit', '--quiet', '--amend', '-m', 'feat: more, reworded');
    commit(dir, 'fix: real', { 'src/b.ts': 'export const b = 2;\n' });

    expect(await checkCode(running, running, dir)).toEqual({ kind: 'changed', commits: null, uncommitted: false });
  });

  it("won't count commits from a commit git doesn't have", async () => {
    const dir = checkout();
    const running = { ...build(dir), commit: 'abc1234' };

    write(dir, 'src/a.ts', 'export const a = 2;\n');

    expect(await checkCode(running, running, dir)).toEqual({ kind: 'changed', commits: null, uncommitted: true });
  });

  it("won't count commits past a build that had uncommitted changes", async () => {
    const dir = checkout();
    write(dir, 'src/a.ts', 'export const a = 2;\n');
    const running = build(dir);

    commit(dir, 'fix: partly built', { 'src/b.ts': 'export const b = 1;\n' });

    expect(await checkCode(running, running, dir)).toEqual({ kind: 'changed', commits: null, uncommitted: false });
  });

  it('sees a newer build of this code that this process has not loaded', async () => {
    const dir = checkout();
    const running = build(dir);

    write(dir, 'src/a.ts', 'export const a = 2;\n');
    const latest = build(dir);

    expect(await checkCode(running, latest, dir)).toEqual({ kind: 'not-loaded' });
  });

  it('wants a rebuild, not a restart, when the code has moved past the latest build too', async () => {
    const dir = checkout();
    const running = build(dir);

    write(dir, 'src/a.ts', 'export const a = 2;\n');
    const latest = build(dir);
    write(dir, 'src/a.ts', 'export const a = 3;\n');

    expect(await checkCode(running, latest, dir)).toMatchObject({ kind: 'changed', uncommitted: true });
  });

  it('still compares with no git to ask', async () => {
    const dir = tempDir();
    write(dir, 'package.json', JSON.stringify({ version: '9.9.9' }));
    write(dir, 'src/a.ts', 'export const a = 1;\n');
    const running = build(dir);
    expect(await checkCode(running, running, dir)).toEqual({ kind: 'current' });

    write(dir, 'src/a.ts', 'export const a = 2;\n');

    expect(await checkCode(running, running, dir)).toEqual({ kind: 'changed', commits: null, uncommitted: false });
  });

  it('has nothing to compare without a stamp', async () => {
    expect(await checkCode(null, null, checkout())).toEqual({ kind: 'unstamped' });
  });

  it("doesn't call a stamp with no hash current", async () => {
    const dir = checkout();
    const { sourceHash: _sourceHash, ...running } = build(dir);

    expect(await checkCode(running, running, dir)).toEqual({ kind: 'unknown' });
  });

  it("doesn't call a build current with no source beside it", async () => {
    const dir = checkout();
    const running = build(dir);

    fs.rmSync(path.join(dir, 'src'), { recursive: true });

    expect(await checkCode(running, running, dir)).toEqual({ kind: 'unknown' });
  });
});

describe('comparing the checkout with the branch it tracks', () => {
  /** A checkout pushed to a bare repository it tracks, and a second clone to move that on from. */
  function tracked(): { dir: string; remote: string; other: string } {
    const dir = checkout();
    const remote = tempDir();
    git(remote, 'init', '--quiet', '--bare', '--initial-branch=main');
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '--quiet', '--set-upstream', 'origin', 'main');
    const other = tempDir();
    git(other, 'clone', '--quiet', remote, '.');
    return { dir, remote, other };
  }

  function pushFromOther(other: string, subject: string): void {
    commit(other, subject, { [`src/${subject.replace(/\W/g, '')}.ts`]: `// ${subject}\n` });
    git(other, 'push', '--quiet');
  }

  it('finds nothing newer when they match', async () => {
    const { dir } = tracked();

    expect(await checkRemote(dir)).toEqual({ kind: 'same', ref: 'origin/main' });
  });

  it('sees commits not pushed yet, which are not out of date', async () => {
    const { dir } = tracked();

    commit(dir, 'feat: one');
    commit(dir, 'feat: two');

    expect(await checkRemote(dir)).toEqual({ kind: 'ahead', ref: 'origin/main', commits: 2 });
  });

  it('sees commits this checkout has never fetched', async () => {
    const { dir, other } = tracked();

    pushFromOther(other, 'feat: elsewhere');

    expect(await checkRemote(dir)).toEqual({ kind: 'behind', ref: 'origin/main' });
  });

  it('sees commits this checkout has fetched but not merged', async () => {
    const { dir, other } = tracked();

    pushFromOther(other, 'feat: elsewhere');
    git(dir, 'fetch', '--quiet');

    expect(await checkRemote(dir)).toEqual({ kind: 'behind', ref: 'origin/main' });
  });

  it('sees a split once both sides are known', async () => {
    const { dir, other } = tracked();

    pushFromOther(other, 'feat: elsewhere');
    git(dir, 'fetch', '--quiet');
    commit(dir, 'feat: here');

    expect(await checkRemote(dir)).toEqual({ kind: 'diverged', ref: 'origin/main' });
  });

  it("doesn't write to the checkout", async () => {
    const { dir, other } = tracked();
    pushFromOther(other, 'feat: elsewhere');
    const refs = git(dir, 'for-each-ref');

    await checkRemote(dir);

    expect(git(dir, 'for-each-ref')).toBe(refs);
    expect(fs.existsSync(path.join(dir, '.git', 'FETCH_HEAD'))).toBe(false);
  });

  it('follows the tracked remote, not one that happens to be called something else', async () => {
    const { dir } = tracked();
    const unrelated = tempDir();
    git(unrelated, 'init', '--quiet', '--bare', '--initial-branch=main');
    git(dir, 'remote', 'add', 'upstream', unrelated);

    expect(await checkRemote(dir)).toEqual({ kind: 'same', ref: 'origin/main' });
  });

  it('says when the remote is out of reach', async () => {
    const { dir } = tracked();

    git(dir, 'remote', 'set-url', 'origin', path.join(tempDir(), 'gone'));

    expect(await checkRemote(dir)).toEqual({ kind: 'unreachable', remote: 'origin', ref: 'origin/main' });
  });

  it('gives up on a remote that never answers, without waiting on what it left behind', async () => {
    const { dir } = tracked();
    const hang = path.join(tempDir(), 'hang.sh');
    fs.writeFileSync(hang, '#!/bin/sh\nsleep 5\n', { mode: 0o755 });
    git(dir, 'config', 'core.sshCommand', hang);
    git(dir, 'remote', 'set-url', 'origin', 'ssh://git@example.invalid/x.git');

    const started = Date.now();
    const check = await checkRemote(dir, 300);

    expect(check).toEqual({ kind: 'unreachable', remote: 'origin', ref: 'origin/main' });
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('has nothing to say with no upstream, on a detached HEAD, or outside git', async () => {
    const { dir } = tracked();
    git(dir, 'checkout', '--quiet', '--detach');
    expect(await checkRemote(dir)).toEqual({ kind: 'untracked' });

    expect(await checkRemote(checkout())).toEqual({ kind: 'untracked' });
    expect(await checkRemote(tempDir())).toEqual({ kind: 'untracked' });
  });

  it('has nothing to say when the branch is gone from the remote', async () => {
    const { dir, remote } = tracked();

    git(remote, 'update-ref', '-d', 'refs/heads/main');

    expect(await checkRemote(dir)).toEqual({ kind: 'untracked' });
  });

  it("keeps git's error, which can hold a remote's URL, out of the log", async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const { dir } = tracked();
    const secret = path.join(tempDir(), 'secret-token');
    git(dir, 'remote', 'set-url', 'origin', secret);

    await checkRemote(dir);

    expect(debug).toHaveBeenCalled();
    expect(JSON.stringify(debug.mock.calls)).not.toContain('secret-token');
  });
});

describe('putting the result in words', () => {
  it('points at the command that fixes each state', () => {
    expect(describeCodeCheck({ kind: 'current' })).toBe('✅ This is the current code.');
    expect(describeCodeCheck({ kind: 'not-loaded' })).toContain('/restartbot');
    expect(describeCodeCheck({ kind: 'changed', commits: 5, uncommitted: false })).toBe(
      '⚠️ The code here has 5 newer commits. /rebuildbot picks them up.',
    );
    expect(describeRemoteCheck({ kind: 'behind', ref: 'origin/main' })).toBe(
      "⚠️ origin/main has commits this checkout doesn't. git pull, then /rebuildbot.",
    );
  });

  it('gets the grammar right for one of each', () => {
    expect(describeCodeCheck({ kind: 'changed', commits: 1, uncommitted: false })).toBe(
      '⚠️ The code here has 1 newer commit. /rebuildbot picks it up.',
    );
    expect(describeCodeCheck({ kind: 'changed', commits: 1, uncommitted: true })).toBe(
      '⚠️ The code here has 1 newer commit and uncommitted changes. /rebuildbot picks them up.',
    );
    expect(describeRemoteCheck({ kind: 'ahead', ref: 'origin/main', commits: 1 })).toBe(
      '⬆️ This checkout is 1 commit ahead of origin/main.',
    );
  });

  it.each([
    [{ kind: 'changed', commits: 0, uncommitted: true }, '⚠️ The code here has uncommitted changes. /rebuildbot picks them up.'],
    [{ kind: 'changed', commits: 0, uncommitted: false }, '⚠️ The code here has changed since this build. /rebuildbot picks it up.'],
    [{ kind: 'changed', commits: null, uncommitted: false }, '⚠️ The code here has changed since this build. /rebuildbot picks it up.'],
  ] as const)('never counts what it could not: %j', (check, words) => {
    expect(describeCodeCheck(check)).toBe(words);
  });

  it('only gives a tick to a comparison that ran and passed', () => {
    const unchecked = [
      describeCodeCheck({ kind: 'unstamped' }),
      describeCodeCheck({ kind: 'unknown' }),
      describeRemoteCheck({ kind: 'unreachable', remote: 'origin', ref: 'origin/main' }),
    ];

    for (const words of unchecked) {
      expect(words).toMatch(/^❓/);
      expect(words).not.toContain('✅');
    }
  });

  it('says nothing about a remote when the branch tracks none', () => {
    expect(describeRemoteCheck({ kind: 'untracked' })).toBeNull();
  });
});
