/**
 * Per-chat settings menus: /suggestions, /effort, /verbosity and the status line.
 *
 * They share one shape — render an inline keyboard reflecting current state,
 * flip a setting on tap, re-render — and several need the same pty-restart
 * note when the change only lands on a fresh spawn.
 */

import { Context } from 'grammy';
import * as path from 'path';
import { config } from '../../../config.js';
import { sessionManager } from '../../../claude/session-manager.js';
import { promptsIn } from '../../../claude/fork-tree.js';
import {
  getEffort,
  isValidEffortLevel,
  getActiveProviderName,
  type AgentUsage,
} from '../../../providers/provider-router.js';
import { userPreferences } from '../../../providers/user-preferences.js';
import { contextTokens } from '../../../providers/types.js';
import { isPremiumModel, PREMIUM_MODEL_ICON } from '../../../claude/model-catalog.js';
import { getPtyProvider } from '../../../providers/claude-provider.js';
import { EntityText, joinMessages, type EntityMessage } from '../../../telegram/entities.js';
import { replyFormatted, editCallbackMessage } from '../../../telegram/send.js';
import { taskTracker } from '../../../telegram/task-tracker.js';
import { promptLabel, cutLabel } from '../../../telegram/prompt-label.js';
import { getSuggestionsSettings, setSuggestionsEnabled } from '../../../telegram/suggestions-settings.js';
import {
  VERBOSITY_INFO,
  isValidVerbosityLevel,
  getVerbosityLevel,
  resolveVerbosityFlags,
  type VerbosityLevel,
} from '../../../utils/verbosity.js';
import { contextHealthColor, fmtTokens, getProgressBar } from '../../../utils/format.js';
import { getSessionKeyFromCtx, type SettingsScope } from '../../../utils/session-key.js';
import {
  PERMISSION_MODES,
  isPermissionModeId,
  parsePermissionModeArg,
  permissionModeInfo,
  defaultPermissionMode,
  type PermissionModeId,
} from '../../../claude/permission-mode.js';
import {
  replyMd,
  parseCallback,
  getEffortLabel,
  effortLevelLabel,
  EFFORT_LEVELS,
  replyFeatureDisabled,
  buildFeatureDisabledMessage,
} from './shared.js';
import { getSessionTopic } from './topic.js';
import { getBgProcesses } from './tasks.js';
import {
  parseScopeArg,
  isBareLevelWord,
  scopeSite,
  applyAtLevel,
  describeSource,
  levelHelp,
  EVERYWHERE_ADMIN_ONLY,
} from './prefs-scope.js';

function buildSuggestionsMenu(sessionKey: string) {
  const settings = getSuggestionsSettings(sessionKey);
  const defaultLabel = config.PROMPT_SUGGESTIONS_DEFAULT ? 'on' : 'off';
  const statusLine = settings.enabled ? 'ON' : 'OFF';
  const text = new EntityText()
    .add('💡 ').bold('Predicted Next Prompt').newline(2)
    .add('Status: ').bold(statusLine).newline()
    .add('Default: ').bold(defaultLabel).newline(2)
    .italic("When enabled, TeleCoder surfaces Claude Code's speculative next-prompt as an inline button under each response. Tap to send it as your next message.")
    .newline(2)
    .italic('Takes effect on the next session spawn (env var is set at spawn time).')
    .build();

  return {
    text,
    keyboard: [
      [
        { text: settings.enabled ? '✓ On' : 'On', callback_data: 'sugg:on' },
        { text: !settings.enabled ? '✓ Off' : 'Off', callback_data: 'sugg:off' },
      ],
    ],
  };
}

// ── /effort ──────────────────────────────────────────────────────

