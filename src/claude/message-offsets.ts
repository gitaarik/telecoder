/**
 * Index from a Telegram assistant message_id → the JSONL truncation point
 * that recreates the conversation state at the moment that message was sent.
 *
 * Used by /fork: the user taps a "🍴 Fork" button on a past assistant message,
 * we look up the recorded {claudeSessionId, lineCount, projectPath} for that
 * message, and slice the source JSONL to lineCount to build the truncated
 * transcript that gets handed off to the target bot.
 *
 * File-backed (~/.claudegram/message-offsets-<botId>.json) so a restart
 * doesn't invalidate fork buttons that were posted before the restart.
 * Bounded per sessionKey to keep the file from growing forever — old
 * entries simply lose their fork button (the button still exists in chat
 * history; on tap we report "fork point no longer available").
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { ensureStateDir, getStateDir, readJsonFile, writeJsonFile } from '../utils/json-store.js';
import { BOT_ID } from '../config.js';

const HISTORY_DIR = getStateDir();

const entrySchema = z.object({
  claudeSessionId: z.string(),
  projectPath: z.string(),
  lineCount: z.number().int().nonnegative(),
  topic: z.string().optional(),
  conversationId: z.string().optional(),
  ts: z.string(),
});

const fileSchema = z.object({
  sessions: z.record(z.string(), z.record(z.string(), entrySchema)),
});

export type MessageOffsetEntry = z.infer<typeof entrySchema>;

const MAX_OFFSETS_PER_SESSION = 200;

class MessageOffsetStore {
  private data: { sessions: Record<string, Record<string, MessageOffsetEntry>> } = { sessions: {} };
  private filePath: string;

  constructor() {
    this.filePath = path.join(HISTORY_DIR, `message-offsets-${BOT_ID}.json`);
    ensureStateDir(HISTORY_DIR, 'MessageOffsets');
    this.load();
  }

  private load(): void {
    const loaded = readJsonFile(this.filePath, fileSchema, 'MessageOffsets');
    if (loaded) this.data = loaded;
  }

  private save(): void {
    writeJsonFile(this.filePath, this.data, 'MessageOffsets');
  }

  record(
    sessionKey: string,
    telegramMessageId: number,
    entry: Omit<MessageOffsetEntry, 'ts'>,
  ): void {
    const bucket = this.data.sessions[sessionKey] ?? {};
    bucket[String(telegramMessageId)] = { ...entry, ts: new Date().toISOString() };

    // Trim oldest entries beyond the cap (by ts ascending).
    const keys = Object.keys(bucket);
    if (keys.length > MAX_OFFSETS_PER_SESSION) {
      const sorted = keys.sort((a, b) => bucket[a].ts.localeCompare(bucket[b].ts));
      const excess = sorted.slice(0, keys.length - MAX_OFFSETS_PER_SESSION);
      for (const k of excess) delete bucket[k];
    }

    this.data.sessions[sessionKey] = bucket;
    this.save();
  }

  lookup(sessionKey: string, telegramMessageId: number): MessageOffsetEntry | undefined {
    return this.data.sessions[sessionKey]?.[String(telegramMessageId)];
  }
}

export const messageOffsets = new MessageOffsetStore();

/**
 * Count current JSONL lines for a session. Used at "turn finished" time to
 * record the truncation boundary for the Fork button.
 */
export function countJsonlLines(filePath: string): number {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (!raw) return 0;
    // JSONL is line-delimited; trailing newline shouldn't count as a record.
    const lines = raw.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines.length;
  } catch {
    return 0;
  }
}
