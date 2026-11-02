/**
 * A per-session settings store backed by a JSON file in the state directory.
 *
 * The TTS, Terminal UI, Telegraph, prompt-suggestion and bot-name settings are
 * all the same thing: a `sessionKey → settings` map, persisted as
 * `{ settings: { [key]: entry } }`, where any field absent from disk falls back
 * to an env-level default. This factory is that shape, once.
 *
 * Each bot has its own file. Each bot is its own process with its own copy of
 * the entries, so when they shared one, every save put back whatever the others
 * had changed since that copy was loaded. Merging by key wouldn't have helped:
 * a private chat's key is the user's id, the same for every bot they talk to.
 */

import * as path from 'path';
import { z, type ZodType } from 'zod';
import { BOT_ID } from '../config.js';
import { ensureStateDir, getStateDir, readSeededJsonFile, writeJsonFile } from './json-store.js';

export interface KeyedSettingsStore<T> {
  /** Settings for `key`, with defaults filled in for anything unset. */
  get(key: string): T;
  /** Merge `patch` into the stored settings for `key` and persist. */
  update(key: string, patch: Partial<T>): T;
}

export interface KeyedSettingsOptions<T> {
  /**
   * Basename of the file all bots shared before settings were per-bot, like
   * `tts-settings.json`. Now only a first start reads it. Each bot's own file
   * is named after it: `tts-settings-<botId>.json`.
   */
  file: string;
  /** Prefix used in log lines, e.g. `TTS`. */
  label: string;
  /** Schema for one stored entry. Every field is optional — `normalize` fills the gaps. */
  entrySchema: ZodType<Partial<T>>;
  /** Apply defaults to a stored entry, or produce the all-defaults entry when called bare. */
  normalize(stored?: Partial<T>): T;
  /** Override the state directory. For tests. */
  dir?: string;
  /** Override the bot the file belongs to. For tests. */
  botId?: string;
}

export function createKeyedSettings<T extends object>(
  opts: KeyedSettingsOptions<T>,
): KeyedSettingsStore<T> {
  const dir = opts.dir ?? getStateDir();
  const filePath = path.join(dir, `${path.basename(opts.file, '.json')}-${opts.botId ?? BOT_ID}.json`);
  const sharedPath = path.join(dir, opts.file);
  const fileSchema = z.object({ settings: z.record(z.string(), opts.entrySchema) });
  const entries = new Map<string, T>();

  ensureStateDir(dir, opts.label);

  // A seed is copied as it was on disk rather than normalized: a field nobody
  // chose has to keep following its env-level default, see get().
  const loaded = readSeededJsonFile(filePath, sharedPath, fileSchema, opts.label);
  if (loaded) {
    for (const [key, stored] of Object.entries(loaded.settings)) {
      entries.set(key, opts.normalize(stored));
    }
  }

  function assertKey(key: string): void {
    if (!key || typeof key !== 'string') {
      throw new Error(`[${opts.label}] Invalid settings key: ${key}`);
    }
  }

  function save(): void {
    ensureStateDir(dir, opts.label);
    writeJsonFile(filePath, { settings: Object.fromEntries(entries) }, opts.label);
  }

  function get(key: string): T {
    assertKey(key);
    const existing = entries.get(key);
    if (existing) return existing;
    // Deliberately not stored: a session that has never chosen keeps tracking
    // its env-level default, so changing the default in config still reaches
    // every user who hasn't overridden it. Persisting here would freeze the
    // default at whatever it happened to be the first time something read it.
    return opts.normalize();
  }

  function update(key: string, patch: Partial<T>): T {
    assertKey(key);
    const next = { ...get(key), ...patch };
    entries.set(key, next);
    save();
    return next;
  }

  return { get, update };
}