export async function handleEffort(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const text = ctx.message?.text || '';
  const parsed = parseScopeArg(text.split(' ').slice(1).join(' '));
  const args = parsed.value.toLowerCase();
  const site = scopeSite(ctx);

  if (!args) {
    const currentEffort = getEffort(sessionKey) || 'default';

    const keyboard = EFFORT_LEVELS.map((level) => {
      const isCurrent = level.id === currentEffort;
      const label = isCurrent ? `✓ ${level.label}` : level.label;
      return [{ text: label, callback_data: `effort:${level.id}` }];
    });
    // Add auto/reset option
    keyboard.push([{ text: currentEffort === 'default' ? '✓ Auto (default)' : 'Auto (default)', callback_data: 'effort:auto' }]);

    const picker = new EntityText()
      .add('🎯 ').bold('Effort Level').newline(2)
      .italic(`Current: ${currentEffort === 'default' ? 'auto' : currentEffort}, ${describeSource(sessionKey, 'effort')}`).newline(2);
    for (const l of EFFORT_LEVELS) {
      picker.add('• ').bold(l.label).add(` - ${l.description}\n`);
    }
    picker.add('• ').bold('Auto').add(" - Claude Code's default");
    picker.append(levelHelp('effort', 'high', site));

    await replyFormatted(ctx, picker.build(), {
      reply_markup: { inline_keyboard: keyboard },
    });
    return;
  }

  // A level word on its own has no effort level attached — point at the form
  // that works rather than rejecting it as an unknown level. `default` stays
  // the reset it always was.
  if (args !== 'default' && isBareLevelWord(args)) {
    await replyMd(
      ctx,
      `\`${args}\` says how far to apply an effort level, but it needs the level too.\n\n` +
        `Try \`/effort high ${args}\`, or /effort to pick one.`,
    );
    return;
  }

  const reset = args === 'auto' || args === 'default' || args === 'reset';
  if (!reset && !isValidEffortLevel(args)) {
    await replyFormatted(ctx, `❌ Unknown effort level "${args}".\n\nValid: low, medium, high, xhigh, max, auto`);
    return;
  }

  const level = parsed.level ?? 'thread';
  if (level === 'all' && !site.admin) {
    await replyFormatted(ctx, new EntityText().add(`⛔ ${EVERYWHERE_ADMIN_ONLY}`).build());
    return;
  }

  const value = reset ? null : args;
  const label = reset ? 'Auto (CLI default)' : EFFORT_LEVELS.find(l => l.id === args)?.label || args;
  const { message, keyboard } = await applyAtLevel(ctx, { sessionKey, setting: 'effort', value, label, level, site });
  await replyFormatted(ctx, message.build(), {
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  });
}

export async function handleEffortCallback(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith('effort:')) return;

  const choice = data.replace('effort:', '');
  if (choice !== 'auto' && !isValidEffortLevel(choice)) {
    await ctx.answerCallbackQuery({ text: 'Invalid effort level' });
    return;
  }

  const value = choice === 'auto' ? null : choice;
  const label = value === null ? 'Auto (CLI default)' : EFFORT_LEVELS.find(l => l.id === value)?.label || value;
  await ctx.answerCallbackQuery({ text: value === null ? 'Effort reset to auto!' : `Effort set to ${label}!` });

  const site = scopeSite(ctx);
  const { message, keyboard } = await applyAtLevel(ctx, {
    sessionKey, setting: 'effort', value, label, level: 'thread', site,
  });
  await editCallbackMessage(ctx, message.build(), {
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  });
}

// ── /statusline ─────────────────────────────────────────────────
// A small italic message sent after each turn so the user can always see
// the current state right above the compose box without scrolling. On by
// default (STATUS_LINE_DEFAULT); /statusline turns it off per chat. It
// follows the reply, which already rang the phone, so it's sent silently.

