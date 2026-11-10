/**
 * TeleCoder's own folder inside a project: `<project>/.telecoder/`, holding
 * what the bot writes there for Claude to read — files sent in the chat
 * (`uploads/`) and conversation handoffs (`handoffs/`).
 *
 * The folder ignores itself: the first time it is made, it gets a `.gitignore`
 * of `*`. A project's own `.gitignore` can't be relied on to cover it — one
 * that ignores the pre-rename `.claudegram/` doesn't ignore `.telecoder/` — and
 * without this the photos someone sent would be one `git add -A` away from a
 * commit. Nothing in the project has to change for it.
 */

import * as fs from 'fs';
import * as path from 'path';

/** The folder's name inside a project. */
export const PROJECT_DATA_DIR = '.telecoder';

const SELF_IGNORE = '# Written by TeleCoder: nothing in this folder belongs in git.\n*\n';

/** Create `<projectDir>/.telecoder/<sub>` if needed, and return its path. */
export function ensureProjectDataDir(projectDir: string, sub: string): string {
  const root = path.join(projectDir, PROJECT_DATA_DIR);
  const dir = path.join(root, sub);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    // 'wx' leaves a .gitignore someone has edited alone.
    fs.writeFileSync(path.join(root, '.gitignore'), SELF_IGNORE, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      console.warn(`[ProjectData] Couldn't write ${path.join(root, '.gitignore')}: ${(err as Error).message}`);
    }
  }
  return dir;
}
