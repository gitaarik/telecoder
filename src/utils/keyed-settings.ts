/**
 * A per-session settings store backed by a JSON file in the state directory.
 *
 * The TTS, Terminal UI, Telegraph, prompt-suggestion and bot-name settings are
 * all the same thing: a `sessionKey → settings` map, persisted as
 * `{ settings: { [key]: entry } }`, where any field absent from disk falls back
 * to an env-level default. This factory is that shape, once.
 */

import * as path from 'path';
import { z, type ZodType } from 'zod';
import { ensureStateDir, getStateDir, readJsonFile, writeJsonFile } from './json-store.js';

export interface KeyedSettingsStore<T> {
  /** Settings for `key`, with defaults filled in for anything unset. */
  get(key: string): T;
  /** Merge `patch` into the stored settings for `key` and persist. */
  update(key: string, patch: Partial<T>): T;
}

export interface KeyedSettingsOptions<T> {
  /** Basename of the JSON file inside the state directory. */
  file: string;
  /** Prefix used in log lines, e.g. `TTS`. */
  label: string;
  /** Schema for one stored entry. Every field is optional — `normalize` fills the gaps. */
  entrySchema: ZodType<Partial<T>>;
  /** Apply defaults to a stored entry, or produce the all-defaults entry when called bare. */
  normalize(stored?: Partial<T>): T;
  /** Override the state directory. For tests. */
  dir?: string;
}

export function createKeyedSettings<T extends object>(
  opts: KeyedSettingsOptions<T>,
): KeyedSettingsStore<T> {
  const dir = opts.dir ?? getStateDir();
  const filePath = path.join(dir, opts.file);
  const fileSchema = z.object({ settings: z.record(z.string(), opts.entrySchema) });
  const entries = new Map<string, T>();

  ensureStateDir(dir, opts.label);
  const loaded = readJsonFile(filePath, fileSchema, opts.label);
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