function shortenModelName(model: string): string {
  // Strip "vendor/" prefix (OpenRouter / CCR style: "anthropic/claude-4-sonnet-...")
  const slashIdx = model.lastIndexOf('/');
  const stripped = slashIdx >= 0 ? model.substring(slashIdx + 1) : model;
  // claude-opus-4-8 → opus-4-8; trim trailing -YYYYMMDD release tags.
  return stripped.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

// The last few prompts rather than only the latest: a turn often starts from
// an "ok" or a "yeah", which says nothing without the prompts before it.
const STATUS_LINE_PROMPTS = 5;
// Past this a prompt shows its start and its end. Most prompts are one
// paragraph, and across 100 recent sessions 93% of those fit, where 100
// characters cut a third of them. Five sit under every answer: at 40
// characters a row they take a median of 15 rows, and at most 40.
const STATUS_LINE_PROMPT_MAX = 300;

/**
 * The status line's prompt lines, oldest first so they read in the same order
 * as the chat above them. `prompts` are raw, as the session log keeps them;
 * anything that wasn't a turn, like a /compact, is dropped before the last few
 * are taken, so it doesn't use up one of the lines.
 */
export function formatRecentPrompts(prompts: string[]): EntityMessage {
  const b = new EntityText();
  prompts
    .flatMap((prompt) => promptLabel(prompt) ?? [])
    .slice(-STATUS_LINE_PROMPTS)
    .forEach((label, i) => {
      if (i > 0) b.newline();
      b.italic(`▸ ${cutLabel(label, STATUS_LINE_PROMPT_MAX)}`);
    });
  return b.build();
}

/**
 * The session's prompts as its log records them, so the list reaches back past
 * a restart and past prompts sent from elsewhere. The turn's own prompt stands
 * in when the log has none to give. A reply no prompt started, like the one to
 * a background task that reported back, has only the log to go by.
 */
function recentPrompts(sessionKey: string | undefined, lastPrompt: string | undefined): string[] {
  const session = sessionKey ? sessionManager.getSession(sessionKey) : undefined;
  const logged = session?.claudeSessionId
    ? promptsIn(session.workingDirectory, session.claudeSessionId)
    : [];
  if (logged.length > 0) return logged;
  return lastPrompt ? [lastPrompt] : [];
}

/**
 * The usage footer, if there's a figure to show and /verbosity wants it shown.
 * Plain text, whether sent alone or closing the status line.
 */
function usageFooter(chatId: number, usage: AgentUsage | undefined): string | undefined {
  if (!usage || !resolveVerbosityFlags(chatId).showUsageFooter) return undefined;
  const used = contextTokens(usage);
  const pct = usage.contextWindow > 0 ? Math.round((used / usage.contextWindow) * 100) : 0;
  const bar = getProgressBar(pct, contextHealthColor(used, usage.contextWindow));
  return `${bar} ${pct}% context · ${fmtTokens(used)}/${fmtTokens(usage.contextWindow)} · ${usage.numTurns} turns`;
}

/**
 * Build the status-line message body.
 * Each enabled line picks its own formatting (italic for topic/stats,
 * mono code span for the resume command so it's easy to copy).
 *
 * Sections are joined with blank lines so the first line (typically the
 * topic) stands alone in Telegram's chat-list preview — that's the only
 * line visible when distinguishing multiple bots in the same project.
 *
 * The usage footer, when the chat shows one, closes the message.
 *
 * `brief` leaves the stats and that footer: see StatusLineOptions.
 */
function buildStatusLine(
  chatId: number,
  sessionKey?: string,
  usage?: AgentUsage,
  lastPrompt?: string,
  brief = false,
): EntityMessage {
  const sections: EntityMessage[] = [];

  if (!brief && sessionKey && userPreferences.getShowTopicInStatusLine(chatId)) {
    const topic = getSessionTopic(sessionKey);
    if (topic) sections.push(new EntityText().italic(`💬 ${topic}`).build());
  }

  if (!brief && userPreferences.getShowPromptInStatusLine(chatId)) {
    const formatted = formatRecentPrompts(recentPrompts(sessionKey, lastPrompt));
    if (formatted.text) sections.push(formatted);
  }

  const tail = new EntityText();
  if (!brief && sessionKey && userPreferences.getShowSessionInStatusLine(chatId)) {
    const claudeSessionId = sessionManager.getSession(sessionKey)?.claudeSessionId;
    if (claudeSessionId) {
      tail.add('🔗 ').code(`claude --resume ${claudeSessionId}`).newline();
    }
  }

  const stats: string[] = [];
  // The bot's display name only says where it is now; this stays with each
  // answer for scrolling back. After a switch it already names the new project,
  // where the next message goes, even though the turn ran in the old one.
  const project = sessionKey ? sessionManager.getSession(sessionKey)?.workingDirectory : undefined;
  if (project) stats.push(`📁 ${path.basename(project) || project}`);

  // The chat's own /effort pick, else the effort the log says the reply ran
  // at; "Auto" only while neither is known.
  const label = getEffortLabel(sessionKey ?? chatId)
    ?? (usage?.effort ? effortLevelLabel(usage.effort) : undefined);
  stats.push(label || '🧠 Auto');

  const footer = usageFooter(chatId, usage);
  const provider = getActiveProviderName(sessionKey ?? chatId);
  if (usage) {
    if (usage.model) {
      const shortened = shortenModelName(usage.model);
      // The alias doesn't reflect CCR's actual backend; tag accordingly.
      // A premium model swaps the robot for a badge, so it stands out of the
      // row rather than reading as one more stat.
      if (provider === 'ccr') stats.push(`🤖 ${shortened} · CCR`);
      else if (isPremiumModel(usage.model)) stats.push(`${PREMIUM_MODEL_ICON} ${shortened.toUpperCase()}`);
      else stats.push(`🤖 ${shortened}`);
    }
    // The footer gives this right below, in more detail.
    if (!footer && usage.contextWindow > 0) {
      const used = contextTokens(usage);
      const pct = Math.round((used / usage.contextWindow) * 100);
      // The chart while it's healthy; amber or red once it's grown big
      // enough that a /clear or fork is worth thinking about.
      const health = contextHealthColor(used, usage.contextWindow);
      stats.push(`${health === '🟢' ? '📊' : health} ${pct}%`);
    }
  }

  // Activity counters — only rendered when non-zero so quiet turns stay quiet.
  // Tasks/monitors come from the task tracker; bg shells from the pty's
  // /proc children, so that count is left out when no pty is live.
  if (sessionKey) {
    const bg = taskTracker.getBackgroundedTasks(sessionKey);
    const monitorCount = bg.filter((t) => t.taskType === 'monitor_mcp').length;
    const taskCount = bg.length - monitorCount;
    if (taskCount > 0) stats.push(`🔄 ${taskCount}`);
    if (monitorCount > 0) stats.push(`📡 ${monitorCount}`);

    const claudePid = getPtyProvider().getSessionPid(sessionKey);
    if (claudePid !== undefined) {
      const shellCount = getBgProcesses(claudePid).length;
      if (shellCount > 0) stats.push(`🔍 ${shellCount}`);
    }
  }

  tail.italic(stats.join(' · '));
  if (footer) tail.newline().add(footer);

  sections.push(tail.build());
  return joinMessages(sections);
}

export interface StatusLineOptions {
  /**
   * Only the stats and the usage footer: no topic, no prompts, no resume
   * command. For a turn nobody typed, on a schedule that may fire every minute.
   * The whole block under each fire would outweigh a short result, and each
   * fire is logged as a prompt, so the list would soon hold nothing but the
   * schedule's own.
   */
  brief?: boolean;
}

/**
 * The message that closes a turn: the status line, with the usage footer at its
 * bottom when the chat shows both. /statusline and /verbosity set them apart,
 * so with the status line off, a chat that shows the footer gets it on its own.
 *
 * `lastPrompt` is the turn's own, for a session whose log has no prompts to
 * list. Leave it out for a reply that no prompt started.
 */
export async function sendStatusLine(
  ctx: Context,
  chatId: number,
  sessionKey: string,
  usage?: AgentUsage,
  lastPrompt?: string,
  { brief = false }: StatusLineOptions = {},
): Promise<void> {
  try {
    if (userPreferences.getShowStatusLine(chatId)) {
      await replyFormatted(ctx, buildStatusLine(chatId, sessionKey, usage, lastPrompt, brief), {
        disable_notification: true,
      });
      return;
    }
    const footer = usageFooter(chatId, usage);
    if (footer) await ctx.reply(footer, { disable_notification: true });
  } catch (err) {
    console.debug('[StatusLine] Failed to send:', err instanceof Error ? err.message : err);
  }
}

function buildStatusLineMenu(chatId: number, sessionKey: string): { text: EntityMessage; keyboard: { text: string; callback_data: string }[][] } {
  const enabled = userPreferences.getShowStatusLine(chatId);
  const showTopic = userPreferences.getShowTopicInStatusLine(chatId);
  const showSession = userPreferences.getShowSessionInStatusLine(chatId);
  const showPrompt = userPreferences.getShowPromptInStatusLine(chatId);

  const keyboard: { text: string; callback_data: string }[][] = [
    [
      { text: enabled ? '✓ Status line: On' : 'Status line: On', callback_data: 'statusline:on' },
      { text: !enabled ? '✓ Status line: Off' : 'Status line: Off', callback_data: 'statusline:off' },
    ],
    [
      { text: showTopic ? '✓ Show topic: On' : 'Show topic: On', callback_data: 'statusline:topic:on' },
      { text: !showTopic ? '✓ Show topic: Off' : 'Show topic: Off', callback_data: 'statusline:topic:off' },
    ],
    [
      { text: showPrompt ? '✓ Show last prompts: On' : 'Show last prompts: On', callback_data: 'statusline:prompt:on' },
      { text: !showPrompt ? '✓ Show last prompts: Off' : 'Show last prompts: Off', callback_data: 'statusline:prompt:off' },
    ],
    [
      { text: showSession ? '✓ Show session: On' : 'Show session: On', callback_data: 'statusline:session:on' },
      { text: !showSession ? '✓ Show session: Off' : 'Show session: Off', callback_data: 'statusline:session:off' },
    ],
  ];

  const preview = buildStatusLine(chatId, sessionKey, undefined, 'example prompt for preview');
  const onOff = (on: boolean) => (on ? 'ON' : 'OFF');
  const text = new EntityText()
    .add('📍 ').bold('Status Line').newline(2)
    .add('Status line: ').bold(onOff(enabled)).newline()
    .add('Show topic: ').bold(onOff(showTopic)).newline()
    .add('Show last prompts: ').bold(onOff(showPrompt)).newline()
    .add('Show session: ').bold(onOff(showSession)).newline(2)
    .italic('Sends a small italic line after each turn so you can see the current state without scrolling.')
    .add(' ')
    .italic(
      `Show last prompts lists the last ${STATUS_LINE_PROMPTS} you sent, so an "ok" still shows what it answered. ` +
      'Handy under /verbosity verbose, where the action log can push them off screen.',
    )
    .add(' ')
    .wrap('italic', (b) => b
      .add('The session line shows a copy-pasteable ')
      .code('claude --resume')
      .add(' command for CLI fallback.'))
    .add('\n\nPreview:\n')
    .append(preview)
    .build();

  return { text, keyboard };
}

export async function handleStatusLine(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { chatId, sessionKey } = keyInfo;

  const menu = buildStatusLineMenu(chatId, sessionKey);
  await replyFormatted(ctx, menu.text, {
    reply_markup: { inline_keyboard: menu.keyboard },
  });
}

export async function handleStatusLineCallback(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { chatId, sessionKey } = keyInfo;

  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith('statusline:')) return;

  const action = data.replace('statusline:', '');
  let toastText: string;

  if (action === 'topic:on' || action === 'topic:off') {
    const newState = action === 'topic:on';
    userPreferences.setShowTopicInStatusLine(chatId, newState);
    toastText = `Show topic ${newState ? 'ON' : 'OFF'}`;
  } else if (action === 'session:on' || action === 'session:off') {
    const newState = action === 'session:on';
    userPreferences.setShowSessionInStatusLine(chatId, newState);
    toastText = `Show session ${newState ? 'ON' : 'OFF'}`;
  } else if (action === 'prompt:on' || action === 'prompt:off') {
    const newState = action === 'prompt:on';
    userPreferences.setShowPromptInStatusLine(chatId, newState);
    toastText = `Show last prompts ${newState ? 'ON' : 'OFF'}`;
  } else if (action === 'on' || action === 'off') {
    const newState = action === 'on';
    userPreferences.setShowStatusLine(chatId, newState);
    toastText = `Status line ${newState ? 'ON' : 'OFF'}`;
  } else {
    return;
  }

  const menu = buildStatusLineMenu(chatId, sessionKey);
  await ctx.answerCallbackQuery({ text: toastText });
  await editCallbackMessage(ctx, menu.text, {
    reply_markup: { inline_keyboard: menu.keyboard },
  });
}

