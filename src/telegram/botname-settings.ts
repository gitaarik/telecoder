/**
 * Dynamic bot name settings per chat.
 * When enabled, the Telegram bot display name updates to include the active project.
 */

import { config, BOT_ID } from '../config.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { z } from 'zod';
import { GrammyError } from 'grammy';

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

const MIN_NAME_UPDATE_INTERVAL_MS = 60_000; // 1 minute soft cooldown
const COOLDOWN_FILE = path.join(SETTINGS_DIR, 'setmyname-cooldowns.json');

const cooldownsSchema = z.object({
  cooldowns: z.record(z.string(), z.object({ blockedUntil: z.number() })),
});

// Per-bot persistent 429 cooldowns. Telegram's setMyName limit is much
// stricter than our soft local interval, and the local state is reset on
// every restart — so we honor any retry_after Telegram returns and persist
// the "do not call before" timestamp to disk.
const blockedUntilByBot: Map<string, number> = new Map();

function loadCooldowns(): void {
  ensureDirectory();
  if (!fs.existsSync(COOLDOWN_FILE)) return;
  try {
    const raw = fs.readFileSync(COOLDOWN_FILE, 'utf-8');
    const result = cooldownsSchema.safeParse(JSON.parse(raw));
    if (!result.success) {
      console.warn('[BotName] Invalid cooldowns file, starting fresh:', result.error.message);
      return;
    }
    for (const [botId, { blockedUntil }] of Object.entries(result.data.cooldowns)) {
      blockedUntilByBot.set(botId, blockedUntil);
    }
  } catch (err) {
    console.error('[BotName] Failed to load cooldowns:', err);
  }
}

function saveCooldowns(): void {
  ensureDirectory();
  const cooldowns: Record<string, { blockedUntil: number }> = {};
  const now = Date.now();
  for (const [botId, blockedUntil] of blockedUntilByBot.entries()) {
    if (blockedUntil > now) cooldowns[botId] = { blockedUntil };
  }
  try {
    atomicWriteFileSync(COOLDOWN_FILE, JSON.stringify({ cooldowns }, null, 2), { mode: 0o600 });
  } catch (err) {
    console.error('[BotName] Failed to save cooldowns:', err);
  }
}

loadCooldowns();

function getBlockedUntil(): number {
  return blockedUntilByBot.get(BOT_ID) ?? 0;
}

function setBlockedUntil(blockedUntil: number): void {
  blockedUntilByBot.set(BOT_ID, blockedUntil);
  saveCooldowns();
}

/** Parse Telegram's retry_after (seconds) from a Grammy/HTTP error. */
function extractRetryAfterMs(err: unknown): number | undefined {
  if (err instanceof GrammyError && err.error_code === 429) {
    const sec = err.parameters?.retry_after;
    if (typeof sec === 'number' && sec > 0) return sec * 1000;
  }
  // Fallback: parse "(429: Too Many Requests: retry after N)" out of the message.
  if (err instanceof Error) {
    const m = err.message.match(/429:[^)]*retry after (\d+)/i);
    if (m) {
      const sec = Number.parseInt(m[1], 10);
      if (Number.isFinite(sec) && sec > 0) return sec * 1000;
    }
  }
  return undefined;
}

interface NameRateState {
  lastUpdateTime: number;
  lastSentName: string | null;
  pendingName: string | null;
  pendingApiCall: ((name: string) => Promise<unknown>) | null;
  pendingTimer: ReturnType<typeof setTimeout> | null;
}

// Per-bot soft-throttle state. Keyed by the bot's `api` object (stable per
// bot) so multiple bots running in the same process don't collide on a
// shared slot. WeakMap lets state get GC'd if a bot is torn down.
const nameRateStates: WeakMap<object, NameRateState> = new WeakMap();

function getRateState(key: object): NameRateState {
  let state = nameRateStates.get(key);
  if (!state) {
    state = { lastUpdateTime: 0, lastSentName: null, pendingName: null, pendingApiCall: null, pendingTimer: null };
    nameRateStates.set(key, state);
  }
  return state;
}

async function callAndHandle429(
  state: NameRateState,
  apiCall: (name: string) => Promise<unknown>,
  name: string,
  source: string,
): Promise<void> {
  try {
    await apiCall(name);
    state.lastSentName = name;
  } catch (err) {
    const retryAfterMs = extractRetryAfterMs(err);
    if (retryAfterMs !== undefined) {
      const until = Date.now() + retryAfterMs;
      setBlockedUntil(until);
      const mins = Math.round(retryAfterMs / 60000);
      console.warn(`[BotName] ${source}: setMyName rate-limited by Telegram, blocked for ~${mins}m (until ${new Date(until).toISOString()})`);
      return;
    }
    throw err;
  }
}

/**
 * Rate-limited wrapper around `bot.api.setMyName()`.
 *
 * Two layers of throttling:
 * 1. A persistent server-side cooldown — when Telegram returns 429 with a
 *    `retry_after`, we record `now + retry_after` to disk and refuse all
 *    further calls until that timestamp passes. Survives bot restarts.
 * 2. A soft 1-minute local interval — at most one outbound call per minute
 *    per bot; if called more frequently the latest name is queued and
 *    applied when the cooldown expires.
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
  const blockedUntil = getBlockedUntil();
  const now = Date.now();
  if (blockedUntil > now) {
    const mins = Math.round((blockedUntil - now) / 60000);
    console.debug(`[BotName] Skipping setMyName — Telegram cooldown for ~${mins}m more.`);
    return;
  }

  const state = getRateState(botKey);

  // No-op if the name we already sent matches — most auto-topic calls re-emit
  // the same topic for follow-up messages, and Telegram counts those toward
  // the rate limit even though the visible name doesn't change.
  if (state.lastSentName === name) return;

  const elapsed = now - state.lastUpdateTime;

  if (elapsed >= MIN_NAME_UPDATE_INTERVAL_MS) {
    state.lastUpdateTime = now;
    state.pendingName = null;
    state.pendingApiCall = null;
    if (state.pendingTimer) { clearTimeout(state.pendingTimer); state.pendingTimer = null; }
    await callAndHandle429(state, apiCall, name, 'immediate');
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
        if (queuedName === null || !queuedCall) return;
        if (state.lastSentName === queuedName) return;
        // Re-check the persistent cooldown — it may have been set since this
        // timer was scheduled (e.g. a sibling immediate call hit 429).
        if (getBlockedUntil() > Date.now()) return;
        state.lastUpdateTime = Date.now();
        try {
          await callAndHandle429(state, queuedCall, queuedName, 'deferred');
        } catch (err) {
          console.error('[BotName] Deferred name update failed:', err instanceof Error ? err.message : err);
        }
      }, delay);
    }
  }
}
