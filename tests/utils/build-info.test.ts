/**
 * The stamp `npm run build` leaves in dist/ and what the bot makes of it.
 *
 * Runs the real script against throwaway git checkouts, so the commit, subject
 * and changes it reports are git's own.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { describeBuild, describeRunningBuild, readBuildInfo } from '../../src/utils/build-info.js';

const STAMP_SCRIPT = fileURLToPath(new URL('../../scripts/stamp-build.mjs', import.meta.url));

const dirs: string[] = [];

function git(dir: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
  ).trim();
}

/** A project directory with a package.json and a file under src/, not yet in git. */
function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-stamp-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  return dir;
}

/** The same, with everything committed under `subject`. */
function checkout(subject = 'fix: a thing'): string {
  const dir = project();
  git(dir, 'init', '--quiet');
  git(dir, 'add', '.');
  git(dir, 'commit', '--quiet', '-m', subject);
  return dir;
}

/** Run the script as `npm run build` would and read back what it stamped. */
function stamp(dir: string): ReturnType<typeof readBuildInfo> {
  execFileSync('node', [STAMP_SCRIPT], { cwd: dir, stdio: 'ignore' });
  return readBuildInfo(path.join(dir, 'dist', 'build-info.json'));
}

afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

describe('stamping a build', () => {
  it('names the commit being compiled', () => {
    const dir = checkout();

    const build = stamp(dir);

    expect(build).toMatchObject({ commit: git(dir, 'rev-parse', '--short', 'HEAD'), subject: 'fix: a thing', dirty: false });
    expect(describeBuild(build!)).toBe(`${build!.commit} fix: a thing (built just now)`);
  });

  it('says when src has uncommitted changes in it', () => {
    const dir = checkout();
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 2;\n');

    const build = stamp(dir);

    expect(describeBuild(build!)).toBe(`${build!.commit} fix: a thing, plus uncommitted changes (built just now)`);
  });

  it('counts a new file under src, which tsc compiles too', () => {
    const dir = checkout();
    fs.writeFileSync(path.join(dir, 'src', 'b.ts'), 'export const b = 1;\n');

    expect(stamp(dir)?.dirty).toBe(true);
  });

  it('counts a staged change, not only an unstaged one', () => {
    const dir = checkout();
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 2;\n');
    git(dir, 'add', '.');

    expect(stamp(dir)?.dirty).toBe(true);
  });

  it("doesn't count a change that can't reach the build", () => {
    const dir = checkout();
    fs.writeFileSync(path.join(dir, 'README.md'), 'notes\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '9.9.9', description: 'edited' }));

    expect(stamp(dir)?.dirty).toBe(false);
  });

  it('replaces the previous stamp', () => {
    const dir = checkout('fix: the first');
    stamp(dir);
    git(dir, 'commit', '--quiet', '--allow-empty', '-m', 'fix: the second');

    expect(stamp(dir)?.subject).toBe('fix: the second');
  });

  it('survives a subject JSON and a shell would both trip over', () => {
    const subject = 'fix: "quoted" \\ and `ticks` $(not run)';

    expect(stamp(checkout(subject))?.subject).toBe(subject);
  });

  it('falls back to the package version outside a git checkout', () => {
    const build = stamp(project());

    expect(build?.commit).toBeUndefined();
    expect(describeBuild(build!)).toBe('v9.9.9 (built just now)');
  });

  it('leaves no stamp, and no failure, when it cannot make one', () => {
    const dir = checkout();
    stamp(dir);
    fs.rmSync(path.join(dir, 'package.json'));

    // A throw from execFileSync here is the script failing the build.
    expect(stamp(dir)).toBeNull();
    expect(fs.existsSync(path.join(dir, 'dist', 'build-info.json'))).toBe(false);
  });
});

describe('reading a stamp', () => {
  it('takes a missing or unreadable one as no stamp', () => {
    const dir = project();
    const file = path.join(dir, 'build-info.json');
    expect(readBuildInfo(file)).toBeNull();

    for (const content of ['{ half a fi', 'null', '{"version":"1.0.0"}', '{"version":"1.0.0","builtAt":"never"}']) {
      fs.writeFileSync(file, content);
      expect(readBuildInfo(file)).toBeNull();
    }
  });

  it('says how long ago the build was', () => {
    const builtAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();

    expect(describeBuild({ version: '1.0.0', commit: 'abc1234', subject: 'fix: x', builtAt }))
      .toBe('abc1234 fix: x (built 3h ago)');
  });

  it('claims no build when running from source', () => {
    // Under vitest, as under tsx, the module sits in src/, with no stamp beside it.
    expect(describeRunningBuild()).toBeNull();
  });
});