// ── /verbosity ──────────────────────────────────────────────────
// Pick a verbosity tier (quiet | normal | verbose | debug) for this chat.
// The tier sets defaults for rendering flags (usage footer, compaction
// notice, completion ping, untruncated tool inputs). Explicit env vars
// (CONTEXT_SHOW_USAGE, CONTEXT_NOTIFY_COMPACTION, FULL_TOOL_INPUTS)
// still win over the tier. "Default" clears the chat-specific pref so the
// env-level VERBOSITY_DEFAULT applies.

function buildVerbosityMenu(chatId: number): { text: EntityMessage; keyboard: { text: string; callback_data: string }[][] } {
  const current = getVerbosityLevel(chatId);
  const hasPref = userPreferences.getVerbosity(chatId) !== undefined;

  const keyboard: { text: string; callback_data: string }[][] = VERBOSITY_INFO.map((info) => {
    const isCurrent = info.id === current && hasPref;
    const label = isCurrent ? `✓ ${info.label}` : info.label;
    return [{ text: label, callback_data: `verbosity:${info.id}` }];
  });
  const defaultLabel = !hasPref ? `✓ Default (${config.VERBOSITY_DEFAULT})` : `Default (${config.VERBOSITY_DEFAULT})`;
  keyboard.push([{ text: defaultLabel, callback_data: 'verbosity:default' }]);

  const text = new EntityText()
    .add('🎚️ ').bold('Verbosity').newline(2)
    .add('Current: ').bold(current);
  if (!hasPref) text.add(' ').italic('(from env default)');
  text.newline(2);
  for (const info of VERBOSITY_INFO) {
    text.add('• ').bold(info.label).add(` - ${info.description}\n`);
  }
  text.add('• ').bold('Default').add(' - Use the env-level setting (').code('VERBOSITY_DEFAULT').add(')');

  return { text: text.build(), keyboard };
}

