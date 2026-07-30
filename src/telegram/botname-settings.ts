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
import { GrammyError, type Context } from 'grammy';

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
const LAST_SENT_FILE = path.join(SETTINGS_DIR, 'setmyname-lastsent.json');

const cooldownsSchema = z.object({
  cooldowns: z.record(z.string(), z.object({ blockedUntil: z.number() })),
});

const lastSentSchema = z.object({
  names: z.record(z.string(), z.string()),
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

// Per-bot last successfully-sent display name, persisted to disk. The in-memory
// dedup (`state.lastSentName`) is reset on every restart, so without this the
// first name push after a restart always hits Telegram even when the name is
// unchanged — and since the topic moved to the status line the name is now
// effectively static, making nearly every post-restart push a wasted quota
// slot. Persisting it lets the `no_change` short-circuit survive restarts.
const lastSentNameByBot: Map<string, string> = new Map();

function loadLastSentNames(): void {
  ensureDirectory();
  if (!fs.existsSync(LAST_SENT_FILE)) return;
  try {
    const raw = fs.readFileSync(LAST_SENT_FILE, 'utf-8');
    const result = lastSentSchema.safeParse(JSON.parse(raw));
    if (!result.success) {
      console.warn('[BotName] Invalid last-sent file, starting fresh:', result.error.message);
      return;
    }
    for (const [botId, name] of Object.entries(result.data.names)) {
      lastSentNameByBot.set(botId, name);
    }
  } catch (err) {
    console.error('[BotName] Failed to load last-sent names:', err);
  }
}

function saveLastSentNames(): void {
  ensureDirectory();
  const names: Record<string, string> = {};
  for (const [botId, name] of lastSentNameByBot.entries()) {
    names[botId] = name;
  }
  try {
    atomicWriteFileSync(LAST_SENT_FILE, JSON.stringify({ names }, null, 2), { mode: 0o600 });
  } catch (err) {
    console.error('[BotName] Failed to save last-sent names:', err);
  }
}

loadLastSentNames();

function getPersistedLastSentName(): string | null {
  return lastSentNameByBot.get(BOT_ID) ?? null;
}

function setPersistedLastSentName(name: string): void {
  if (lastSentNameByBot.get(BOT_ID) === name) return;
  lastSentNameByBot.set(BOT_ID, name);
  saveLastSentNames();
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

// Set as soon as anything in this process asks for a name update. The startup
// sync uses it to tell "nobody has claimed the display name yet" from
// "auto-resume already pushed a name built from BOT_NAME" — in the latter case
// the name is current by construction and re-checking it would race against a
// deferred (soft-throttled) push that hasn't reached Telegram yet.
let nameClaimedThisProcess = false;

// Per-bot soft-throttle state. Keyed by the bot's `api` object (stable per
// bot) so multiple bots running in the same process don't collide on a
// shared slot. WeakMap lets state get GC'd if a bot is torn down.
const nameRateStates: WeakMap<object, NameRateState> = new WeakMap();

function getRateState(key: object): NameRateState {
  let state = nameRateStates.get(key);
  if (!state) {
    // Seed lastSentName from disk so the `no_change` dedup survives restarts —
    // otherwise the first push after every restart re-sends an unchanged name.
    state = { lastUpdateTime: 0, lastSentName: getPersistedLastSentName(), pendingName: null, pendingApiCall: null, pendingTimer: null };
    nameRateStates.set(key, state);
  }
  return state;
}

/**
 * Result of a rateLimitedSetMyName call. Callers with a chat context can pass
 * this to `notifyBotNameBlock` to surface 429-induced cooldowns to the user.
 *
 * - 'sent': Telegram accepted the update (immediate path).
 * - 'queued': Soft-throttled; will fire from the deferred timer within ~60s.
 * - 'no_change': Name unchanged from the last successful send — skipped.
 * - 'newly_blocked': Telegram returned 429 on THIS call; a new cooldown is now
 *   in effect. `blockedUntilMs` is the unix-ms timestamp at which calls resume.
 * - 'still_blocked': A prior 429 cooldown is still active; we didn't even try.
 */
export type SetMyNameResult =
  | { status: 'sent' }
  | { status: 'queued' }
  | { status: 'no_change' }
  | { status: 'newly_blocked'; blockedUntilMs: number }
  | { status: 'still_blocked'; blockedUntilMs: number };

async function callAndHandle429(
  state: NameRateState,
  apiCall: (name: string) => Promise<unknown>,
  name: string,
  source: string,
): Promise<{ kind: 'sent' } | { kind: 'newly_blocked'; blockedUntilMs: number }> {
  try {
    await apiCall(name);
    state.lastSentName = name;
    setPersistedLastSentName(name);
    return { kind: 'sent' };
  } catch (err) {
    const retryAfterMs = extractRetryAfterMs(err);
    if (retryAfterMs !== undefined) {
      const until = Date.now() + retryAfterMs;
      setBlockedUntil(until);
      const mins = Math.round(retryAfterMs / 60000);
      console.warn(`[BotName] ${source}: setMyName rate-limited by Telegram, blocked for ~${mins}m (until ${new Date(until).toISOString()})`);
      return { kind: 'newly_blocked', blockedUntilMs: until };
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
): Promise<SetMyNameResult> {
  nameClaimedThisProcess = true;
  const blockedUntil = getBlockedUntil();
  const now = Date.now();
  if (blockedUntil > now) {
    const mins = Math.round((blockedUntil - now) / 60000);
    console.debug(`[BotName] Skipping setMyName — Telegram cooldown for ~${mins}m more.`);
    return { status: 'still_blocked', blockedUntilMs: blockedUntil };
  }

  const state = getRateState(botKey);

  // No-op if the name we already sent matches — most auto-topic calls re-emit
  // the same topic for follow-up messages, and Telegram counts those toward
  // the rate limit even though the visible name doesn't change.
  if (state.lastSentName === name) {
    // A queued (different) name from an earlier switch is now superseded — the
    // currently-desired name already matches what's shown. Cancel the stale
    // timer so it doesn't fire a wasted setMyName for a name we've moved past
    // (e.g. switch A→B→A within the soft interval).
    if (state.pendingTimer) { clearTimeout(state.pendingTimer); state.pendingTimer = null; }
    state.pendingName = null;
    state.pendingApiCall = null;
    return { status: 'no_change' };
  }

  const elapsed = now - state.lastUpdateTime;

  if (elapsed >= MIN_NAME_UPDATE_INTERVAL_MS) {
    state.lastUpdateTime = now;
    state.pendingName = null;
    state.pendingApiCall = null;
    if (state.pendingTimer) { clearTimeout(state.pendingTimer); state.pendingTimer = null; }
    const r = await callAndHandle429(state, apiCall, name, 'immediate');
    if (r.kind === 'newly_blocked') {
      return { status: 'newly_blocked', blockedUntilMs: r.blockedUntilMs };
    }
    return { status: 'sent' };
  }

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
  return { status: 'queued' };
}

/**
 * Reconcile the Telegram display name with `BOT_NAME` once at startup.
 *
 * Every other `setMyName` path is event-driven (project switch, topic
 * clear/restore, `/botname` toggle), so a `BOT_NAME` change in `instances.json`
 * used to sit invisible until one of those fired — a rebrand could leave the
 * old name showing for days.
 *
 * Deliberately bypasses the `lastSentName` dedup in `rateLimitedSetMyName`:
 * `getMyName()` is authoritative about what Telegram actually shows, and the
 * case worth catching here is exactly the one where our cached name and the
 * live name disagree (BOT_NAME edited between runs, or a BotFather rename).
 * The persistent 429 cooldown still applies.
 */
export async function syncBotNameOnStartup(api: {
  getMyName(): Promise<{ name: string }>;
  setMyName(name: string): Promise<unknown>;
}): Promise<SetMyNameResult> {
  if (nameClaimedThisProcess) return { status: 'no_change' };

  const base = config.BOT_NAME;
  let current: string;
  try {
    current = (await api.getMyName()).name;
  } catch (err) {
    console.debug('[BotName] Startup sync: getMyName failed:', err instanceof Error ? err.message : err);
    return { status: 'no_change' };
  }

  // Dynamic names carry a " — project" suffix. Anything already rooted at
  // BOT_NAME is in sync; rewriting it to the bare base would clobber the
  // project the user last switched to.
  if (current === base || current.startsWith(`${base} — `)) return { status: 'no_change' };

  const blockedUntil = getBlockedUntil();
  const now = Date.now();
  if (blockedUntil > now) {
    const mins = Math.round((blockedUntil - now) / 60000);
    console.warn(`[BotName] Startup sync: "${current}" → "${base}" skipped, Telegram cooldown for ~${mins}m more.`);
    return { status: 'still_blocked', blockedUntilMs: blockedUntil };
  }

  console.log(`[BotName] Startup sync: renaming "${current}" → "${base}"`);
  const state = getRateState(api);
  state.lastUpdateTime = now;
  const result = await callAndHandle429(state, (n) => api.setMyName(n), base, 'startup sync');
  if (result.kind === 'newly_blocked') {
    return { status: 'newly_blocked', blockedUntilMs: result.blockedUntilMs };
  }
  nameClaimedThisProcess = true;
  return { status: 'sent' };
}

// ---------------------------------------------------------------------------
// Cooldown notification (surface 429 blackouts to the user)
// ---------------------------------------------------------------------------

// Dedup keyed on `${BOT_ID}:${chatId}:${blockedUntilMs}` so a fresh 429
// (different blockedUntilMs) re-notifies, but repeated drops inside the same
// cooldown window do not. Lives in-memory only — after restart, the cooldown
// reloads from disk and the next attempt re-notifies, which is fine UX.
const notifiedCooldowns = new Set<string>();

function makeCooldownKey(chatId: number, blockedUntilMs: number): string {
  return `${BOT_ID}:${chatId}:${blockedUntilMs}`;
}

function formatCooldownMessage(blockedUntilMs: number): string {
  const remainingMs = Math.max(0, blockedUntilMs - Date.now());
  const mins = Math.round(remainingMs / 60000);
  const when = mins >= 60
    ? `~${Math.round(mins / 60)}h`
    : `~${Math.max(mins, 1)}m`;
  return `⚠️ Bot name update skipped — Telegram rate-limited setMyName. Will retry in ${when}.`;
}

/**
 * Shared dedup gate: returns true exactly once per (bot, chat, cooldown window)
 * so multiple dropped updates inside the same window stay quiet.
 */
function shouldNotifyCooldown(chatId: number, blockedUntilMs: number): boolean {
  const key = makeCooldownKey(chatId, blockedUntilMs);
  if (notifiedCooldowns.has(key)) return false;
  notifiedCooldowns.add(key);
  return true;
}

/**
 * If `result` indicates a 429 cooldown, send a one-time notice to the chat in
 * `ctx`. Deduped per (bot, chat, cooldown window) so repeated dropped updates
 * inside the same window don't spam the user.
 */
export async function notifyBotNameBlock(ctx: Context, result: SetMyNameResult): Promise<void> {
  if (result.status !== 'newly_blocked' && result.status !== 'still_blocked') return;
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  if (!shouldNotifyCooldown(chatId, result.blockedUntilMs)) return;

  try {
    await ctx.reply(formatCooldownMessage(result.blockedUntilMs));
  } catch (err) {
    console.debug('[BotName] Failed to send cooldown notice:', err instanceof Error ? err.message : err);
  }
}

/**
 * Same as `notifyBotNameBlock` but takes a raw `bot.api` reference plus chat /
 * thread IDs — for paths that don't have a grammy `Context` (e.g. auto-resume
 * loops over sessions and sends through `bot.api.sendMessage`).
 */
export async function notifyBotNameBlockToChat(
  api: { sendMessage(chatId: number, text: string, options?: { message_thread_id?: number }): Promise<unknown> },
  chatId: number,
  result: SetMyNameResult,
  threadId?: number,
): Promise<void> {
  if (result.status !== 'newly_blocked' && result.status !== 'still_blocked') return;
  if (!shouldNotifyCooldown(chatId, result.blockedUntilMs)) return;

  try {
    const opts = threadId !== undefined ? { message_thread_id: threadId } : undefined;
    await api.sendMessage(chatId, formatCooldownMessage(result.blockedUntilMs), opts);
  } catch (err) {
    console.debug('[BotName] Failed to send cooldown notice:', err instanceof Error ? err.message : err);
  }
}
