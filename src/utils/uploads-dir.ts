/**
 * Where files sent in a chat are saved for Claude to read:
 * `~/.telecoder/uploads/<project name>/`.
 *
 * They used to go to `<project>/.telecoder/uploads/`, which left a folder in
 * every project someone had sent a photo to, and needed a `.gitignore` of its
 * own so the photos stayed out of commits. The bot's state directory has
 * neither problem. Claude still gets the absolute path in the prompt, so where
 * the file lives makes no difference to it — except that the scope guard
 * treats the rest of `~/.telecoder` as bot state and prompts on every read;
 * `uploads/` is the one subfolder it exempts, since what's in it is the user's
 * own files (see claude/scope-guard.ts).
 */

import * as fs from 'fs';
import * as path from 'path';
import { getStateDir } from './json-store.js';

/** The folder every upload lives under. */
export function getUploadsRoot(): string {
  return path.join(getStateDir(), 'uploads');
}

/** Create the uploads folder for a project if needed, and return its path. */
export function ensureUploadsDir(projectDir: string): string {
  const dir = path.join(getUploadsRoot(), path.basename(projectDir));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
