/**
 * Shared persistence for the small JSON state files under `~/.telecoder`.
 *
 * Every persisted store in the bot (settings, preferences, favorites, name
 * cooldowns) used to hand-roll the same four steps: create the state dir,
 * read + zod-validate the file, log and fall back to empty on trouble, and
 * write it back out. The copies drifted — some wrote atomically, some didn't;
 * one checked the directory permissions, the rest assumed them. These helpers
 * are the single implementation, so a fix here reaches every store.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ZodType } from 'zod';
import { atomicWriteFileSync } from './atomic-write.js';

/** Owner-only, matching the permissions the state dir has always been created with. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Basename of the state directory, under the home directory. */
export const STATE_DIR_NAME = '.telecoder';

/** Its name before TeleCoder was renamed from Claudegram. */
export const LEGACY_STATE_DIR_NAME = '.claudegram';

/**
 * Shared directory holding all persisted bot state: `~/.telecoder`.
 *
 * Until the launcher has moved the pre-rename `~/.claudegram` across (see
 * utils/state-dir-migration.ts), that one is still where the state is, so it is
 * answered instead. That is the case for workers rebuilt under a launcher that
 * started on an older build: it keeps running its old code, which never moves
 * anything, and its new workers must go on reading the state it still writes.
 * Workers never move the directory themselves, so several of them can't race
 * each other doing it.
 */
export function getStateDir(): string {
  const home = os.homedir();
  const current = path.join(home, STATE_DIR_NAME);
  if (fs.existsSync(current)) return current;
  const legacy = path.join(home, LEGACY_STATE_DIR_NAME);
  return isRealDirectory(legacy) ? legacy : current;
}

/** A directory that is not a symlink — a moved state dir leaves a link behind. */
export function isRealDirectory(p: string): boolean {
  try {
    const stats = fs.lstatSync(p);
    return stats.isDirectory() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Create the state directory if it is missing, and tighten its permissions if
 * an existing one is more permissive than owner-only.
 *
 * A failure to *create* the directory propagates — nothing can be persisted
 * without it, so surfacing that at startup beats a silent read-only bot. A
 * failure to *inspect* an existing one is only logged.
 */
export function ensureStateDir(dir: string, label: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    return;
  }

  try {
    const stats = fs.statSync(dir);
    if (!stats.isDirectory()) {
      throw new Error(`${dir} exists but is not a directory`);
    }
    if (process.platform !== 'win32' && (stats.mode & 0o777) !== DIR_MODE) {
      fs.chmodSync(dir, DIR_MODE);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[${label}] State directory check failed:`, error);
    }
  }
}

/**
 * Read and validate a JSON state file.
 *
 * Returns undefined when the file is missing, unreadable, malformed, or fails
 * validation — in every one of those cases the caller starts from empty state
 * rather than crashing, which is what all the hand-rolled copies did too.
 */
export function readJsonFile<T>(filePath: string, schema: ZodType<T>, label: string): T | undefined {
  if (!fs.existsSync(filePath)) return undefined;

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const result = schema.safeParse(parsed);
    if (!result.success) {
      console.warn(`[${label}] Invalid ${path.basename(filePath)} format, starting fresh:`, result.error.message);
      return undefined;
    }
    return result.data;
  } catch (error) {
    console.error(`[${label}] Failed to load ${path.basename(filePath)}:`, error);
    return undefined;
  }
}

/**
 * Write a JSON state file atomically, owner-readable only.
 *
 * Failures are logged and swallowed by default: losing a settings toggle
 * should never take down a turn. Pass `rethrow` when the caller reports
 * success to the user right after writing — there, a silent failure would
 * claim the write happened when it didn't.
 */
export function writeJsonFile(
  filePath: string,
  data: unknown,
  label: string,
  opts?: { rethrow?: boolean },
): void {
  try {
    atomicWriteFileSync(filePath, JSON.stringify(data, null, 2), { mode: FILE_MODE });
  } catch (error) {
    if (opts?.rethrow) throw error;
    console.error(`[${label}] Failed to save ${path.basename(filePath)}:`, error);
  }
}

/**
 * Read a bot's own state file, for state all the bots used to share in one file.
 *
 * A bot's first start finds no file of its own, so it inherits whatever the
 * shared file holds and nothing resets. It claims its own file straight away, so
 * the shared one is no longer needed. That one is read, never removed: sibling
 * bots still on their first start need to seed from it too, and a downgrade
 * should still find it.
 */
export function readSeededJsonFile<T>(
  filePath: string,
  sharedPath: string,
  schema: ZodType<T>,
  label: string,
): T | undefined {
  if (fs.existsSync(filePath)) return readJsonFile(filePath, schema, label);

  const seed = readJsonFile(sharedPath, schema, label);
  if (seed) {
    console.log(`[${label}] Seeded ${path.basename(filePath)} from ${path.basename(sharedPath)}`);
    writeJsonFile(filePath, seed, label);
  }
  return seed;
}
