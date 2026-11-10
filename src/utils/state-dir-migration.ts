/**
 * Move the pre-rename state directory `~/.claudegram` to `~/.telecoder`.
 *
 * TeleCoder was called Claudegram until July 2026, and its state directory kept
 * the old name for a while after. The move is a rename within the home
 * directory, so it is instant and every file comes across as it was. A symlink
 * is left at the old path for anything that still has that path: a process
 * started before the move, or a pty spawned with a script inside the directory
 * (the CCR shim), carries on through the link.
 *
 * Only the launcher and a single-bot `npm start` call this, before any bot is
 * running, so no live bot sees the directory move. Workers never call it: see
 * getStateDir() in json-store.ts for how they cope with an unmoved directory.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LEGACY_STATE_DIR_NAME, STATE_DIR_NAME, isRealDirectory } from './json-store.js';

export type StateDirMigration =
  /** Moved. `linked` says whether the old path now links to the new one. */
  | { outcome: 'moved'; linked: boolean }
  /** Nothing to move: no old directory, or only the link a move left behind. */
  | { outcome: 'none' }
  /** Both exist and the new one has something in it. Neither was touched. */
  | { outcome: 'conflict' }
  /** The move itself failed, so the state is still in the old directory. */
  | { outcome: 'failed'; error: string };

export function migrateLegacyStateDir(home: string = os.homedir()): StateDirMigration {
  const legacy = path.join(home, LEGACY_STATE_DIR_NAME);
  const current = path.join(home, STATE_DIR_NAME);
  if (!isRealDirectory(legacy)) return { outcome: 'none' };

  // Something is already at the new path. An empty directory holds nothing to
  // lose, so it makes way; anything else might be state, so both are left alone.
  if (pathExists(current)) {
    if (!isEmptyDirectory(current)) return { outcome: 'conflict' };
    try {
      fs.rmdirSync(current);
    } catch (err) {
      return { outcome: 'failed', error: describe(err) };
    }
  }

  try {
    fs.renameSync(legacy, current);
  } catch (err) {
    return { outcome: 'failed', error: describe(err) };
  }

  // Relative, so the link still resolves if the home directory is mounted or
  // moved somewhere else.
  try {
    fs.symlinkSync(STATE_DIR_NAME, legacy);
    return { outcome: 'moved', linked: true };
  } catch {
    return { outcome: 'moved', linked: false };
  }
}

/** Run the move and log anything worth knowing about it under `label`. */
export function migrateLegacyStateDirAndLog(label: string, home?: string): StateDirMigration {
  const result = migrateLegacyStateDir(home);
  const from = `~/${LEGACY_STATE_DIR_NAME}`;
  const to = `~/${STATE_DIR_NAME}`;
  switch (result.outcome) {
    case 'moved':
      console.log(`[${label}] Moved ${from} to ${to}${result.linked ? ` (${from} links to it)` : ''}`);
      break;
    case 'conflict':
      console.warn(`[${label}] Both ${from} and ${to} exist — using ${to}. Move anything you still need out of ${from} by hand.`);
      break;
    case 'failed':
      console.error(`[${label}] Could not move ${from} to ${to} (${result.error}) — still using ${from}`);
      break;
    case 'none':
      break;
  }
  return result;
}

function pathExists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function isEmptyDirectory(p: string): boolean {
  try {
    return isRealDirectory(p) && fs.readdirSync(p).length === 0;
  } catch {
    return false;
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
