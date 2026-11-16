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
import { BOT_ID, config } from '../config.js';
import { scopeChatId, type SettingsScope } from '../utils/session-key.js';

// Zod schema for user preferences
const userPreferencesSchema = z.object({
  // `.catch` drops values this build no longer knows about (e.g. the retired
  // 'opencode' backend) instead of failing the parse. load() parses the whole
  // file in one shot, so a strict enum would make one stale value wipe every
  // user's saved model/effort/verbosity too.
  provider: z.enum(['claude', 'ccr']).optional().catch(undefined),
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

/** The settings the CLI takes as spawn flags, which can be set at every level below. */
export type SpawnSetting = 'model' | 'effort';

/**
 * How far a /model or /effort choice reaches, narrowest first:
 * - `thread`: this thread only, as a pin its forks inherit.
 * - `default`: the chat's default, which new threads and every thread without
 *   a pin of its own follow; this thread drops its pin to follow it too.
 * - `chat`: the chat's default, with every thread's pin in the chat dropped.
 * - `all`: the bot's default, with every pin in every chat dropped.
 * In a chat without threads the first three are the same entry.
 */
export type SettingLevel = 'thread' | 'default' | 'chat' | 'all';

/** Where a scope's value for a spawn setting comes from. */
export type SettingSource = 'thread' | 'chat' | 'bot';

/**
 * The entry every chat falls back to for a spawn setting it never chose:
 * what `/model … all` writes. Not a chat id, so it never collides with one.
 */
const BOT_DEFAULT_KEY = '*';

const SPAWN_SETTINGS: ReadonlySet<string> = new Set<SpawnSetting>(['model', 'effort']);

const PREFS_DIR = getStateDir();
const PREFS_FILE = path.join(PREFS_DIR, `user-preferences-${BOT_ID}.json`);
/** The single shared file every instance wrote to before preferences were per-bot. */
const LEGACY_PREFS_FILE = path.join(PREFS_DIR, 'user-preferences.json');

/**
 * Entries are keyed by settings scope (see SettingsScope): a chat id for the
 * chat-wide value, `chatId:threadId` for one thread's. A thread reads its own
 * entry first and the chat's after, field by field, so a thread only holds the
 * settings it changed and picks up the rest from the chat. Model and effort
 * fall back once more, to the bot-wide entry under BOT_DEFAULT_KEY.
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

  /**
   * The entries a scope reads, in order: its own, the chat's, and for the
   * spawn settings the bot-wide default.
   */
  private chain(scope: SettingsScope, field: Field): string[] {
    const key = String(scope);
    const chatKey = String(scopeChatId(scope));
    const keys = chatKey === key ? [key] : [key, chatKey];
    if (SPAWN_SETTINGS.has(field)) keys.push(BOT_DEFAULT_KEY);
    return keys;
  }

  /** The first entry in the chain that holds the field, null included. */
  private holder(scope: SettingsScope, field: Field): string | undefined {
    return this.chain(scope, field).find((k) => this.data[k]?.[field] !== undefined);
  }

  /** The nearest value along the chain; null (an explicit default) reads as unset. */
  private get<F extends Field>(scope: SettingsScope, field: F): Value<F> | undefined {
    const k = this.holder(scope, field);
    if (k === undefined) return undefined;
    return (this.data[k][field] ?? undefined) as Value<F> | undefined;
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

  /**
   * Drop a thread's own settings, for a thread that no longer exists. A chat's
   * entry is never dropped this way: its threads fall back to it.
   */
  forgetThread(scope: SettingsScope): void {
    const key = String(scope);
    if (key === String(scopeChatId(scope)) || !this.data[key]) return;
    delete this.data[key];
    this.save();
  }

  getProvider(scope: SettingsScope): 'claude' | 'ccr' | undefined {
    return this.get(scope, 'provider');
  }

  setProvider(scope: SettingsScope, provider: 'claude' | 'ccr'): void {
    this.patch(scope, { provider });
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

  // The status line and its topic line are on until a chat turns them off;
  // the prompts and the resume command are off until it turns them on.
  getShowStatusLine(scope: SettingsScope): boolean {
    return this.get(scope, 'showStatusLine') ?? config.STATUS_LINE_DEFAULT;
  }

  setShowStatusLine(scope: SettingsScope, enabled: boolean): void {
    this.patch(scope, { showStatusLine: enabled });
  }

  getShowTopicInStatusLine(scope: SettingsScope): boolean {
    return this.get(scope, 'showTopicInStatusLine') ?? true;
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
   * Which level a scope's model or effort comes from: its own pin, the chat's
   * default, or the bot's. Undefined when nothing chose, so the CLI's own
   * default applies. A level that chose "the CLI default" on purpose counts.
   */
  sourceOf(scope: SettingsScope, field: SpawnSetting): SettingSource | undefined {
    const k = this.holder(scope, field);
    if (k === undefined) return undefined;
    if (k === BOT_DEFAULT_KEY) return 'bot';
    return k === String(scopeChatId(scope)) ? 'chat' : 'thread';
  }

  /**
   * The threads of a chat that pin `field` to something other than `value`:
   * the ones a `default`-level change leaves alone.
   */
  threadsPinnedOtherThan(chatId: number, field: SpawnSetting, value: string | null): string[] {
    const prefix = `${chatId}:`;
    return Object.keys(this.data).filter((k) => {
      if (!k.startsWith(prefix)) return false;
      const v = this.data[k][field];
      return v !== undefined && v !== value;
    });
  }

  /**
   * Set a model or effort at a level (see SettingLevel). `value: null` means
   * the CLI's own default, chosen on purpose: it is stored, so it isn't read
   * as "whatever the wider level says". At `all` there is nothing wider, so
   * null just clears the bot-wide entry.
   *
   * Returns the entries whose own, different pin was dropped to follow the
   * new value, for the confirmation to name.
   */
  applyLevel(scope: SettingsScope, field: SpawnSetting, value: string | null, level: SettingLevel): string[] {
    const key = String(scope);
    const chatKey = String(scopeChatId(scope));
    const inThread = key !== chatKey;
    const now = new Date().toISOString();
    const dropped: string[] = [];

    const drop = (k: string): void => {
      const entry = this.data[k];
      if (!entry || entry[field] === undefined) return;
      if (entry[field] !== value) dropped.push(k);
      delete entry[field];
      entry.lastUpdated = now;
    };
    const set = (k: string, v: string | null): void => {
      this.data[k] = { ...this.data[k], [field]: v, lastUpdated: now };
    };

    if (level === 'all') {
      for (const k of Object.keys(this.data)) {
        if (k !== BOT_DEFAULT_KEY) drop(k);
      }
      if (value !== null) set(BOT_DEFAULT_KEY, value);
      else if (this.data[BOT_DEFAULT_KEY]) {
        delete this.data[BOT_DEFAULT_KEY][field];
        this.data[BOT_DEFAULT_KEY].lastUpdated = now;
      }
    } else if (level === 'thread' && inThread) {
      set(key, value);
    } else {
      if (level === 'chat') {
        for (const k of Object.keys(this.data)) {
          if (k.startsWith(`${chatKey}:`)) drop(k);
        }
      } else if (inThread) {
        drop(key);
      }
      set(chatKey, value);
    }

    this.save();
    return dropped;
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
