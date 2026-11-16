/**
 * How far a /model or /effort choice reaches: this thread, this thread and
 * new ones, every thread in this chat, or every chat on every bot.
 *
 * A bare command or a picker tap sets the thread it's in: the cheap case, and
 * the one undone by typing the command again. The wider levels are a word on
 * the command (`/model sonnet new`, `… chat`, `… all`) or a tap on the
 * confirmation, which offers each level wider than the one just applied. In
 * the "All" view, where Telegram opens a fresh thread for whatever is typed,
 * the bare command sets the chat's default instead (see all-view.ts).
 *
 * A wider level drops the narrower pins it covers, so one "everywhere" brings
 * every thread back in line, forks of pinned threads included. "New threads"
 * is the exception: it leaves threads that chose their own model alone.
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
import { getActiveProviderName, getAvailableModels, isValidEffortLevel } from '../../../providers/provider-router.js';
import { applySpawnSetting, type SpawnSettingOutcome } from '../../../providers/spawn-settings.js';
import {
  userPreferences,
  type SettingLevel,
  type SpawnSetting,
} from '../../../providers/user-preferences.js';
import { isPassthroughModelId } from '../../../claude/model-catalog.js';
import { threadDisplayName } from '../../../telegram/thread-titles.js';
import { isAdmin } from '../../../utils/admins.js';
import { config } from '../../../config.js';
import { getSessionKeyFromCtx, parseSessionKey, type SettingsScope } from '../../../utils/session-key.js';
import { EFFORT_LEVELS, PTY_RESTART_NOTE } from './shared.js';
import { isFreshAllViewThread } from './all-view.js';

export type { SettingLevel };

/** Callback-data prefix for the widen-the-scope buttons. */
export const PREFS_SCOPE_PREFIX = 'pscope:';
/** The single "apply to all bots" button of earlier builds, still on old messages. */
export const LEGACY_PREFS_ALL_PREFIX = 'prefs_all:';

/** Telegram's hard cap on callback_data. */
const CALLBACK_DATA_MAX_BYTES = 64;

const LEVEL_WORDS: Record<string, SettingLevel> = {
  this: 'thread',
  here: 'thread',
  one: 'thread',
  thread: 'thread',
  new: 'default',
  default: 'default',
  chat: 'chat',
  threads: 'chat',
  all: 'all',
  everywhere: 'all',
};

const LEVEL_ORDER: SettingLevel[] = ['thread', 'default', 'chat', 'all'];

/**
 * Split a trailing level word off a command argument.
 *
 * `/model sonnet chat` → `{ value: 'sonnet', level: 'chat' }`. The word is
 * only taken as a level when something precedes it, so `/model all` still
 * reaches the "that needs a model" path and `/effort default` stays the
 * effort reset it always was. No word leaves `level` undefined, for the
 * caller to decide (see resolveLevel).
 */
export function parseScopeArg(raw: string): { value: string; level?: SettingLevel } {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { value: raw.trim() };

  const level = LEVEL_WORDS[parts[parts.length - 1].toLowerCase()];
  if (!level) return { value: raw.trim() };
  return { value: parts.slice(0, -1).join(' '), level };
}

/** Whether `word` is a level word typed on its own, with no value before it. */
export function isBareLevelWord(word: string): boolean {
  return word.toLowerCase() in LEVEL_WORDS && LEVEL_WORDS[word.toLowerCase()] !== 'thread';
}

/** Where the update came from, as far as the wording and the buttons care. */
export interface ScopeSite {
  /** In a thread or forum topic, rather than a chat without threads. */
  inThread: boolean;
  /** In a fresh thread opened from the "All" view. */
  allView: boolean;
  /** May set every chat. */
  admin: boolean;
}

export function scopeSite(ctx: Context): ScopeSite {
  const keyInfo = getSessionKeyFromCtx(ctx);
  return {
    inThread: keyInfo?.threadId !== undefined,
    allView: isFreshAllViewThread(ctx),
    admin: isAdmin(ctx.from?.id),
  };
}

/** " on **<bot>**" when there are siblings it could be confused with. */
function withBotName(b: EntityText): EntityText {
  return hasSiblings() ? b.add(' on ').bold(config.BOT_NAME) : b;
}

