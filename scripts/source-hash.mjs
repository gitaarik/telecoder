/**
 * A hash of what `npm run build` compiles, for telling whether the code in a
 * checkout is still the code a running build came from (src/utils/version-check.ts).
 *
 * Contents, not commits, because a commit moves for reasons the build never
 * sees. A docs commit changes no code, committing what a build already compiled
 * only changes its name, and a history rewrite gives unchanged code new hashes.
 * All three would read as falling behind.
 *
 * It lives out here because both ends need the same answer: the build stamps it
 * ahead of tsc, when nothing in dist/ can be relied on, and the bot works it out
 * again when asked.
 */

import { createHash } from 'crypto';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';

const SOURCE_DIR = 'src';
const BUILD_FILES = ['package.json', 'package-lock.json', 'tsconfig.json'];

/** Everything a build reads, as paths from the project root. */
export const SOURCE_PATHS = [SOURCE_DIR, ...BUILD_FILES];

/** What tsc takes from src/. An editor's swap file or a stray note can't reach the build. */
const COMPILED = /\.(ts|tsx|mts|cts|json)$/;

function filesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return entry.isFile() && COMPILED.test(entry.name) ? [path] : [];
  });
}

/**
 * The hash of the source in `root`. Throws when there's no src/ there: an install
 * with no source has nothing to compare, which isn't the same as having changed.
 */
export function hashSource(root) {
  const files = [
    ...filesUnder(join(root, SOURCE_DIR)),
    ...BUILD_FILES.map((file) => join(root, file)).filter((file) => existsSync(file)),
  ].sort();

  const hash = createHash('sha256');
  for (const file of files) {
    const content = readFileSync(file);
    // Path and length first, so moving a file or text across a file boundary
    // can't come out the same.
    hash.update(`${relative(root, file)}\0${content.length}\0`).update(content);
  }
  return hash.digest('hex').slice(0, 16);
}
