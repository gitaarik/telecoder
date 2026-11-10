/**
 * Per-chat and per-thread settings — model, effort, verbosity, transport,
 * status-line toggles.
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
import { scopeChatId, type SettingsScope } from '../utils/session-key.js';

// Zod schema for user preferences
const userPreferencesSchema = z.object({
  // `.catch` drops values this build no longer knows about (e.g. the retired
  // 'opencode' backend) instead of failing the parse. load() parses the whole
  // file in one shot, so a strict enum would make one stale value wipe every
  // user's saved model/effort/verbosity too.
  provider: z.enum(['claude', 'ccr']).optional().catch(undefined),
  method: z.enum(['sdk', 'pty']).optional(),
  // The clearable settings also take null: a thread that resets one to the
  // default has to say so, or it would fall back to the chat's choice.
  model: z.string().nullable().optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullable().optional(),
  verbosity: z.enum(['quiet', 'normal', 'verbose', 'debug']).nullable().optional(),
  // `.catch` for the same reason as provider: a mode this build no longer
  // knows about should drop, not take every other saved setting with it.
  permissionMode: z
    .enum(['manual', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'])
    .nullable()
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
type Field = Exclude<keyof UserPreferences, 'lastUpdated'>;
type Value<F extends Field> = Exclude<UserPreferences[F], null>;
type ClearableField = 'model' | 'effort' | 'verbosity' | 'permissionMode';

const PREFS_DIR = getStateDir();
const PREFS_FILE = path.join(PREFS_DIR, `user-preferences-${BOT_ID}.json`);
/** The single shared file every instance wrote to before preferences were per-bot. */
const LEGACY_PREFS_FILE = path.join(PREFS_DIR, 'user-preferences.json');

/**
 * Entries are keyed by settings scope (see SettingsScope): a chat id for the
 * chat-wide value, `chatId:threadId` for one thread's. A thread reads its own
 * entry first and the chat's after, field by field, so a thread only holds the
 * settings it changed and picks up the rest from the chat.
 */
class UserPreferencesManager {
  private data: Record<string, UserPreferences> = {};

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

    this.data = { ...(loaded?.users ?? {}) };

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

  /** The scope's own value, else the chat's; null (an explicit default) reads as unset. */
  private get<F extends Field>(scope: SettingsScope, field: F): Value<F> | undefined {
    const key = String(scope);
    const own = this.data[key];
    if (own && own[field] !== undefined) return (own[field] ?? undefined) as Value<F> | undefined;
    const chatKey = String(scopeChatId(scope));
    if (chatKey === key) return undefined;
    return (this.data[chatKey]?.[field] ?? undefined) as Value<F> | undefined;
  }

  /** Apply a field change for `scope`, stamping `lastUpdated` and persisting. */
  private patch(scope: SettingsScope, changes: Partial<UserPreferences>): void {
    const key = String(scope);
    this.data[key] = {
      ...this.data[key],
      ...changes,
      lastUpdated: new Date().toISOString(),
    };
    this.save();
  }

  /**
   * Back to the default for `scope`. A chat-wide entry just drops the field. A
   * thread stores null instead, so "default" isn't read as "whatever the chat
   * has". `lastUpdated` is excluded — it is the one required field, and
   * clearing it would leave an entry that no longer round-trips the schema.
   */
  private unset(scope: SettingsScope, field: ClearableField): void {
    const key = String(scope);
    if (key !== String(scopeChatId(scope))) {
      this.patch(scope, { [field]: null });
      return;
    }
    if (!this.data[key]) return;
    delete this.data[key][field];
    this.data[key].lastUpdated = new Date().toISOString();
    this.save();
  }

  getProvider(scope: SettingsScope): 'claude' | 'ccr' | undefined {
    return this.get(scope, 'provider');
  }

  setProvider(scope: SettingsScope, provider: 'claude' | 'ccr'): void {
    this.patch(scope, { provider });
  }

  getMethod(scope: SettingsScope): 'sdk' | 'pty' | undefined {
    return this.get(scope, 'method');
  }

  setMethod(scope: SettingsScope, method: 'sdk' | 'pty'): void {
    this.patch(scope, { method });
  }

  getModel(scope: SettingsScope): string | undefined {
    return this.get(scope, 'model');
  }

  setModel(scope: SettingsScope, model: string): void {
    this.patch(scope, { model });
  }

  clearModel(scope: SettingsScope): void {
    this.unset(scope, 'model');
  }

  getEffort(scope: SettingsScope): string | undefined {
    return this.get(scope, 'effort');
  }

  setEffort(scope: SettingsScope, effort: string): void {
    this.patch(scope, { effort: effort as UserPreferences['effort'] });
  }

  clearEffort(scope: SettingsScope): void {
    this.unset(scope, 'effort');
  }

  getPermissionMode(scope: SettingsScope): Value<'permissionMode'> | undefined {
    return this.get(scope, 'permissionMode');
  }

  setPermissionMode(scope: SettingsScope, mode: Value<'permissionMode'>): void {
    this.patch(scope, { permissionMode: mode });
  }

  clearPermissionMode(scope: SettingsScope): void {
    this.unset(scope, 'permissionMode');
  }

  getVerbosity(scope: SettingsScope): 'quiet' | 'normal' | 'verbose' | 'debug' | undefined {
    return this.get(scope, 'verbosity');
  }

  setVerbosity(scope: SettingsScope, verbosity: 'quiet' | 'normal' | 'verbose' | 'debug'): void {
    this.patch(scope, { verbosity });
  }

  clearVerbosity(scope: SettingsScope): void {
    this.unset(scope, 'verbosity');
  }

  getShowStatusLine(scope: SettingsScope): boolean {
    return this.get(scope, 'showStatusLine') === true;
  }

  setShowStatusLine(scope: SettingsScope, enabled: boolean): void {
    this.patch(scope, { showStatusLine: enabled });
  }

  getShowTopicInStatusLine(scope: SettingsScope): boolean {
    return this.get(scope, 'showTopicInStatusLine') === true;
  }

  setShowTopicInStatusLine(scope: SettingsScope, enabled: boolean): void {
    this.patch(scope, { showTopicInStatusLine: enabled });
  }

  getShowSessionInStatusLine(scope: SettingsScope): boolean {
    return this.get(scope, 'showSessionInStatusLine') === true;
  }

  setShowSessionInStatusLine(scope: SettingsScope, enabled: boolean): void {
    this.patch(scope, { showSessionInStatusLine: enabled });
  }

  getShowPromptInStatusLine(scope: SettingsScope): boolean {
    return this.get(scope, 'showPromptInStatusLine') === true;
  }

  setShowPromptInStatusLine(scope: SettingsScope, enabled: boolean): void {
    this.patch(scope, { showPromptInStatusLine: enabled });
  }

  /**
   * Start `to` with the settings `from` chose for itself — for a thread forked
   * off another, which should carry on with the same model and transport. A
   * chat-wide `from` copies nothing: `to` falls back to it anyway.
   */
  copyScope(from: SettingsScope, to: SettingsScope): void {
    const own = this.data[String(from)];
    if (!own || String(from) === String(scopeChatId(from))) return;
    this.data[String(to)] = { ...own, lastUpdated: new Date().toISOString() };
    this.save();
  }

  clearPreferences(scope: SettingsScope): void {
    delete this.data[String(scope)];
    this.save();
  }
}

export const userPreferences = new UserPreferencesManager();
