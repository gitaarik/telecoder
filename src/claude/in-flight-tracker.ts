import * as path from 'path';
import { z } from 'zod';
import { ensureStateDir, getStateDir, readJsonFile, writeJsonFile } from '../utils/json-store.js';
import { BOT_ID } from '../config.js';

/**
 * Tracks Claude tasks that are currently running per-session, persisted to disk.
 * On a clean finish the marker is cleared. If the bot exits unexpectedly while
 * a task is in flight, the marker survives and startup can notify the chat
 * that the task was interrupted.
 */

const inFlightEntrySchema = z.object({
  sessionKey: z.string(),
  messagePreview: z.string(),
  startedAt: z.string(),
});

const inFlightFileSchema = z.object({
  entries: z.array(inFlightEntrySchema),
});

export type InFlightEntry = z.infer<typeof inFlightEntrySchema>;

const HISTORY_DIR = getStateDir();

function getFile(): string {
  return path.join(HISTORY_DIR, `in-flight-${BOT_ID}.json`);
}

function readAll(): InFlightEntry[] {
  return readJsonFile(getFile(), inFlightFileSchema, 'InFlight')?.entries ?? [];
}

function writeAll(entries: InFlightEntry[]): void {
  ensureStateDir(HISTORY_DIR, 'InFlight');
  writeJsonFile(getFile(), { entries }, 'InFlight');
}

// Cap stored prompt at 50KB so a long interrupted prompt survives the restart
// notification flow intact. The restore renderer chunks if it exceeds the
// 4096-char per-Telegram-message limit.
const MAX_PROMPT_CHARS = 50_000;

export function markInFlight(sessionKey: string, messagePreview: string): void {
  const others = readAll().filter((e) => e.sessionKey !== sessionKey);
  others.push({
    sessionKey,
    messagePreview: messagePreview.slice(0, MAX_PROMPT_CHARS),
    startedAt: new Date().toISOString(),
  });
  writeAll(others);
}

/** Whether a turn is running for this session right now. */
export function isInFlight(sessionKey: string): boolean {
  return readAll().some((e) => e.sessionKey === sessionKey);
}

export function clearInFlight(sessionKey: string): void {
  const all = readAll();
  const filtered = all.filter((e) => e.sessionKey !== sessionKey);
  if (filtered.length !== all.length) writeAll(filtered);
}

/** Read all entries and clear the file. Used at startup to surface tasks that
 * were interrupted by an unexpected exit. */
export function consumeAllInFlight(): InFlightEntry[] {
  const all = readAll();
  if (all.length > 0) writeAll([]);
  return all;
}
