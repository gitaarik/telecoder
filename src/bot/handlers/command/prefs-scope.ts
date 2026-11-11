/**
 * The "just this bot, or all of them?" half of /model and /effort.
 *
 * Both settings are per-bot, and that stays the default: it is the answer that
 * matches how the rest of a multi-bot setup already behaves, and it is the one
 * you can undo by typing the command again. Fleet-wide is a deliberate extra —
 * a trailing `all` on the command, or one tap on the confirmation — so the
 * common case never grows a question it has to answer.
 *
 * Nothing here is offered in a single-bot setup: with no siblings the choice
 * has exactly one answer, and asking it would be noise.
 */

import { Context } from 'grammy';
import { EntityText, type EntityMessage } from '../../../telegram/entities.js';
import { editCallbackMessage } from '../../../telegram/send.js';
import {
  broadcastPrefsChange,
  siblingBotNames,
  type PrefsChange,
  type PrefsBroadcastResult,
} from '../../../providers/prefs-sync.js';
import { getActiveProviderName, getAvailableModels } from '../../../providers/provider-router.js';
import { config } from '../../../config.js';
import { getSessionKeyFromCtx, type SettingsScope } from '../../../utils/session-key.js';
import { EFFORT_LEVELS, needsPtyRestart, PTY_RESTART_NOTE } from './shared.js';

export type PrefsScope = 'this' | 'all';

/** Callback-data prefix for the "apply to all bots" button. */
export const PREFS_ALL_PREFIX = 'prefs_all:';

/** Telegram's hard cap on callback_data. */
const CALLBACK_DATA_MAX_BYTES = 64;

/**
 * Split a trailing scope word off a command argument.
 *
 * `/model sonnet all` → `{ value: 'sonnet', scope: 'all' }`. The word is only
 * taken as a scope when something precedes it, so `/model all` still reaches
 * the normal "is that a model?" path rather than silently becoming a no-op
 * broadcast of nothing.
 */
export function parseScopeArg(raw: string): { value: string; scope: PrefsScope } {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { value: raw.trim(), scope: 'this' };

  const last = parts[parts.length - 1].toLowerCase();
  if (last === 'all' || last === 'everywhere') {
    return { value: parts.slice(0, -1).join(' '), scope: 'all' };
  }
  if (last === 'this' || last === 'here' || last === 'one') {
    return { value: parts.slice(0, -1).join(' '), scope: 'this' };
  }
  return { value: raw.trim(), scope: 'this' };
}

/**
 * The one-tap offer appended to a local confirmation. Undefined when there are
 * no other bots, or when the value is long enough that the callback data
 * wouldn't fit — the typed `all` form still works in that case.
 */
export function buildApplyToAllKeyboard(
  setting: PrefsChange['setting'],
  value: string,
): { text: string; callback_data: string }[][] | undefined {
  const siblings = siblingBotNames();
  if (siblings.length === 0) return undefined;

  const data = `${PREFS_ALL_PREFIX}${setting}:${value}`;
  if (Buffer.byteLength(data, 'utf8') > CALLBACK_DATA_MAX_BYTES) return undefined;

  return [[{ text: `🌐 Apply to all ${siblings.length + 1} bots`, callback_data: data }]];
}

/**
 * Relay a change to the other instances and describe what happened, as a
 * block (opening with a blank line) to append to the local confirmation.
 */
export async function applyToAllBots(change: PrefsChange): Promise<EntityMessage> {
  const result = await broadcastPrefsChange(change);
  return formatBroadcastResult(result);
}