/** "✅ Verbosity reset to env default (**normal**)", for the command and its button. */
function verbosityResetText(): EntityMessage {
  return new EntityText()
    .add('✅ Verbosity reset to env default (').bold(config.VERBOSITY_DEFAULT).add(')')
    .build();
}

/** Confirmation for a chosen level, shared by the command and its buttons. */
function verbositySetText(level: VerbosityLevel): EntityMessage {
  const info = VERBOSITY_INFO.find((l) => l.id === level);
  return new EntityText()
    .add('✅ Verbosity set to ').bold(info?.label ?? level).newline(2)
    .italic(info?.description ?? '')
    .build();
}

export async function handleVerbosity(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { chatId } = keyInfo;

  const arg = (ctx.message?.text || '').split(' ').slice(1).join(' ').trim().toLowerCase();

  if (!arg) {
    const { text, keyboard } = buildVerbosityMenu(chatId);
    await replyFormatted(ctx, text, {
      reply_markup: { inline_keyboard: keyboard },
    });
    return;
  }

  if (arg === 'default' || arg === 'reset' || arg === 'auto') {
    userPreferences.clearVerbosity(chatId);
    await replyFormatted(ctx, verbosityResetText());
    return;
  }

  if (!isValidVerbosityLevel(arg)) {
    await replyFormatted(ctx, `❌ Unknown verbosity level "${arg}".\n\nValid: quiet, normal, verbose, debug, default`);
    return;
  }

  userPreferences.setVerbosity(chatId, arg);
  await replyFormatted(ctx, verbositySetText(arg));
}

