/**
 * Setting a model or effort at a level — one thread, a chat's default, a whole
 * chat, or the whole bot — and getting the claudes it concerns onto it.
 *
 * Both are flags the CLI reads at spawn, so a change only reaches a session
 * once its pty is restarted. Which ones that is follows from the values
 * themselves: every live session whose resolved value differs before and
 * after the change. Those idle now restart on their next message; those
 * mid-turn restart when the turn ends, so nothing is cut short and nothing
 * stays on the old value until some unrelated respawn. The conversation
 * survives either way, as the next spawn resumes the same session id.
 */

import { getPtyProvider } from './claude-provider.js';
import { isInFlight, runAfterTurn } from '../claude/in-flight-tracker.js';
import { userPreferences, type SpawnSetting, type SettingLevel } from './user-preferences.js';
import { scopeChatId, type SettingsScope } from '../utils/session-key.js';

export interface SpawnSettingOutcome {
  /** Entries whose own, different pin was dropped to follow the new value. */
  dropped: string[];
  /** Idle sessions that restart on their next message. */
  restarted: string[];
  /** Sessions mid-turn, which restart when that turn ends. */
  busy: string[];
}

function read(scope: SettingsScope, field: SpawnSetting): string | undefined {
  return field === 'model' ? userPreferences.getModel(scope) : userPreferences.getEffort(scope);
}

/**
 * Apply `value` at `level` from `scope` and restart what it changed.
 * `current` is the session the command was typed in: a restart there is
 * immediate even mid-turn, as a /model there always was.
 */
export function applySpawnSetting(
  scope: SettingsScope,
  field: SpawnSetting,
  value: string | null,
  level: SettingLevel,
  current?: string,
): SpawnSettingOutcome {
  const pty = getPtyProvider();
  const live = level === 'all' ? pty.listSessionKeys() : pty.listSessionKeysForChat(scopeChatId(scope));
  const before = new Map(live.map((k) => [k, read(k, field)]));

  const dropped = userPreferences.applyLevel(scope, field, value, level);

  const restarted: string[] = [];
  const busy: string[] = [];
  for (const k of live) {
    if (read(k, field) === before.get(k)) continue;
    if (k !== current && isInFlight(k)) {
      busy.push(k);
      runAfterTurn(k, () => pty.clearConversation(k));
      continue;
    }
    pty.clearConversation(k);
    restarted.push(k);
  }
  return { dropped, restarted, busy };
}
