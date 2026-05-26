/**
 * Pending-fork storage. When a user forks a conversation from Bot A to Bot B,
 * Bot A writes the truncated transcript here keyed by Bot B's id. Bot B picks
 * it up on the next user message and offers accept/decline.
 *
 * File: ~/.claudegram/pending-forks-<targetBotId>.json
 * Structure: { users: { [userId]: PendingFork } } — keyed by the Telegram
 * user id, not the chatId, because each bot has its own private DM with the
 * user (different chatId per bot). Routing by user id lets a fork from a
 * DM with Bot A land in the DM with Bot B without either side knowing the
 * other's chatId. The target bot's chat resolves when the user actually
 * messages it — wherever they message from, that's where the offer shows up.
 *
 * Cross-bot handoff is via the shared `~/.claudegram/` dir on disk — every
 * worker on this machine can read/write any bot's file. The target worker
 * doesn't get a live notification; it polls on each incoming user message.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { z } from 'zod';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

const HISTORY_DIR = path.join(os.homedir(), '.claudegram');

const pendingForkSchema = z.object({
  fromBotName: z.string(),
  fromBotId: z.string(),
  /** Source chat the fork was created in — informational, not used for routing. */
  fromChatId: z.number().optional(),
  projectPath: z.string(),
  // The truncated JSONL content, inline. JSONL is small (<1 MB even for very
  // long conversations) so inlining is cheaper than a separate file with its
  // own lifecycle.
  jsonl: z.string(),
  topic: z.string().optional(),
  assistantPreview: z.string().optional(),
  createdAt: z.string(),
  /** Set to true once the target bot has proactively notified the user. The
   * lazy in-message path still works regardless; this flag just prevents
   * the proactive watcher from spamming on every file change / restart. */
  offered: z.boolean().optional(),
});

const fileSchema = z.object({
  users: z.record(z.string(), pendingForkSchema),
});

export type PendingFork = z.infer<typeof pendingForkSchema>;

function pathFor(botId: string): string {
  return path.join(HISTORY_DIR, `pending-forks-${botId}.json`);
}

function ensureDir(): void {
  if (!fs.existsSync(HISTORY_DIR)) {
    fs.mkdirSync(HISTORY_DIR, { recursive: true, mode: 0o700 });
  }
}

function loadFile(botId: string): { users: Record<string, PendingFork> } {
  const p = pathFor(botId);
  if (!fs.existsSync(p)) return { users: {} };
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw);
    const result = fileSchema.safeParse(parsed);
    if (result.success) return result.data;
    console.warn(`[PendingForks] Invalid file ${p}, starting fresh:`, result.error.message);
  } catch (err) {
    console.warn(`[PendingForks] Failed to load ${p}:`, err instanceof Error ? err.message : err);
  }
  return { users: {} };
}

function saveFile(botId: string, data: { users: Record<string, PendingFork> }): void {
  ensureDir();
  atomicWriteFileSync(pathFor(botId), JSON.stringify(data, null, 2), { mode: 0o600 });
}

/** Write a pending fork to the target bot's file, replacing any existing one for this user. */
export function putPendingFork(targetBotId: string, userId: number, fork: PendingFork): void {
  const data = loadFile(targetBotId);
  data.users[String(userId)] = fork;
  saveFile(targetBotId, data);
}

/** Read the pending fork for this (target bot, user), if any. */
export function getPendingFork(targetBotId: string, userId: number): PendingFork | undefined {
  const data = loadFile(targetBotId);
  return data.users[String(userId)];
}

/** Remove the pending fork for this (target bot, user). No-op if missing. */
export function removePendingFork(targetBotId: string, userId: number): void {
  const data = loadFile(targetBotId);
  if (!(String(userId) in data.users)) return;
  delete data.users[String(userId)];
  saveFile(targetBotId, data);
}

/** Flag a fork as already-offered so the proactive watcher won't re-send it. */
export function markForkOffered(targetBotId: string, userId: number): void {
  const data = loadFile(targetBotId);
  const entry = data.users[String(userId)];
  if (!entry) return;
  if (entry.offered) return;
  data.users[String(userId)] = { ...entry, offered: true };
  saveFile(targetBotId, data);
}

/** Return all pending forks for a bot, keyed by userId (string). */
export function listPendingForks(targetBotId: string): Record<string, PendingFork> {
  return loadFile(targetBotId).users;
}

/** Path that contains pending forks for this bot — useful for file watching. */
export function pendingForksPathFor(targetBotId: string): string {
  return pathFor(targetBotId);
}
