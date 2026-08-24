/**
 * Applying one chat's model or effort choice to every bot instance at once.
 *
 * Preferences are per-bot (see user-preferences.ts), which is the right default
 * — but "put all my bots on Haiku" is a real thing to want, and writing to the
 * siblings' files behind their backs would not work: every worker holds its
 * preferences in memory and would overwrite the edit on its next save, and the
 * pty reads `--model` at spawn, so a bot with a live session would go on using
 * the old one regardless.
 *
 * So the change is sent, not written. The requesting worker asks the launcher
 * to relay it; each sibling applies it through the same code path as a local
 * /model, tears down the pty sessions for that chat so the next turn respawns
 * with the new flag, and reports back what it did. The requester waits for the
 * round trip so it can tell the user which bots actually took the change.
 *
 * Single-instance mode has no launcher to relay through: every function here
 * degrades to "this bot only" rather than failing.
 */

import { isMainThread, parentPort } from 'worker_threads';
import { BOT_ID } from '../config.js';
import { isInFlight } from '../claude/in-flight-tracker.js';
import { listSiblingBots } from '../utils/instances.js';
import { getPtyProvider } from './claude-provider.js';
import {
  setModel,
  clearModel,
  setEffort,
  clearEffort,
  getActiveProviderName,
  isValidEffortLevel,
  type EffortLevel,
  type ProviderName,
} from './provider-router.js';
import { userPreferences } from './user-preferences.js';

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
}

/** What one sibling did with a relayed change. */
export interface PrefsApplyOutcome {
  name: string;
  status: 'applied' | 'skipped';
  reason?: string;
  /** Sessions left running because a turn was in flight — see applyPrefsChange. */
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
 * Apply a relayed change to this instance.
 *
 * Goes through provider-router rather than the preferences file directly, so
 * the in-memory caches that actually serve the next turn are updated too.
 *
 * A pty holding a session that is mid-turn is left alone: killing it would
 * abort a turn nobody in this chat asked to interrupt, and the user isn't
 * watching that bot — they're in the one they typed the command into. Those
 * sessions keep the old value until they next respawn, and the count comes
 * back so the confirmation can say so.
 */
export function applyPrefsChange(change: PrefsChange): PrefsApplyOutcome {
  const { chatId } = change;

  const active = getActiveProviderName(chatId);
  if (active !== change.provider) {
    return { name: '', status: 'skipped', reason: `on ${active}, not ${change.provider}` };
  }

  if (change.setting === 'model') {
    if (change.value === null) clearModel(chatId);
    else setModel(chatId, change.value);
  } else {
    if (change.value === null) {
      clearEffort(chatId);
    } else if (isValidEffortLevel(change.value)) {
      setEffort(chatId, change.value as EffortLevel);
    } else {
      return { name: '', status: 'skipped', reason: `unknown effort level "${change.value}"` };
    }
  }

  return { name: '', status: 'applied', busy: restartPtySessionsForChat(chatId) };
}

/**
 * Tear down this chat's idle pty sessions so the next turn respawns with the
 * new flag. Returns how many were left running because they were mid-turn.
 * No-op unless this chat actually runs on the pty transport.
 */
function restartPtySessionsForChat(chatId: number): number {
  if (getActiveProviderName(chatId) !== 'claude') return 0;
  if (userPreferences.getMethod(chatId) !== 'pty') return 0;

  const pty = getPtyProvider();
  let busy = 0;
  for (const sessionKey of pty.listSessionKeysForChat(chatId)) {
    if (isInFlight(sessionKey)) {
      busy++;
      continue;
    }
    pty.clearConversation(sessionKey);
  }
  return busy;
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