export async function handleVerbosityCallback(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { chatId } = keyInfo;

  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith('verbosity:')) return;

  const choice = data.replace('verbosity:', '');

  if (choice === 'default') {
    userPreferences.clearVerbosity(chatId);
    await ctx.answerCallbackQuery({ text: 'Verbosity reset to default' });
    await editCallbackMessage(ctx, verbosityResetText());
    return;
  }

  if (!isValidVerbosityLevel(choice)) {
    await ctx.answerCallbackQuery({ text: 'Invalid verbosity level' });
    return;
  }

  const level: VerbosityLevel = choice;
  userPreferences.setVerbosity(chatId, level);
  const info = VERBOSITY_INFO.find((l) => l.id === level);

  await ctx.answerCallbackQuery({ text: `Verbosity: ${info?.label ?? level}` });
  await editCallbackMessage(ctx, verbositySetText(level));
}

export async function handleSuggestions(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const menu = buildSuggestionsMenu(sessionKey);
  await replyFormatted(ctx, menu.text, {
    reply_markup: { inline_keyboard: menu.keyboard },
  });
}

export async function handleSuggestionsCallback(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith('sugg:')) return;

  if (data === 'sugg:on') {
    setSuggestionsEnabled(sessionKey, true);
  } else if (data === 'sugg:off') {
    setSuggestionsEnabled(sessionKey, false);
  }

  const menu = buildSuggestionsMenu(sessionKey);
  await ctx.answerCallbackQuery();
  try {
    await editCallbackMessage(ctx, menu.text, {
      reply_markup: { inline_keyboard: menu.keyboard },
    });
  } catch (error) {
    if (!(error instanceof Error && error.message.includes('message is not modified'))) {
      console.error('[Suggestions] Failed to update menu:', error);
    }
  }
}

/**
 * `/mode` — how much claude asks before acting, per chat.
 *
 * The callback prefix is `permmode:` rather than the obvious `mode:`, which
 * belonged to the streaming/wait toggle this command took its name from. A
 * keyboard from that older menu can still be sitting in someone's chat, and
 * its buttons carry `mode:streaming`.
 */
