/**
 * Per-chat prompt-suggestion settings — controls whether TeleCoder enables
 * Claude Code's `prompt_suggestion` feature for this session and scrapes the
 * resulting ghost text. Persisted to ~/.claudegram/suggestions-settings.json.
 *
 * Takes effect on next PTY spawn (the env var is set at spawn time). A
 * mid-session toggle is recorded but won't activate until the user starts a
 * new session or the PTY is restarted for any other reason.
 */

import { config } from '../config.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { z } from 'zod';

const suggestionsSettingsSchema = z.object({
  enabled: z.boolean().optional(),
});

const suggestionsSettingsFileSchema = z.object({
  settings: z.record(z.string(), suggestionsSettingsSchema),
});

export interface SuggestionsSettings {
  enabled: boolean;
}

const SETTINGS_DIR = path.join(os.homedir(), '.claudegram');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'suggestions-settings.json');
const chatSuggestionsSettings: Map<string, SuggestionsSettings> = new Map();

function ensureDirectory(): void {
  if (!fs.existsSync(SETTINGS_DIR)) {
    fs.mkdirSync(SETTINGS_DIR, { recursive: true, mode: 0o700 });
  }
}

function normalizeSettings(settings?: Partial<SuggestionsSettings>): SuggestionsSettings {
  return {
    enabled: typeof settings?.enabled === 'boolean' ? settings.enabled : config.PROMPT_SUGGESTIONS_DEFAULT,
  };
}

function loadSettings(): void {
  ensureDirectory();
  if (!fs.existsSync(SETTINGS_FILE)) return;

  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    const result = suggestionsSettingsFileSchema.safeParse(parsed);
    if (!result.success) {
      console.warn('[Suggestions] Invalid settings file format, starting fresh:', result.error.message);
      return;
    }
    for (const [key, settings] of Object.entries(result.data.settings)) {
      chatSuggestionsSettings.set(key, normalizeSettings(settings));
    }
  } catch (error) {
    console.error('[Suggestions] Failed to load settings:', error);
  }
}

function saveSettings(): void {
  ensureDirectory();
  const settings: Record<string, SuggestionsSettings> = {};
  for (const [key, value] of chatSuggestionsSettings.entries()) {
    settings[key] = value;
  }
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ settings }, null, 2), { mode: 0o600 });
  } catch (error) {
    console.error('[Suggestions] Failed to save settings:', error);
  }
}

loadSettings();

export function getSuggestionsSettings(sessionKey: string): SuggestionsSettings {
  const existing = chatSuggestionsSettings.get(sessionKey);
  if (existing) return existing;
  const defaults = normalizeSettings();
  chatSuggestionsSettings.set(sessionKey, defaults);
  return defaults;
}

export function setSuggestionsEnabled(sessionKey: string, enabled: boolean): void {
  const settings = getSuggestionsSettings(sessionKey);
  settings.enabled = enabled;
  saveSettings();
}

export function isSuggestionsEnabled(sessionKey: string): boolean {
  return getSuggestionsSettings(sessionKey).enabled;
}
