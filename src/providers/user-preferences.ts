/**
 * Per-chat settings — model, effort, verbosity, transport, status-line toggles.
 *
 * One file per bot. Every instance used to share a single `user-preferences.json`
 * keyed by chatId alone, which in a private chat is the same key on every bot:
 * a `/model` on one instance silently became everyone's model, and — because
 * each worker holds the whole file in memory and rewrites all of it on any
 * change — the next instance to save any setting at all clobbered that choice
 * back. Splitting the file by BOT_ID makes each bot the sole writer of its own
 * state; deliberately sharing a setting across bots is now an explicit
 * broadcast (see providers/prefs-sync.ts) rather than an accident of storage.
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { ensureStateDir, getStateDir, readJsonFile, writeJsonFile } from '../utils/json-store.js';
import { BOT_ID } from '../config.js';

// Zod schema for user preferences
const userPreferencesSchema = z.object({
  // `.catch` drops values this build no longer knows about (e.g. the retired
  // 'opencode' backend) instead of failing the parse. load() parses the whole
  // file in one shot, so a strict enum would make one stale value wipe every
  // user's saved model/effort/verbosity too.
  provider: z.enum(['claude', 'ccr']).optional().catch(undefined),
  method: z.enum(['sdk', 'pty']).optional(),
  model: z.string().optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  verbosity: z.enum(['quiet', 'normal', 'verbose', 'debug']).optional(),
  // `.catch` for the same reason as provider: a mode this build no longer
  // knows about should drop, not take every other saved setting with it.
  permissionMode: z
    .enum(['manual', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'])
    .optional()
    .catch(undefined),
  showStatusLine: z.boolean().optional(),
  showTopicInStatusLine: z.boolean().optional(),
  showSessionInStatusLine: z.boolean().optional(),
  showPromptInStatusLine: z.boolean().optional(),
  lastUpdated: z.string(),
});

const preferencesDataSchema = z.object({
  users: z.record(z.string(), userPreferencesSchema),
});

export type UserPreferences = z.infer<typeof userPreferencesSchema>;

const PREFS_DIR = getStateDir();
const PREFS_FILE = path.join(PREFS_DIR, `user-preferences-${BOT_ID}.json`);
/** The single shared file every instance wrote to before preferences were per-bot. */
const LEGACY_PREFS_FILE = path.join(PREFS_DIR, 'user-preferences.json');

class UserPreferencesManager {
  private data: Record<number, UserPreferences> = {};

  constructor() {
    ensureStateDir(PREFS_DIR, 'UserPreferences');
    this.load();
  }

  private load(): void {
    // First start after the split: inherit whatever the shared file holds, so
    // nobody's model or effort resets. The legacy file is read, never removed
    // — sibling bots still on their first start need to seed from it too, and
    // a downgrade should still find it.
    const seeding = !fs.existsSync(PREFS_FILE);
    const loaded = seeding
      ? readJsonFile(LEGACY_PREFS_FILE, preferencesDataSchema, 'UserPreferences')
      : readJsonFile(PREFS_FILE, preferencesDataSchema, 'UserPreferences');

    // Convert string keys back to numbers
    this.data = Object.fromEntries(
      Object.entries(loaded?.users ?? {}).map(([k, v]) => [parseInt(k, 10), v])
    ) as Record<number, UserPreferences>;

    // Claim the per-bot file straight away rather than on the next setting
    // change, so the inherited values are visibly this bot's from now on.
    if (seeding && Object.keys(this.data).length > 0) {
      console.log(`[UserPreferences] Seeded ${path.basename(PREFS_FILE)} from ${path.basename(LEGACY_PREFS_FILE)} (${Object.keys(this.data).length} chat(s))`);
      this.save();
    }
  }

  private save(): void {
    writeJsonFile(PREFS_FILE, { users: { ...this.data } }, 'UserPreferences');
  }

