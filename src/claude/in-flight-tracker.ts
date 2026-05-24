import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { z } from 'zod';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
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

const HISTORY_DIR = path.join(os.homedir(), '.claudegram');

function getFile(): string {
  return path.join(HISTORY_DIR, `in-flight-${BOT_ID}.json`);
}

function ensureDir(): void {
  if (!fs.existsSync(HISTORY_DIR)) {
    fs.mkdirSync(HISTORY_DIR, { recursive: true, mode: 0o700 });
  }
}

function readAll(): InFlightEntry[] {
  try {
    const file = getFile();
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, 'utf-8');
    const result = inFlightFileSchema.safeParse(JSON.parse(raw));
    if (!result.success) return [];
    return result.data.entries;
  } catch {
    return [];
  }
}

function writeAll(entries: InFlightEntry[]): void {
  try {
    ensureDir();
    atomicWriteFileSync(getFile(), JSON.stringify({ entries }, null, 2), { mode: 0o600 });
  } catch (err) {
    console.error('[InFlight] Failed to write:', err);
  }
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
