/**
 * Shared persistence for the small JSON state files under `~/.claudegram`.
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

/** Shared directory holding all persisted bot state. */
export function getStateDir(): string {
  return path.join(os.homedir(), '.claudegram');
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
