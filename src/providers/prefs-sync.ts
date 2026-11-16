/**
 * Applying a model or effort choice on every bot instance at once — the
 * "everywhere" level of /model and /effort.
 *
 * Preferences are per-bot (see user-preferences.ts), and writing to the
 * siblings' files behind their backs would not work: every worker holds its
 * preferences in memory and would overwrite the edit on its next save, and the
 * pty reads `--model` at spawn, so a bot with a live session would go on using
 * the old one regardless.
 *
 * So the change is sent, not written. The requesting worker asks the launcher
 * to relay it; each sibling applies it through the same code path as a local
 * change at that level, restarts the claudes it concerns, and reports back
 * what it did. The requester waits for the round trip so it can tell the user
 * which bots actually took the change.
 *
 * Single-instance mode has no launcher to relay through: every function here
 * degrades to "this bot only" rather than failing.
 */

import { isMainThread, parentPort } from 'worker_threads';
import { BOT_ID } from '../config.js';
import { listSiblingBots } from '../utils/instances.js';
import { getActiveProviderName, isValidEffortLevel, type ProviderName } from './provider-router.js';
import { applySpawnSetting } from './spawn-settings.js';
import type { SettingLevel } from './user-preferences.js';

/** A setting change to apply on other instances. `value: null` clears it. */
export interface PrefsChange {
  chatId: number;
  setting: 'model' | 'effort';
  value: string | null;
  /**
   * The backend the choice was made against. Model aliases mean different
   * things on Claude and CCR, and effort is a Claude-only flag, so a sibling
   * pointed at the other backend declines rather than mis-applying it.
   */
  provider: ProviderName;
  /**
   * How far it reaches on the sibling. Only `all` is sent today; a change
   * without one comes from a worker older than levels, which meant the chat.
   */
  level?: Extract<SettingLevel, 'chat' | 'all'>;
}

/** What one sibling did with a relayed change. */
export interface PrefsApplyOutcome {
  name: string;
  status: 'applied' | 'skipped';
  reason?: string;
  /** Sessions mid-turn, which pick the change up when that turn ends. */
  busy?: number;
}

export interface PrefsBroadcastResult {
  applied: PrefsApplyOutcome[];
  skipped: PrefsApplyOutcome[];
  /** Configured bots the launcher has no live worker for. */
  unreachable: string[];
  /** False in single-instance mode, where there are no siblings to reach. */
  multiInstance: boolean;
  /**
   * The launcher never answered — it predates this message type, or it is
   * wedged. Distinguished from `unreachable` because those bots are running
   * fine; it's the relay between us that isn't.
   */
  timedOut?: boolean;
}

/** Bots other than this one, from instances.json. Empty in single-bot setups. */
export function siblingBotNames(): string[] {
  if (isMainThread) return [];
  return listSiblingBots(BOT_ID).map((b) => b.name);
}

// ---------------------------------------------------------------------------
// Applying a change locally (the receiving side)
// ---------------------------------------------------------------------------

/**
 * Apply a relayed change to this instance, at the level it was made, and
 * restart the claudes it concerns: idle ones on their next message, mid-turn
 * ones when that turn ends. The count of the latter comes back so the
 * confirmation can say so.
 */
export function applyPrefsChange(change: PrefsChange): PrefsApplyOutcome {
  const { chatId } = change;

  const active = getActiveProviderName(chatId);
  if (active !== change.provider) {
    return { name: '', status: 'skipped', reason: `on ${active}, not ${change.provider}` };
  }

  if (change.setting === 'effort' && change.value !== null && !isValidEffortLevel(change.value)) {
    return { name: '', status: 'skipped', reason: `unknown effort level "${change.value}"` };
  }

  const outcome = applySpawnSetting(chatId, change.setting, change.value, change.level ?? 'chat');
  return { name: '', status: 'applied', busy: outcome.busy.length };
}

// ---------------------------------------------------------------------------
// Worker ↔ launcher protocol
// ---------------------------------------------------------------------------

interface ApplyMessage {
  type?: string;
  requestId?: string;
  change?: PrefsChange;
  applied?: PrefsApplyOutcome[];
  skipped?: PrefsApplyOutcome[];
  unreachable?: string[];
}

/**
 * Listen for changes relayed from sibling bots. Called once at startup; a
 * no-op outside multi-instance mode, where nothing can relay to us.
 */
export function initPrefsSync(): void {
  if (isMainThread || !parentPort) return;
  const pp = parentPort;

  pp.on('message', (msg: ApplyMessage) => {
    if (msg?.type !== 'prefs_apply' || !msg.change || !msg.requestId) return;
    let outcome: PrefsApplyOutcome;
    try {
      outcome = applyPrefsChange(msg.change);
    } catch (err) {
      outcome = {
        name: '',
        status: 'skipped',
        reason: err instanceof Error ? err.message : 'failed to apply',
      };
    }
    const { setting, value } = msg.change;
    console.log(`[PrefsSync] ${outcome.status} relayed ${setting}=${value ?? 'default'} for chat ${msg.change.chatId}${outcome.reason ? ` (${outcome.reason})` : ''}`);
    pp.postMessage({ type: 'prefs_apply_result', requestId: msg.requestId, ...outcome });
  });
}

let requestCounter = 0;

/**
 * How long to wait for the launcher's aggregate reply. Each sibling's work is
 * a couple of synchronous file writes plus a pty kill, so the only thing this
 * really covers is a worker too busy to service its message queue — and one
 * that unresponsive is better reported as unreachable than waited on.
 */
const BROADCAST_TIMEOUT_MS = 5000;

/**
 * Ask every other instance to apply `change`. Resolves once they have all
 * answered, or on timeout with whatever came back by then.
 */
export function broadcastPrefsChange(change: PrefsChange): Promise<PrefsBroadcastResult> {
  return new Promise((resolve) => {
    if (isMainThread || !parentPort) {
      resolve({ applied: [], skipped: [], unreachable: [], multiInstance: false });
      return;
    }

    const pp = parentPort;
    const requestId = `${BOT_ID}-${++requestCounter}`;

    const handler = (msg: ApplyMessage) => {
      if (msg?.type !== 'prefs_broadcast_result' || msg.requestId !== requestId) return;
      pp.off('message', handler);
      clearTimeout(timer);
      resolve({
        applied: msg.applied ?? [],
        skipped: msg.skipped ?? [],
        unreachable: msg.unreachable ?? [],
        multiInstance: true,
      });
    };

    pp.on('message', handler);
    pp.postMessage({ type: 'prefs_broadcast', requestId, change });

    const timer = setTimeout(() => {
      pp.off('message', handler);
      // A launcher too old to know this message type never answers at all.
      console.warn('[PrefsSync] Launcher did not answer the preference broadcast — is it running current code?');
      resolve({ applied: [], skipped: [], unreachable: [], multiInstance: true, timedOut: true });
    }, BROADCAST_TIMEOUT_MS);
  });
}