  /** Apply a field change for `chatId`, stamping `lastUpdated` and persisting. */
  private patch(chatId: number, changes: Partial<UserPreferences>): void {
    this.data[chatId] = {
      ...this.data[chatId],
      ...changes,
      lastUpdated: new Date().toISOString(),
    };
    this.save();
  }

  /**
   * Drop a single field for `chatId`, if that chat has any preferences at all.
   * `lastUpdated` is excluded — it is the one required field, and clearing it
   * would leave an entry that no longer round-trips through the schema.
   */
  private unset(chatId: number, field: Exclude<keyof UserPreferences, 'lastUpdated'>): void {
    if (!this.data[chatId]) return;
    delete this.data[chatId][field];
    this.data[chatId].lastUpdated = new Date().toISOString();
    this.save();
  }

  getProvider(chatId: number): 'claude' | 'ccr' | undefined {
    return this.data[chatId]?.provider;
  }

  setProvider(chatId: number, provider: 'claude' | 'ccr'): void {
    this.patch(chatId, { provider });
  }

  getMethod(chatId: number): 'sdk' | 'pty' | undefined {
    return this.data[chatId]?.method;
  }

  setMethod(chatId: number, method: 'sdk' | 'pty'): void {
    this.patch(chatId, { method });
  }

  getModel(chatId: number): string | undefined {
    return this.data[chatId]?.model;
  }

  setModel(chatId: number, model: string): void {
    this.patch(chatId, { model });
  }

  clearModel(chatId: number): void {
    this.unset(chatId, 'model');
  }

  getEffort(chatId: number): string | undefined {
    return this.data[chatId]?.effort;
  }

  setEffort(chatId: number, effort: string): void {
    this.patch(chatId, { effort: effort as UserPreferences['effort'] });
  }

  clearEffort(chatId: number): void {
    this.unset(chatId, 'effort');
  }

  getPermissionMode(chatId: number): UserPreferences['permissionMode'] {
    return this.data[chatId]?.permissionMode;
  }

  setPermissionMode(chatId: number, mode: NonNullable<UserPreferences['permissionMode']>): void {
    this.patch(chatId, { permissionMode: mode });
  }

  clearPermissionMode(chatId: number): void {
    this.unset(chatId, 'permissionMode');
  }

  getVerbosity(chatId: number): 'quiet' | 'normal' | 'verbose' | 'debug' | undefined {
    return this.data[chatId]?.verbosity;
  }

  setVerbosity(chatId: number, verbosity: 'quiet' | 'normal' | 'verbose' | 'debug'): void {
    this.patch(chatId, { verbosity });
  }

  clearVerbosity(chatId: number): void {
    this.unset(chatId, 'verbosity');
  }

  getShowStatusLine(chatId: number): boolean {
    return this.data[chatId]?.showStatusLine === true;
  }

  setShowStatusLine(chatId: number, enabled: boolean): void {
    this.patch(chatId, { showStatusLine: enabled });
  }

  getShowTopicInStatusLine(chatId: number): boolean {
    return this.data[chatId]?.showTopicInStatusLine === true;
  }

  setShowTopicInStatusLine(chatId: number, enabled: boolean): void {
    this.patch(chatId, { showTopicInStatusLine: enabled });
  }

  getShowSessionInStatusLine(chatId: number): boolean {
    return this.data[chatId]?.showSessionInStatusLine === true;
  }

  setShowSessionInStatusLine(chatId: number, enabled: boolean): void {
    this.patch(chatId, { showSessionInStatusLine: enabled });
  }

  getShowPromptInStatusLine(chatId: number): boolean {
    return this.data[chatId]?.showPromptInStatusLine === true;
  }

  setShowPromptInStatusLine(chatId: number, enabled: boolean): void {
    this.patch(chatId, { showPromptInStatusLine: enabled });
  }

  clearPreferences(chatId: number): void {
    delete this.data[chatId];
    this.save();
  }
}

export const userPreferences = new UserPreferencesManager();