/** Render a broadcast outcome. Exported for tests. */
export function formatBroadcastResult(result: PrefsBroadcastResult): EntityMessage {
  const nothingElse = new EntityText()
    .add('\n\n')
    .italic('This is the only bot running, so there was nothing else to apply it to.')
    .build();
  if (!result.multiInstance) return nothingElse;

  if (result.timedOut) {
    return new EntityText()
      .add('\n\n⚠️ The launcher didn\'t answer, so the other bots were ')
      .bold('not')
      .add(' changed. It may be running code from before fleet-wide settings existed — /restartbot all picks it up.')
      .build();
  }

  // A launcher with a one-instance config: multi-instance plumbing, nobody on
  // the other end of it.
  if (result.applied.length + result.skipped.length + result.unreachable.length === 0) {
    return nothingElse;
  }

  // Each line opens with its own newline; this one more sets the block off
  // from the confirmation with a blank line.
  const b = new EntityText().add('\n');

  if (result.applied.length > 0) {
    const names = result.applied.map((o) => o.name).join(', ');
    b.add('\n🌐 Also applied to ')
      .bold(String(result.applied.length))
      .add(` other bot${result.applied.length === 1 ? '' : 's'}: ${names}`);

    // A bot mid-turn keeps its running session on the old value; say so rather
    // than let the next answer from it look like the setting didn't take.
    const busy = result.applied.filter((o) => (o.busy ?? 0) > 0);
    if (busy.length > 0) {
      b.add('\n').italic(
        `${busy.map((o) => o.name).join(', ')} ${busy.length === 1 ? 'is' : 'are'} mid-turn — ` +
        'the running session keeps the old value until it restarts.',
      );
    }
  } else {
    b.add('\n🌐 No other bot took the change.');
  }

  for (const o of result.skipped) {
    b.add('\n⚠️ Not applied to ').bold(o.name).add(`${o.reason ? ` — ${o.reason}` : ''}.`);
  }

  if (result.unreachable.length > 0) {
    b.add(`\n⚠️ Not running, so unchanged: ${result.unreachable.join(', ')}.`);
  }

  return b.build();
}

/**
 * Whether a confirmation should name the bot it applied to. Pointless when
 * there is only one.
 */
export function hasSiblings(): boolean {
  return siblingBotNames().length > 0;
}

/**
 * "✅ Model set to **opus**", plus " for **TeleCoder 2**" once there is more
 * than one bot it could have meant. Shared so the confirmation reads the same
 * whether it was typed, tapped, or rebuilt after a fan-out.
 */
export function prefsConfirmation(setting: PrefsChange['setting'], displayLabel: string): EntityMessage {
  const what = setting === 'model' ? 'Model set to' : 'Effort set to';
  return withBotName(new EntityText().add(`✅ ${what} `).bold(displayLabel)).build();
}

/** The confirmation for clearing the effort preference, worded like {@link prefsConfirmation}. */
export function effortResetConfirmation(): EntityMessage {
  return withBotName(new EntityText().add('✅ Effort reset to ').bold('auto').add(' (CLI default)')).build();
}

/** " for **<bot>**" when there are siblings it could be confused with. */
function withBotName(b: EntityText): EntityText {
  return hasSiblings() ? b.add(' for ').bold(config.BOT_NAME) : b;
}

/** Human-readable name for a value, matching what the pickers show. */
async function describeValue(
  scope: SettingsScope,
  setting: PrefsChange['setting'],
  value: string | null,
): Promise<string> {
  if (setting === 'effort') {
    if (value === null) return 'auto';
    return EFFORT_LEVELS.find((l) => l.id === value)?.label ?? value;
  }
  if (value === null) return 'default';
  const models = await getAvailableModels(scope);
  return models.find((m) => m.id === value)?.label ?? value;
}

/**
 * The "apply to all bots" button under a /model or /effort confirmation. The
 * local change already happened when that message was sent; this only fans it
 * out, then rewrites the message with what each bot did.
 */
export async function handlePrefsAllCallback(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  const data = ctx.callbackQuery?.data;
  if (!keyInfo || !data?.startsWith(PREFS_ALL_PREFIX)) return;
  const { chatId, sessionKey } = keyInfo;

  const rest = data.slice(PREFS_ALL_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep === -1) return;
  const setting = rest.slice(0, sep);
  const raw = rest.slice(sep + 1);
  if (setting !== 'model' && setting !== 'effort') return;

  // 'auto' is how the effort picker spells "no preference"; there is no such
  // spelling for a model, so only effort can carry a null through the button.
  const value = setting === 'effort' && raw === 'auto' ? null : raw;

  await ctx.answerCallbackQuery({ text: 'Applying to all bots…' });
  // Drop the button first: the broadcast takes a round trip, and a second tap
  // would fan the same change out again.
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
  } catch {
    // ignore — the message may already have been edited
  }

  const change: PrefsChange = {
    chatId,
    setting,
    value,
    provider: getActiveProviderName(sessionKey),
  };

  const label = await describeValue(sessionKey, setting, value);
  const confirmation = value === null && setting === 'effort'
    ? effortResetConfirmation()
    : prefsConfirmation(setting, label);
  const summary = await applyToAllBots(change);

  const message = new EntityText().append(confirmation);
  if (needsPtyRestart(sessionKey)) message.append(PTY_RESTART_NOTE);
  await editCallbackMessage(ctx, message.append(summary).build());
}
