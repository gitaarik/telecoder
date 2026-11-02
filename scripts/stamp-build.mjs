/**
 * Writes dist/build-info.json: which commit `npm run build` is compiling, for
 * the bot to name once it is running the result (src/utils/build-info.ts), and a
 * hash of its source, for /version to compare with the code (source-hash.mjs).
 *
 * Runs ahead of tsc, because tsc emits despite type errors: a build that fails
 * still replaces dist/, and the next restart runs what it left there. Stamped
 * afterwards, that code would go by the name of the last build that passed.
 *
 * Whatever goes wrong here mustn't stop a build, only the naming of it. The old
 * stamp goes first for the same reason: no stamp says nothing, and a stale one
 * would say something untrue.
 */

import { execFileSync } from 'child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { hashSource } from './source-hash.mjs';

const STAMP = 'dist/build-info.json';

/** What git answers, or null with no git or no repo to ask. */
function git(...args) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

try {
  rmSync(STAMP, { force: true });

  const [commit, subject] = git('log', '-1', '--format=%h%n%s')?.split('\n') ?? [];
  // Only src/: an edited doc or a stray file in the checkout doesn't make this
  // build anything other than the commit.
  const changes = git('--no-optional-locks', 'status', '--porcelain', '--', 'src');

  mkdirSync('dist', { recursive: true });
  writeFileSync(STAMP, JSON.stringify({
    version: JSON.parse(readFileSync('package.json', 'utf-8')).version,
    commit,
    subject,
    dirty: Boolean(changes),
    sourceHash: hashSource('.'),
    builtAt: new Date().toISOString(),
  }, null, 2) + '\n');
} catch (err) {
  console.warn(`stamp-build: leaving this build unstamped: ${err instanceof Error ? err.message : err}`);
}
