/**
 * Recognising a launcher that is running code the build has already replaced.
 *
 * /rebuildbot rebuilds every file and then has the launcher respawn its
 * workers. A respawned worker is a fresh isolate that re-imports dist from
 * disk, so worker-side changes are live the moment it comes back. The launcher
 * is the exception: it is the process the workers are threads in, and the copy
 * of dist/launcher.js it loaded at startup stays in memory until the process
 * manager restarts it. Nothing said so, which is the problem — a rebuild that
 * changed the launcher reported success and changed nothing, quietly, for as
 * long as the process lived.
 *
 * So the launcher fingerprints its own module graph at startup, compares it
 * against the same fingerprint taken after a build, and the rebuild reply says
 * when the two differ.
 */

import { createHash } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import * as path from 'path';

/**
 * Imports of files in this repo, in all three shapes the compiler emits:
 * `from './x.js'`, a side-effect `import './x.js'`, and a dynamic
 * `import('./x.js')`. Package imports are left out — their code can't change
 * without a reinstall, which is its own restart.
 */
const LOCAL_IMPORT = /(?:\bfrom|\bimport)\s*\(?\s*['"](\.[^'"]+)['"]/g;

/** A pm2 app name we're willing to paste into a command we show the user. */
const SAFE_APP_NAME = /^[\w.@-]{1,64}$/;

/**
 * Compiled code imports `./x.js`. So does the TypeScript it was compiled from,
 * and under tsx that specifier has to land on `./x.ts` instead.
 */
function resolveLocal(fromFile: string, specifier: string): string | null {
  const target = path.resolve(path.dirname(fromFile), specifier);
  if (existsSync(target)) return target;
  const asTs = target.replace(/\.js$/, '.ts');
  return existsSync(asTs) ? asTs : null;
}

/**
 * A hash of `entry` and everything it imports from this repo.
 *
 * Contents, not timestamps: tsc rewrites every output on every build, so the
 * mtimes always differ — comparing those would report a changed launcher after
 * every rebuild, including the ones that changed nothing about it.
 *
 * Returns '' when the entry can't be read, which callers should take as "no
 * idea" rather than "changed". A file that disappears mid-graph just stops
 * contributing, which changes the hash on its own.
 */
export function fingerprintModuleGraph(entry: string): string {
  const sources = new Map<string, string>();

  const walk = (file: string): void => {
    if (sources.has(file)) return;
    let source: string;
    try {
      source = readFileSync(file, 'utf-8');
    } catch {
      return;
    }
    sources.set(file, source);
    for (const [, specifier] of source.matchAll(LOCAL_IMPORT)) {
      const target = resolveLocal(file, specifier);
      if (target) walk(target);
    }
  };

  walk(entry);
  if (!sources.has(entry)) return '';

  const root = path.dirname(entry);
  const hash = createHash('sha256');
  for (const file of [...sources.keys()].sort()) {
    hash.update(path.relative(root, file));
    hash.update('\0');
    hash.update(sources.get(file)!);
    hash.update('\0');
  }
  return hash.digest('hex');
}

/**
 * What to tell someone to do about it, phrased to drop into a sentence.
 *
 * pm2 hands every process it manages its app name and id, so under pm2 we can
 * name the exact command. Anywhere else — systemd, a bare
 * `npm run start:multi`, a terminal — all we know is that the process has to
 * go down and come back. The name is checked before it goes into a command we
 * hand the user, since it arrives from the environment.
 */
export function launcherRestartHint(env: NodeJS.ProcessEnv = process.env): string {
  const app = env.pm_id !== undefined ? env.name : undefined;
  if (app && SAFE_APP_NAME.test(app)) return `run "pm2 restart ${app}"`;
  return 'restart the launcher process';
}