/** Where a level reaches, worded for where it was applied from. */
function levelPhrase(level: SettingLevel, site: Pick<ScopeSite, 'inThread' | 'allView'>): string {
  switch (level) {
    case 'all':
      return 'everywhere';
    case 'chat':
      return 'for every thread in this chat';
    case 'default':
      if (site.allView) return 'for new threads in this chat';
      return site.inThread ? 'for this thread and new threads in this chat' : 'in this chat';
    case 'thread':
      return site.inThread ? 'in this thread' : 'in this chat';
  }
}

/**
 * "✅ Model set to **opus** in this thread", plus " on **TeleCoder 2**" once
 * there is more than one bot it could have meant. Everywhere names no bot:
 * the summary under it lists them.
 */
export function prefsConfirmation(
  setting: SpawnSetting,
  displayLabel: string,
  level: SettingLevel = 'thread',
  site: Pick<ScopeSite, 'inThread' | 'allView'> = { inThread: true, allView: false },
): EntityMessage {
  const what = setting === 'model' ? 'Model set to' : 'Effort set to';
  const b = new EntityText().add(`✅ ${what} `).bold(displayLabel).add(` ${levelPhrase(level, site)}`);
  return (level === 'all' ? b : withBotName(b)).build();
}

const MAX_NAMED_THREADS = 5;

