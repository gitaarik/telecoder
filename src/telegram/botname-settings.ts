/**
 * The bot's Telegram display name: a rate-limited `setMyName`, the startup
 * reconcile with the configured name, and the cooldown Telegram imposes.
 *
 * The name is static. It used to follow the active project (and before that
 * the topic), but Telegram throttles `setMyName` so hard that a rename could
 * silently fail and leave the wrong project showing for hours. The project is
 * in the status line and the thread names instead, and a bot made for one
 * project carries it in its name from the start (`/newbot`).
 */

import { config, BOT_ID, getBotNameSource } from '../config.js';
import * as path from 'path';
import { z } from 'zod';
import { GrammyError } from 'grammy';
import { ensureStateDir, getStateDir, readJsonFile, writeJsonFile } from '../utils/json-store.js';

const SETTINGS_DIR = getStateDir();

// ---------------------------------------------------------------------------
// Rate-limited setMyName wrapper
// ---------------------------------------------------------------------------

const MIN_NAME_UPDATE_INTERVAL_MS = 60_000; // 1 minute soft cooldown
// One file per bot, like the rest of the per-bot state. Each bot is its own
// process, and when they shared a file each one rewrote it from the copy it
// loaded at startup, undoing what the others had saved since. A wrong last-sent
// name makes a real rename look like no change, and a lost block sends a call
// Telegram has already refused. The old shared setmyname-cooldowns.json and
// setmyname-lastsent.json are deliberately not read: their entries can't be
// trusted, and starting without them costs at most one extra call per bot.
const COOLDOWN_FILE = path.join(SETTINGS_DIR, `setmyname-cooldown-${BOT_ID}.json`);
const LAST_SENT_FILE = path.join(SETTINGS_DIR, `setmyname-lastsent-${BOT_ID}.json`);

const cooldownSchema = z.object({ blockedUntil: z.number() });
const lastSentSchema = z.object({ name: z.string() });

// Persistent 429 cooldown. Telegram's setMyName limit is much stricter than our
// soft local interval, and the local state is reset on every restart — so we
// honor any retry_after Telegram returns and persist the "do not call before"
// timestamp to disk.
ensureStateDir(SETTINGS_DIR, 'BotName');
let cooldownUntil = readJsonFile(COOLDOWN_FILE, cooldownSchema, 'BotName')?.blockedUntil ?? 0;

function getBlockedUntil(): number {
  return cooldownUntil;
}

function setBlockedUntil(blockedUntil: number): void {
  cooldownUntil = blockedUntil;
  ensureStateDir(SETTINGS_DIR, 'BotName');
  writeJsonFile(COOLDOWN_FILE, { blockedUntil }, 'BotName');
}

/** When Telegram will accept a rename again, or undefined when it does now. */
export function getBotNameCooldownUntil(): number | undefined {
  const until = getBlockedUntil();
  return until > Date.now() ? until : undefined;
}

/** "~5m" or "~2h": how long a cooldown has left, for a message. */
export function formatCooldownLeft(blockedUntilMs: number): string {
  const remainingMs = Math.max(0, blockedUntilMs - Date.now());
  const mins = Math.round(remainingMs / 60000);
  return mins >= 60 ? `~${Math.round(mins / 60)}h` : `~${Math.max(mins, 1)}m`;
}

// The last successfully-sent display name, persisted to disk. The in-memory
// dedup (`state.lastSentName`) is reset on every restart, so without this the
// first name push after a restart always hits Telegram even when the name is
// unchanged. Persisting it lets the `no_change` short-circuit survive restarts.
function getPersistedLastSentName(): string | null {
  return readJsonFile(LAST_SENT_FILE, lastSentSchema, 'BotName')?.name ?? null;
}

function setPersistedLastSentName(name: string): void {
  ensureStateDir(SETTINGS_DIR, 'BotName');
  writeJsonFile(LAST_SENT_FILE, { name }, 'BotName');
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
    // Seed lastSentName from disk so the `no_change` dedup survives restarts —
    // otherwise the first push after every restart re-sends an unchanged name.
    state = { lastUpdateTime: 0, lastSentName: getPersistedLastSentName(), pendingName: null, pendingApiCall: null, pendingTimer: null };
    nameRateStates.set(key, state);
  }
  return state;
}