/**
 * What "Default" actually resolves to for this chat, and why.
 *
 * The menu used to call it "what this bot has always used" — true, and no help
 * at all to someone deciding whether to leave it there. Which mode that is
 * depends on the chat's transport, so the row names the mode and the reason
 * rather than making a person read two files to find out what they already
 * picked.
 */
function describeTransportDefault(): { label: string; why: string } {
  return { label: permissionModeInfo(defaultPermissionMode()).label, why: "Claude Code's own default" };
}

function buildPermissionModeMenu(scope: SettingsScope): {
  text: EntityMessage;
  keyboard: { text: string; callback_data: string }[][];
} {
  const current = userPreferences.getPermissionMode(scope);
  const fallback = describeTransportDefault();

  const keyboard = PERMISSION_MODES.map((info) => [{
    text: info.id === current ? `✓ ${info.label}` : info.label,
    callback_data: `permmode:${info.id}`,
  }]);
  keyboard.push([{
    text: `${current ? '' : '✓ '}Default — ${fallback.label}`,
    callback_data: 'permmode:default',
  }]);

  const text = new EntityText().add('🔐 ').bold('Permission mode').add('\n\nCurrent: ');
  // Named the same way whether or not it was chosen: the mode a turn runs in
  // is the useful fact, and "Default" alone never told anyone what that was.
  if (current) {
    text.bold(permissionModeInfo(current).label);
  } else {
    text.bold(fallback.label).add(' ').italic(`(default — ${fallback.why})`);
  }
  text.newline(2);
  for (const info of PERMISSION_MODES) {
    text.add('• ').bold(info.label).add(` - ${info.description}\n`);
  }
  text.add('• ').bold('Default').add(' - follow the transport, which here means ')
    .bold(fallback.label)
    .newline(2)
    .italic("Takes effect on your next message. Modes that ask will put Claude Code's own prompts in the chat as buttons.");

  return { text: text.build(), keyboard };
}

/** Confirmation text shared by the command and its buttons. */
function permissionModeSetText(id: PermissionModeId): EntityMessage {
  const info = permissionModeInfo(id);
  return new EntityText()
    .add('✅ Permission mode set to ').bold(info.label).newline(2)
    .italic(info.description)
    .build();
}

/** Same, for the reset — which names the mode it reset *to*, not just "default". */
function permissionModeResetText(scope: SettingsScope): EntityMessage {
  const { label, why } = describeTransportDefault();
  return new EntityText()
    .add('✅ Permission mode reset to the transport default: ').bold(label).newline(2)
    .italic(why)
    .build();
}

export async function handlePermissionMode(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const arg = (ctx.message?.text || '').split(' ').slice(1).join(' ').trim();

  if (!arg) {
    const { text, keyboard } = buildPermissionModeMenu(sessionKey);
    await replyFormatted(ctx, text, {
      reply_markup: { inline_keyboard: keyboard },
    });
    return;
  }

  const lower = arg.toLowerCase();
  if (lower === 'default' || lower === 'reset') {
    userPreferences.clearPermissionMode(sessionKey);
    await replyFormatted(ctx, permissionModeResetText(sessionKey));
    return;
  }

  const parsed = parsePermissionModeArg(arg);
  if (!parsed) {
    const valid = new EntityText().add(`❌ Unknown mode "${arg}".\n\nValid: `);
    for (const m of PERMISSION_MODES) valid.code(m.id).add(', ');
    await replyFormatted(ctx, valid.code('default').build());
    return;
  }

  userPreferences.setPermissionMode(sessionKey, parsed);
  await replyFormatted(ctx, permissionModeSetText(parsed));
}

export async function handlePermissionModeCallback(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith('permmode:')) return;
  const choice = data.replace('permmode:', '');

  if (choice === 'default') {
    userPreferences.clearPermissionMode(sessionKey);
    const { label } = describeTransportDefault();
    await ctx.answerCallbackQuery({ text: `Default: ${label}` });
    await editCallbackMessage(ctx, permissionModeResetText(sessionKey));
    return;
  }

  if (!isPermissionModeId(choice)) return;
  userPreferences.setPermissionMode(sessionKey, choice);
  await ctx.answerCallbackQuery({ text: `Mode: ${permissionModeInfo(choice).label}` });
  await editCallbackMessage(ctx, permissionModeSetText(choice));
}
