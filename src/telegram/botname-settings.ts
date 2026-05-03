/**
 * Dynamic bot name settings per chat.
 * When enabled, the Telegram bot display name updates to include the active project.
 */

import { config } from '../config.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { z } from 'zod';

const botnameSettingsSchema = z.object({
  enabled: z.boolean().optional(),
});

const botnameSettingsFileSchema = z.object({
  settings: z.record(z.string(), botnameSettingsSchema),
});

export interface BotNameSettings {
  enabled: boolean;
}

const SETTINGS_DIR = path.join(os.homedir(), '.claudegram');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'botname-settings.json');
const chatBotNameSettings: Map<string, BotNameSettings> = new Map();

function ensureDirectory(): void {
  if (!fs.existsSync(SETTINGS_DIR)) {
    fs.mkdirSync(SETTINGS_DIR, { recursive: true, mode: 0o700 });
  }
}

function normalizeSettings(settings?: Partial<BotNameSettings>): BotNameSettings {
  return {
    enabled: typeof settings?.enabled === 'boolean' ? settings.enabled : config.DYNAMIC_BOT_NAME,
  };
}

function loadSettings(): void {
  ensureDirectory();
  if (!fs.existsSync(SETTINGS_FILE)) return;

  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);

    const result = botnameSettingsFileSchema.safeParse(parsed);
    if (!result.success) {
      console.warn('[BotName] Invalid settings file format, starting fresh:', result.error.message);
      return;
    }

    for (const [key, settings] of Object.entries(result.data.settings)) {
      chatBotNameSettings.set(key, normalizeSettings(settings));
    }
  } catch (error) {
    console.error('[BotName] Failed to load settings:', error);
  }
}

function saveSettings(): void {
  ensureDirectory();
  const settings: Record<string, BotNameSettings> = {};
  for (const [key, value] of chatBotNameSettings.entries()) {
    settings[key] = value;
  }

  try {
    atomicWriteFileSync(SETTINGS_FILE, JSON.stringify({ settings }, null, 2), { mode: 0o600 });
  } catch (error) {
    console.error('[BotName] Failed to save settings:', error);
  }
}

loadSettings();

export function getBotNameSettings(sessionKey: string): BotNameSettings {
  const existing = chatBotNameSettings.get(sessionKey);
  if (existing) return existing;

  const defaults = normalizeSettings();
  chatBotNameSettings.set(sessionKey, defaults);
  saveSettings();
  return defaults;
}

export function setBotNameEnabled(sessionKey: string, enabled: boolean): void {
  const settings = getBotNameSettings(sessionKey);
  settings.enabled = enabled;
  saveSettings();
}

export function isBotNameEnabled(sessionKey: string): boolean {
  return getBotNameSettings(sessionKey).enabled;
}

// ---------------------------------------------------------------------------
// Rate-limited setMyName wrapper
// ---------------------------------------------------------------------------

const MIN_NAME_UPDATE_INTERVAL_MS = 60_000; // 1 minute

interface NameRateState {
  lastUpdateTime: number;
  pendingName: string | null;
  pendingApiCall: ((name: string) => Promise<unknown>) | null;
  pendingTimer: ReturnType<typeof setTimeout> | null;
}

// Per-bot rate-limit state. Keyed by the bot's `api` object (stable per bot)
// so multiple bots running in the same process don't collide on a shared
// throttle slot. WeakMap lets state get GC'd if a bot is torn down.
const nameRateStates: WeakMap<object, NameRateState> = new WeakMap();

function getRateState(key: object): NameRateState {
  let state = nameRateStates.get(key);
  if (!state) {
    state = { lastUpdateTime: 0, pendingName: null, pendingApiCall: null, pendingTimer: null };
    nameRateStates.set(key, state);
  }
  return state;
}

/**
 * Rate-limited wrapper around `bot.api.setMyName()`.
 * At most one call per minute *per bot*; if called more frequently the latest
 * name is queued and applied when the cooldown expires.
 *
 * `botKey` must be a stable object identifying the bot (typically `ctx.api`
 * or `bot.api`). State is tracked per-key so multiple bots in the same
 * process don't share a throttle slot.
 */
export async function rateLimitedSetMyName(
  botKey: object,
  apiCall: (name: string) => Promise<unknown>,
  name: string,
): Promise<void> {
  const state = getRateState(botKey);
  const now = Date.now();
  const elapsed = now - state.lastUpdateTime;

  if (elapsed >= MIN_NAME_UPDATE_INTERVAL_MS) {
    state.lastUpdateTime = now;
    state.pendingName = null;
    state.pendingApiCall = null;
    if (state.pendingTimer) { clearTimeout(state.pendingTimer); state.pendingTimer = null; }
    await apiCall(name);
  } else {
    state.pendingName = name;
    state.pendingApiCall = apiCall;
    if (!state.pendingTimer) {
      const delay = MIN_NAME_UPDATE_INTERVAL_MS - elapsed;
      state.pendingTimer = setTimeout(async () => {
        state.pendingTimer = null;
        const queuedName = state.pendingName;
        const queuedCall = state.pendingApiCall;
        state.pendingName = null;
        state.pendingApiCall = null;
        if (queuedName !== null && queuedCall) {
          state.lastUpdateTime = Date.now();
          try {
            await queuedCall(queuedName);
          } catch (err) {
            console.error('[BotName] Deferred name update failed:', err instanceof Error ? err.message : err);
          }
        }
      }, delay);
    }
  }
}