/**
 * Result of a rateLimitedSetMyName call.
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
  const blockedUntil = getBlockedUntil();
  const now = Date.now();
  if (blockedUntil > now) {
    const mins = Math.round((blockedUntil - now) / 60000);
    console.debug(`[BotName] Skipping setMyName — Telegram cooldown for ~${mins}m more.`);
    return { status: 'still_blocked', blockedUntilMs: blockedUntil };
  }

  const state = getRateState(botKey);

  // No-op if the name we already sent matches — Telegram counts a call that
  // changes nothing toward the rate limit all the same.
  if (state.lastSentName === name) {
    // A queued (different) name from an earlier call is now superseded — the
    // currently-desired name already matches what's shown. Cancel the stale
    // timer so it doesn't fire a wasted setMyName for a name we've moved past
    // (e.g. A→B→A within the soft interval).
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

// ---------------------------------------------------------------------------
// Landing a name Telegram refused
// ---------------------------------------------------------------------------

type NameApi = { setMyName(name: string): Promise<unknown> };

let retryTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Once the cooldown is over, send the name the bot wants by then. Read at fire
 * time, so a `/botname` given in the meantime is what lands. One timer per bot;
 * a new block replaces it.
 */
function armRetryAfterCooldown(api: NameApi, blockedUntilMs: number): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(async () => {
    retryTimer = null;
    try {
      const r = await rateLimitedSetMyName(api, (n) => api.setMyName(n), config.BOT_NAME);
      console.log(`[BotName] Retry after cooldown: ${r.status}`);
    } catch (err) {
      console.error('[BotName] Retry after cooldown failed:', err instanceof Error ? err.message : err);
    }
  }, Math.max(0, blockedUntilMs - Date.now()) + 1000);
  retryTimer.unref?.();
}

/**
 * Rename the bot on Telegram, and when Telegram refuses, try again as soon as
 * it allows. The result says which happened, for the reply to the user.
 */
export async function pushBotName(api: NameApi, name: string): Promise<SetMyNameResult> {
  const result = await rateLimitedSetMyName(api, (n) => api.setMyName(n), name);
  if (result.status === 'newly_blocked' || result.status === 'still_blocked') {
    armRetryAfterCooldown(api, result.blockedUntilMs);
  }
  return result;
}

/**
 * Reconcile the Telegram display name with the configured name once at startup.
 *
 * A `BOT_NAME` edited between runs, or a `/botname` whose cooldown retry was
 * lost to a restart, would otherwise sit invisible: nothing else renames the bot.
 *
 * Deliberately bypasses the `lastSentName` dedup in `rateLimitedSetMyName`:
 * `getMyName()` is authoritative about what Telegram actually shows, and the
 * case worth catching here is exactly the one where our cached name and the
 * live name disagree (BOT_NAME edited between runs, or a BotFather rename).
 * The persistent 429 cooldown still applies.
 *
 * Without a name of its own (neither `/botname` nor `BOT_NAME`) the name chosen
 * in BotFather is kept: the "TeleCoder" default would otherwise overwrite it on
 * a fresh install's first start.
 */
export async function syncBotNameOnStartup(api: {
  getMyName(): Promise<{ name: string }>;
  setMyName(name: string): Promise<unknown>;
}): Promise<SetMyNameResult> {
  if (getBotNameSource() === 'default') return { status: 'no_change' };

  const wanted = config.BOT_NAME;
  let current: string;
  try {
    current = (await api.getMyName()).name;
  } catch (err) {
    console.debug('[BotName] Startup sync: getMyName failed:', err instanceof Error ? err.message : err);
    return { status: 'no_change' };
  }

  if (current === wanted) return { status: 'no_change' };

  const blockedUntil = getBlockedUntil();
  const now = Date.now();
  if (blockedUntil > now) {
    const mins = Math.round((blockedUntil - now) / 60000);
    console.warn(`[BotName] Startup sync: "${current}" → "${wanted}" skipped, Telegram cooldown for ~${mins}m more.`);
    armRetryAfterCooldown(api, blockedUntil);
    return { status: 'still_blocked', blockedUntilMs: blockedUntil };
  }

  console.log(`[BotName] Startup sync: renaming "${current}" → "${wanted}"`);
  const state = getRateState(api);
  state.lastUpdateTime = now;
  const result = await callAndHandle429(state, (n) => api.setMyName(n), wanted, 'startup sync');
  if (result.kind === 'newly_blocked') {
    armRetryAfterCooldown(api, result.blockedUntilMs);
    return { status: 'newly_blocked', blockedUntilMs: result.blockedUntilMs };
  }
  return { status: 'sent' };
}