function threadNames(keys: string[]): string {
  const names = keys.map((k) => threadDisplayName(k) ?? `thread ${parseSessionKey(k).threadId ?? k}`);
  if (names.length <= MAX_NAMED_THREADS) return names.join(', ');
  return `${names.slice(0, MAX_NAMED_THREADS).join(', ')} and ${names.length - MAX_NAMED_THREADS} more`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * What a change did beyond the setting itself: pins it replaced or left
 * alone, and which claudes restart when. A block that opens with a blank
 * line, empty when there is nothing to say.
 */
export function describeOutcome(
  outcome: SpawnSettingOutcome,
  opts: { level: SettingLevel; current: string; keptPins: string[] },
): EntityMessage {
  const b = new EntityText();
  const { level, current, keptPins } = opts;

  if (level === 'chat' && outcome.dropped.length > 0) {
    b.add('\n\n').add(`Now following it instead of their own choice: ${threadNames(outcome.dropped)}.`);
  } else if (level === 'all' && outcome.dropped.length > 0) {
    b.add('\n\n').add(`${plural(outcome.dropped.length, 'thread or chat', 'threads and chats')} that had chosen their own follow it now.`);
  }
  if (keptPins.length > 0) {
    b.add('\n\n').add(`${plural(keptPins.length, 'thread')} chose their own and keep it: ${threadNames(keptPins)}. `)
      .bold('All threads here').add(' sets those too.');
  }

  const others = outcome.restarted.filter((k) => k !== current);
  if (outcome.restarted.includes(current) && others.length === 0) {
    b.append(PTY_RESTART_NOTE);
  } else if (outcome.restarted.length > 0) {
    b.add('\n\n').italic(
      `Claude Code restarts in ${plural(outcome.restarted.length, 'thread')} on the next message there (the conversations are kept).`,
    );
  }
  if (outcome.busy.length > 0) {
    b.add('\n\n').italic(
      `${plural(outcome.busy.length, 'thread is', 'threads are')} mid-turn and switch${outcome.busy.length === 1 ? 'es' : ''} when that turn ends.`,
    );
  }
  return b.build();
}

/**
 * Buttons for every level wider than the one just applied that means
 * something here, plus a way to remove the empty thread the "All" view
 * opened. Undefined when there is nothing to offer.
 */
export function buildWidenKeyboard(
  setting: SpawnSetting,
  buttonValue: string,
  level: SettingLevel,
  site: ScopeSite,
): { text: string; callback_data: string }[][] | undefined {
  const wider = LEVEL_ORDER.slice(LEVEL_ORDER.indexOf(level) + 1);
  const buttons: { text: string; callback_data: string }[] = [];
  const offer = (l: SettingLevel, text: string): void => {
    const data = `${PREFS_SCOPE_PREFIX}${l}:${setting}:${buttonValue}`;
    if (Buffer.byteLength(data, 'utf8') > CALLBACK_DATA_MAX_BYTES) return;
    buttons.push({ text, callback_data: data });
  };

  if (wider.includes('default') && site.inThread && !site.allView) offer('default', '🆕 New threads too');
  if (wider.includes('chat') && (site.inThread || site.allView)) offer('chat', '🧵 All threads here');
  if (wider.includes('all') && site.admin) {
    const bots = siblingBotNames().length + 1;
    offer('all', bots > 1 ? `🌐 Everywhere (${bots} bots)` : '🌐 Every chat');
  }

  const rows: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  if (site.allView) rows.push([{ text: '🗑️ Delete this thread', callback_data: 'delthread:confirm' }]);
  return rows.length > 0 ? rows : undefined;
}

/**
 * Apply a choice at a level from the session the user is in, and build the
 * confirmation and buttons for it. The caller adds anything specific to the
 * setting (the premium note, the unverified-model warning) and sends it.
 */
export async function applyAtLevel(
  ctx: Context,
  args: {
    sessionKey: string;
    setting: SpawnSetting;
    value: string | null;
    label: string;
    level: SettingLevel;
    site: ScopeSite;
  },
): Promise<{ message: EntityText; keyboard?: { text: string; callback_data: string }[][] }> {
  const { sessionKey, setting, value, label, level, site } = args;
  const chatId = parseSessionKey(sessionKey).chatId;

  const outcome = applySpawnSetting(sessionKey, setting, value, level, sessionKey);
  const keptPins = level === 'default' && (site.inThread || site.allView)
    ? userPreferences.threadsPinnedOtherThan(chatId, setting, value).filter((k) => k !== sessionKey)
    : [];

  const message = new EntityText()
    .append(prefsConfirmation(setting, label, level, site))
    .append(describeOutcome(outcome, { level, current: sessionKey, keptPins }));

  if (level === 'all') {
    message.append(await applyToAllBots({
      chatId,
      setting,
      value,
      provider: getActiveProviderName(sessionKey),
      level: 'all',
    }));
  }

  const buttonValue = value ?? 'auto';
  return { message, keyboard: buildWidenKeyboard(setting, buttonValue, level, site) };
}

/** The refusal for a non-admin asking for every chat. */
export const EVERYWHERE_ADMIN_ONLY = 'Only an admin can set every chat. Use chat to set every thread here.';

/**
 * Relay a change to the other instances and describe what happened, as a
 * block (opening with a blank line) to append to the local confirmation.
 * Says nothing in a single-bot setup, where "everywhere" is this bot.
 */
export async function applyToAllBots(change: PrefsChange): Promise<EntityMessage> {
  const result = await broadcastPrefsChange(change);
  return formatBroadcastResult(result);
}

/** Render a broadcast outcome. Exported for tests. */
export function formatBroadcastResult(result: PrefsBroadcastResult): EntityMessage {
  const nothing = new EntityText().build();
  if (!result.multiInstance) return nothing;

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
    return nothing;
  }

  // Each line opens with its own newline; this one more sets the block off
  // from the confirmation with a blank line.
  const b = new EntityText().add('\n');

  if (result.applied.length > 0) {
    const names = result.applied.map((o) => o.name).join(', ');
    b.add('\n🌐 Also applied to ')
      .bold(String(result.applied.length))
      .add(` other bot${result.applied.length === 1 ? '' : 's'}: ${names}`);

    // A busy bot switches when its turn ends; say so rather than let the
    // reply it's writing now look like the setting didn't take.
    const busy = result.applied.filter((o) => (o.busy ?? 0) > 0);
    if (busy.length > 0) {
      b.add('\n').italic(
        `${busy.map((o) => o.name).join(', ')} ${busy.length === 1 ? 'is' : 'are'} mid-turn — ` +
        'switching when that turn ends.',
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
 * Where a scope's model or effort comes from, as the pickers and /status say
 * it: "pinned in this thread", "this chat's default", "the default
 * everywhere", or Claude Code's own default when nothing chose.
 */
export function describeSource(scope: SettingsScope, setting: SpawnSetting): string {
  const source = userPreferences.sourceOf(scope, setting);
  const inThread = parseSessionKey(String(scope)).threadId !== undefined;
  switch (source) {
    case 'thread':
      return 'pinned in this thread';
    case 'chat':
      return inThread ? "this chat's default" : 'set for this chat';
    case 'bot':
      return 'the default everywhere';
    default:
      return "Claude Code's default";
  }
}

/** The picker's closing note on how far a choice reaches. */
export function levelHelp(command: 'model' | 'effort', example: string, site: ScopeSite): EntityMessage {
  const b = new EntityText().add('\n\n');
  if (site.allView) {
    b.add('Picking here sets the default for new threads in this chat.');
  } else if (site.inThread) {
    b.add('Picking sets this thread; the confirmation can widen it to new threads, every thread here');
    b.add(site.admin ? ' or everywhere.' : '.');
  } else {
    // Without threads, new and chat are this chat again: only all says more.
    b.add('Picking sets this chat');
    if (!site.admin) return b.add('.').build();
    return b.add('; ').code(`/${command} ${example} all`).add(' sets every chat.').build();
  }
  b.add(' Typed: ').code(`/${command} ${example} new`).add(', ').code('chat');
  if (site.admin) b.add(' or ').code('all');
  return b.add('.').build();
}

/** Human-readable name for a value, matching what the pickers show. */
async function describeValue(scope: SettingsScope, setting: SpawnSetting, value: string | null): Promise<string> {
  if (setting === 'effort') {
    if (value === null) return 'Auto (CLI default)';
    return EFFORT_LEVELS.find((l) => l.id === value)?.label ?? value;
  }
  if (value === null) return 'default';
  const models = await getAvailableModels(scope);
  return models.find((m) => m.id === value)?.label ?? value;
}

/**
 * A widen button under a /model or /effort confirmation, or the "apply to
 * all bots" button of earlier builds (read as everywhere). The narrower
 * change already happened when the message was sent; this applies the wider
 * one and rewrites the message with what it did.
 */
export async function handlePrefsScopeCallback(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  const data = ctx.callbackQuery?.data;
  if (!keyInfo || !data) return;
  const { sessionKey } = keyInfo;

  let level: SettingLevel;
  let rest: string;
  if (data.startsWith(PREFS_SCOPE_PREFIX)) {
    rest = data.slice(PREFS_SCOPE_PREFIX.length);
    const sep = rest.indexOf(':');
    if (sep === -1) return;
    const word = rest.slice(0, sep);
    if (!LEVEL_ORDER.includes(word as SettingLevel)) return;
    level = word as SettingLevel;
    rest = rest.slice(sep + 1);
  } else if (data.startsWith(LEGACY_PREFS_ALL_PREFIX)) {
    level = 'all';
    rest = data.slice(LEGACY_PREFS_ALL_PREFIX.length);
  } else {
    return;
  }

  const sep = rest.indexOf(':');
  if (sep === -1) return;
  const setting = rest.slice(0, sep);
  const raw = rest.slice(sep + 1);
  if (setting !== 'model' && setting !== 'effort') return;

  // 'auto' is how the effort picker spells "no preference"; a model has no
  // such spelling.
  const value = setting === 'effort' && raw === 'auto' ? null : raw;
  const valid = setting === 'effort'
    ? value === null || isValidEffortLevel(value)
    : (await getAvailableModels(sessionKey)).some((m) => m.id === raw) || isPassthroughModelId(raw);
  if (!valid) {
    await ctx.answerCallbackQuery({ text: 'Unknown value' });
    return;
  }

  const site = scopeSite(ctx);
  if (level === 'all' && !site.admin) {
    await ctx.answerCallbackQuery({ text: EVERYWHERE_ADMIN_ONLY, show_alert: true });
    return;
  }

  await ctx.answerCallbackQuery({ text: level === 'all' ? 'Applying everywhere…' : 'Applying…' });
  // Drop the buttons first: an everywhere change takes a round trip, and a
  // second tap would apply it again.
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
  } catch {
    // ignore — the message may already have been edited
  }

  const label = await describeValue(sessionKey, setting, value);
  const { message, keyboard } = await applyAtLevel(ctx, { sessionKey, setting, value, label, level, site });
  await editCallbackMessage(ctx, message.build(), keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {});
}
