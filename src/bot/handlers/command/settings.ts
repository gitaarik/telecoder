/**
 * Per-chat settings menus: /streaming, /terminalui, /tts, /telegraph,
 * /suggestions, /effort, /verbosity, /method and the status line.
 *
 * They share one shape — render an inline keyboard reflecting current state,
 * flip a setting on tap, re-render — and several need the same pty-restart
 * note when the change only lands on a fresh spawn.
 */

import { Context } from 'grammy';
import { config } from '../../../config.js';
import { sessionManager } from '../../../claude/session-manager.js';
import {
  setEffort,
  getEffort,
  clearEffort,
  isValidEffortLevel,
  getActiveProviderName,
  type AgentUsage,
} from '../../../providers/provider-router.js';
import { userPreferences } from '../../../providers/user-preferences.js';
import { getPtyProvider } from '../../../providers/claude-provider.js';
import { escapeMarkdownV2 as esc } from '../../../telegram/markdown.js';
import { taskTracker } from '../../../telegram/task-tracker.js';
import { getTTSSettings, setTTSEnabled, setTTSVoice, setTTSAutoplay } from '../../../tts/tts-settings.js';
import { getTerminalUISettings, setTerminalUIEnabled } from '../../../telegram/terminal-settings.js';
import { getTelegraphSettings, setTelegraphEnabled } from '../../../telegram/telegraph-settings.js';
import { getSuggestionsSettings, setSuggestionsEnabled } from '../../../telegram/suggestions-settings.js';
import {
  VERBOSITY_INFO,
  isValidVerbosityLevel,
  getVerbosityLevel,
  type VerbosityLevel,
} from '../../../utils/verbosity.js';
import { getSessionKeyFromCtx } from '../../../utils/session-key.js';
import {
  PERMISSION_MODES,
  isPermissionModeId,
  parsePermissionModeArg,
  permissionModeInfo,
  type PermissionModeId,
} from '../../../claude/permission-mode.js';
import {
  replyMd,
  parseCallback,
  getEffortLabel,
  restartPtyForSettingChange,
  EFFORT_LEVELS,
  PTY_RESTART_NOTE,
} from './shared.js';
import { getSessionTopic } from './topic.js';
import { getStreamingMode, setStreamingMode } from './streaming-mode.js';
import { getBgProcesses } from './tasks.js';
import {
  parseScopeArg,
  applyToAllBots,
  buildApplyToAllKeyboard,
  prefsConfirmation,
  hasSiblings,
} from './prefs-scope.js';

const OPENAI_TTS_VOICES = [
  'alloy', 'ash', 'ballad', 'coral',
  'echo', 'fable', 'nova', 'onyx',
  'sage', 'shimmer', 'verse', 'marin', 'cedar',
] as const;

const GROQ_TTS_VOICES = [
  'autumn', 'diana', 'hannah', 'austin', 'daniel', 'troy',
] as const;

function getActiveTTSVoices(): readonly string[] {
  return config.TTS_PROVIDER === 'groq' ? GROQ_TTS_VOICES : OPENAI_TTS_VOICES;
}

type TTSMenuMode = 'main' | 'voices';

function buildTTSMenu(sessionKey: string, mode: TTSMenuMode) {
  const settings = getTTSSettings(sessionKey);
  const hasKey = config.TTS_PROVIDER === 'groq' ? !!config.GROQ_API_KEY : !!config.OPENAI_API_KEY;
  const apiStatus = hasKey ? 'configured' : 'missing';
  const providerLabel = config.TTS_PROVIDER === 'groq' ? 'Groq Orpheus' : 'OpenAI';

  const statusLine = settings.enabled ? 'ON' : 'OFF';
  const autoplayLine = settings.autoplay ? 'ON' : 'OFF';
  const header = `🔊 *Voice Replies*`;
  const baseText =
    `${header}\n\n` +
    `Provider: *${esc(providerLabel)}*\n` +
    `Status: *${statusLine}*\n` +
    `Voice: *${esc(settings.voice)}*\n` +
    `Autoplay: *${autoplayLine}*\n` +
    `API key: *${esc(apiStatus)}*`;

  if (mode === 'voices') {
    const voices = getActiveTTSVoices();
    const voiceRows: { text: string; callback_data: string }[][] = [];
    const chunkSize = 3;
    for (let i = 0; i < voices.length; i += chunkSize) {
      const chunk = voices.slice(i, i + chunkSize);
      voiceRows.push(chunk.map((voice) => ({
        text: voice === settings.voice ? `✓ ${voice}` : voice,
        callback_data: `tts:voice:${voice}`,
      })));
    }

    const recommended = config.TTS_PROVIDER === 'groq'
      ? 'autumn, troy'
      : 'marin, cedar';

    return {
      text:
        `${header}\n\n` +
        `Pick a voice\\.\nRecommended: ${esc(recommended)}\\.`,
      keyboard: [
        ...voiceRows,
        [{ text: 'Back', callback_data: 'tts:back' }],
      ],
    };
  }

  const autoplayLabel = settings.autoplay ? '✓ Autoplay' : 'Autoplay';

  return {
    text: baseText,
    keyboard: [
      [
        { text: settings.enabled ? '✓ On' : 'On', callback_data: 'tts:on' },
        { text: !settings.enabled ? '✓ Off' : 'Off', callback_data: 'tts:off' },
      ],
      [
        { text: `Voice: ${settings.voice}`, callback_data: 'tts:voices' },
        { text: autoplayLabel, callback_data: 'tts:autoplay' },
      ],
    ],
  };
}

function buildSuggestionsMenu(sessionKey: string) {
  const settings = getSuggestionsSettings(sessionKey);
  const defaultLabel = config.PROMPT_SUGGESTIONS_DEFAULT ? 'on' : 'off';
  const statusLine = settings.enabled ? 'ON' : 'OFF';
  const header = `💡 *Predicted Next Prompt*`;

  const baseText =
    `${header}\n\n` +
    `Status: *${statusLine}*\n` +
    `Default: *${esc(defaultLabel)}*\n\n` +
    `_When enabled, TeleCoder surfaces Claude Code's speculative next\\-prompt as an inline button under each response\\. Tap to send it as your next message\\._\n\n` +
    `_Takes effect on the next session spawn \\(env var is set at spawn time\\)\\._`;

  return {
    text: baseText,
    keyboard: [
      [
        { text: settings.enabled ? '✓ On' : 'On', callback_data: 'sugg:on' },
        { text: !settings.enabled ? '✓ Off' : 'Off', callback_data: 'sugg:off' },
      ],
    ],
  };
}

export function buildTelegraphMenu(sessionKey: string) {
  const settings = getTelegraphSettings(sessionKey);
  const globalEnabled = config.TELEGRAPH_ENABLED;
  const globalStatus = globalEnabled ? 'enabled' : 'disabled';

  const statusLine = settings.enabled ? 'ON' : 'OFF';
  const header = `📄 *Instant View \\(Telegraph\\)*`;

  const baseText =
    `${header}\n\n` +
    `Status: *${statusLine}*\n` +
    `Global config: *${esc(globalStatus)}*\n\n` +
    `_When enabled, long responses and tables are rendered as Telegraph articles with Instant View\\._`;

  // If global config is disabled, show warning and no toggle
  if (!globalEnabled) {
    return {
      text:
        `${header}\n\n` +
        `⚠️ *Disabled globally*\n\n` +
        `Telegraph is disabled in the bot configuration\\.\n` +
        `Set \`TELEGRAPH_ENABLED=true\` in \\.env to enable\\.`,
      keyboard: [],
    };
  }

  return {
    text: baseText,
    keyboard: [
      [
        { text: settings.enabled ? '✓ On' : 'On', callback_data: 'telegraph:on' },
        { text: !settings.enabled ? '✓ Off' : 'Off', callback_data: 'telegraph:off' },
      ],
    ],
  };
}

export async function handleStreaming(ctx: Context): Promise<void> {
  const keyboard = [
    [
      {
        text: getStreamingMode() === 'streaming' ? '✓ Streaming' : 'Streaming',
        callback_data: 'mode:streaming'
      },
      {
        text: getStreamingMode() === 'wait' ? '✓ Wait' : 'Wait',
        callback_data: 'mode:wait'
      },
    ],
  ];

  const description = getStreamingMode() === 'streaming'
    ? '_Updates progressively as Claude types_'
    : '_Shows complete response when done_';

  await ctx.reply(
    `⚙️ *Response Mode*\n\nCurrent: *${getStreamingMode()}*\n${description}`,
    {
      parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: keyboard },
    }
  );
}

export async function handleModeCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith('mode:')) return;

  const newMode = data.replace('mode:', '') as 'streaming' | 'wait';
  setStreamingMode(newMode);

  const description = newMode === 'streaming'
    ? '_Updates progressively as Claude types_'
    : '_Shows complete response when done_';

  await ctx.answerCallbackQuery({ text: `Mode set to ${newMode}!` });
  await ctx.editMessageText(
    `✅ Mode set to *${esc(newMode)}*\n\n${description}`,
    { parse_mode: 'MarkdownV2' }
  );
}

export async function handleTerminalUI(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const settings = getTerminalUISettings(sessionKey);
  const currentStatus = settings.enabled ? 'ON' : 'OFF';

  const keyboard = [
    [
      {
        text: settings.enabled ? '✓ On' : 'On',
        callback_data: 'terminalui:on'
      },
      {
        text: !settings.enabled ? '✓ Off' : 'Off',
        callback_data: 'terminalui:off'
      },
    ],
  ];

  const description = settings.enabled
    ? '_Shows spinner animations and tool status during operations_'
    : '_Classic streaming mode with simple cursor_';

  await ctx.reply(
    `🖥️ *Terminal UI Mode*\n\nCurrent: *${currentStatus}*\n${description}`,
    {
      parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: keyboard },
    }
  );
}

export async function handleTerminalUICallback(ctx: Context): Promise<void> {
  const cb = parseCallback(ctx, 'terminalui:');
  if (!cb) return;
  const { sessionKey, data } = cb;

  const newState = data.replace('terminalui:', '') === 'on';
  setTerminalUIEnabled(sessionKey, newState);

  const statusText = newState ? 'ON' : 'OFF';
  const description = newState
    ? '_Shows spinner animations and tool status during operations_'
    : '_Classic streaming mode with simple cursor_';

  await ctx.answerCallbackQuery({ text: `Terminal UI ${statusText}!` });
  await ctx.editMessageText(
    `✅ Terminal UI *${statusText}*\n\n${description}`,
    { parse_mode: 'MarkdownV2' }
  );
}

export async function handleTTS(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const menu = buildTTSMenu(sessionKey, 'main');

  await ctx.reply(menu.text, {
    parse_mode: 'MarkdownV2',
    reply_markup: { inline_keyboard: menu.keyboard },
  });
}

export async function handleTTSCallback(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith('tts:')) return;

  if (data === 'tts:on') {
    const hasKey = config.TTS_PROVIDER === 'groq' ? !!config.GROQ_API_KEY : !!config.OPENAI_API_KEY;
    const keyName = config.TTS_PROVIDER === 'groq' ? 'GROQ_API_KEY' : 'OPENAI_API_KEY';
    if (!hasKey) {
      await ctx.answerCallbackQuery({ text: `${keyName} missing. Set it in .env and restart.` });
      setTTSEnabled(sessionKey, false);
    } else {
      setTTSEnabled(sessionKey, true);
    }
  } else if (data === 'tts:off') {
    setTTSEnabled(sessionKey, false);
  } else if (data === 'tts:autoplay') {
    const current = getTTSSettings(sessionKey);
    setTTSAutoplay(sessionKey, !current.autoplay);
  } else if (data.startsWith('tts:voice:')) {
    const voice = data.replace('tts:voice:', '');
    const voices = getActiveTTSVoices();
    if (voices.includes(voice)) {
      setTTSVoice(sessionKey, voice);
    }
  }

  const mode: TTSMenuMode = data === 'tts:voices' || data.startsWith('tts:voice:')
    ? 'voices'
    : 'main';
  const menu = buildTTSMenu(sessionKey, mode);

  await ctx.answerCallbackQuery();
  try {
    await ctx.editMessageText(menu.text, {
      parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: menu.keyboard },
    });
  } catch (error) {
    // Ignore "message is not modified" — happens with duplicate callbacks
    if (!(error instanceof Error && error.message.includes('message is not modified'))) {
      throw error;
    }
  }
}

export async function handleTelegraphCallback(ctx: Context): Promise<void> {
  const cb = parseCallback(ctx, 'telegraph:');
  if (!cb) return;
  const { sessionKey, data } = cb;

  // Don't allow enabling if global config is disabled
  if (data === 'telegraph:on') {
    if (!config.TELEGRAPH_ENABLED) {
      await ctx.answerCallbackQuery({ text: 'Telegraph disabled in config. Set TELEGRAPH_ENABLED=true in .env.' });
      setTelegraphEnabled(sessionKey, false);
    } else {
      setTelegraphEnabled(sessionKey, true);
    }
  } else if (data === 'telegraph:off') {
    setTelegraphEnabled(sessionKey, false);
  }

  const menu = buildTelegraphMenu(sessionKey);

  await ctx.answerCallbackQuery();
  try {
    await ctx.editMessageText(menu.text, {
      parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: menu.keyboard },
    });
  } catch (error) {
    // Ignore "message is not modified" — happens with duplicate callbacks
    if (!(error instanceof Error && error.message.includes('message is not modified'))) {
      throw error;
    }
  }
}

// ── /effort ──────────────────────────────────────────────────────

export async function handleEffort(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { chatId, sessionKey } = keyInfo;

  const text = ctx.message?.text || '';
  const parsed = parseScopeArg(text.split(' ').slice(1).join(' '));
  const args = parsed.value.toLowerCase();
  const scope = parsed.scope;

  if (!args) {
    const currentEffort = getEffort(chatId) || 'default';

    const keyboard = EFFORT_LEVELS.map((level) => {
      const isCurrent = level.id === currentEffort;
      const label = isCurrent ? `✓ ${level.label}` : level.label;
      return [{ text: label, callback_data: `effort:${level.id}` }];
    });
    // Add auto/reset option
    keyboard.push([{ text: currentEffort === 'default' ? '✓ Auto (default)' : 'Auto (default)', callback_data: 'effort:auto' }]);

    const descriptions = EFFORT_LEVELS
      .map(l => `• *${esc(l.label)}* \\- ${esc(l.description)}`)
      .join('\n');

    // Same scoping as /model: the tap sets this bot, the confirmation offers
    // the rest. Stated here so neither scope has to be guessed at.
    const scopeHint = hasSiblings()
      ? `\n\nApplies to *${esc(config.BOT_NAME)}* only — add \`all\` \\(\`/effort high all\`\\) or use the button afterwards to set every bot\\.`
      : '';

    await ctx.reply(
      `🎯 *Effort Level*\n\n_Current: ${esc(currentEffort)}_\n\n${descriptions}\n• *Auto* \\- SDK default${scopeHint}`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: { inline_keyboard: keyboard },
      }
    );
    return;
  }

  if (args === 'auto' || args === 'default' || args === 'reset') {
    clearEffort(chatId);
    const restarted = restartPtyForSettingChange(chatId, sessionKey);
    const where = hasSiblings() ? ` for *${esc(config.BOT_NAME)}*` : '';
    const confirmation = `✅ Effort reset to *auto* \\(CLI default\\)${where}${restarted ? PTY_RESTART_NOTE : ''}`;
    await replyWithScope(ctx, chatId, confirmation, 'effort', null, 'auto', scope);
    return;
  }

  // A bare `all` is a scope with no level attached — point at the form that
  // works rather than rejecting it as an unknown level.
  if (args === 'all' || args === 'everywhere') {
    await replyMd(
      ctx,
      `\`all\` sets every bot, but it needs a level to set them to\\.\n\n` +
        `Try \`/effort high all\`, or /effort to pick one\\.`,
    );
    return;
  }

  if (!isValidEffortLevel(args)) {
    await replyMd(ctx, `❌ Unknown effort level "${esc(args)}"\\.\n\nValid: low, medium, high, xhigh, max, auto`);
    return;
  }

  setEffort(chatId, args);
  const restarted = restartPtyForSettingChange(chatId, sessionKey);
  const info = EFFORT_LEVELS.find(l => l.id === args);
  const confirmation = `${prefsConfirmation('effort', info?.label || args)}${restarted ? PTY_RESTART_NOTE : ''}`;
  await replyWithScope(ctx, chatId, confirmation, 'effort', args, args, scope);
}

/**
 * Send a settings confirmation, either fanning the change out to the other
 * bots (scope 'all') or offering to. `buttonValue` is what the fan-out button
 * carries — the same spelling the picker uses, so 'auto' rather than null.
 */
async function replyWithScope(
  ctx: Context,
  chatId: number,
  confirmation: string,
  setting: 'model' | 'effort',
  value: string | null,
  buttonValue: string,
  scope: 'this' | 'all',
): Promise<void> {
  if (scope === 'all') {
    const summary = await applyToAllBots({
      chatId,
      setting,
      value,
      provider: getActiveProviderName(chatId),
    });
    await replyMd(ctx, `${confirmation}${summary}`);
    return;
  }

  const keyboard = buildApplyToAllKeyboard(setting, buttonValue);
  await ctx.reply(confirmation, {
    parse_mode: 'MarkdownV2',
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  });
}

export async function handleEffortCallback(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { chatId, sessionKey } = keyInfo;

  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith('effort:')) return;

  const level = data.replace('effort:', '');

  if (level === 'auto') {
    clearEffort(chatId);
    const restarted = restartPtyForSettingChange(chatId, sessionKey);
    await ctx.answerCallbackQuery({ text: 'Effort reset to auto!' });
    const where = hasSiblings() ? ` for *${esc(config.BOT_NAME)}*` : '';
    const keyboard = buildApplyToAllKeyboard('effort', 'auto');
    await ctx.editMessageText(
      `✅ Effort reset to *auto* \\(CLI default\\)${where}${restarted ? PTY_RESTART_NOTE : ''}`,
      {
        parse_mode: 'MarkdownV2',
        ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
      },
    );
    return;
  }

  if (!isValidEffortLevel(level)) {
    await ctx.answerCallbackQuery({ text: 'Invalid effort level' });
    return;
  }

  setEffort(chatId, level);
  const restarted = restartPtyForSettingChange(chatId, sessionKey);

  const info = EFFORT_LEVELS.find(l => l.id === level);
  const displayName = info?.label || level;

  await ctx.answerCallbackQuery({ text: `Effort set to ${displayName}!` });
  const keyboard = buildApplyToAllKeyboard('effort', level);
  await ctx.editMessageText(
    `${prefsConfirmation('effort', displayName)}${restarted ? PTY_RESTART_NOTE : ''}`,
    {
      parse_mode: 'MarkdownV2',
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    },
  );
}

// ── /statusline ─────────────────────────────────────────────────
// A small italic message sent after each turn so the user can always see
// the current effort (and, in future, more stats) right above the compose
// box without scrolling. Off by default; opt-in via /statusline.

function shortenModelName(model: string): string {
  // Strip "vendor/" prefix (OpenRouter / CCR style: "anthropic/claude-4-sonnet-...")
  const slashIdx = model.lastIndexOf('/');
  const stripped = slashIdx >= 0 ? model.substring(slashIdx + 1) : model;
  // claude-opus-4-8 → opus-4-8; trim trailing -YYYYMMDD release tags.
  return stripped.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

const STATUS_LINE_PROMPT_MAX = 140;

function formatLastPromptLine(prompt: string): string {
  // Collapse to a single line and truncate so verbose action logs above don't
  // bury the prompt itself; the user just needs enough to recognise it.
  const normalised = prompt.replace(/\s+/g, ' ').trim();
  if (!normalised) return '';
  const truncated = normalised.length > STATUS_LINE_PROMPT_MAX
    ? normalised.slice(0, STATUS_LINE_PROMPT_MAX - 1).trimEnd() + '…'
    : normalised;
  return `_▸ ${esc(truncated)}_`;
}

/**
 * Build the status-line message body in MarkdownV2.
 * Each enabled line picks its own formatting (italic for topic/stats,
 * mono code span for the resume command so it's easy to copy).
 *
 * Sections are joined with blank lines so the first line (typically the
 * topic) stands alone in Telegram's chat-list preview — that's the only
 * line visible when distinguishing multiple bots in the same project.
 */
function buildStatusLineMarkdown(
  chatId: number,
  sessionKey?: string,
  usage?: AgentUsage,
  lastPrompt?: string,
): string {
  const sections: string[] = [];

  if (sessionKey && userPreferences.getShowTopicInStatusLine(chatId)) {
    const topic = getSessionTopic(sessionKey);
    if (topic) sections.push(`_💬 ${esc(topic)}_`);
  }

  if (lastPrompt && userPreferences.getShowPromptInStatusLine(chatId)) {
    const formatted = formatLastPromptLine(lastPrompt);
    if (formatted) sections.push(formatted);
  }

  const tail: string[] = [];
  if (sessionKey && userPreferences.getShowSessionInStatusLine(chatId)) {
    const claudeSessionId = sessionManager.getSession(sessionKey)?.claudeSessionId;
    if (claudeSessionId) {
      // Inside backticks only `\` and `` ` `` need escaping; UUIDs contain neither.
      tail.push(`🔗 \`claude --resume ${claudeSessionId}\``);
    }
  }

  const stats: string[] = [];
  const label = getEffortLabel(chatId);
  stats.push(label || '🧠 Auto');

  const provider = getActiveProviderName(chatId);
  if (usage) {
    if (usage.model) {
      const shortened = shortenModelName(usage.model);
      // The SDK alias doesn't reflect CCR's actual backend; tag accordingly.
      stats.push(provider === 'ccr' ? `🤖 ${shortened} · CCR` : `🤖 ${shortened}`);
    }
    if (usage.contextWindow > 0) {
      const used = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens;
      const pct = Math.round((used / usage.contextWindow) * 100);
      stats.push(`📊 ${pct}%`);
    }
    stats.push(`💰 $${usage.totalCostUsd.toFixed(2)}`);
  }

  // Activity counters — only rendered when non-zero so quiet turns stay quiet.
  // Tasks/monitors come from the SDK-side tracker; bg shells from the PTY
  // session's /proc children, so the count auto-falls-back to 0 in SDK mode.
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

  tail.push(`_${esc(stats.join(' · '))}_`);

  sections.push(tail.join('\n'));
  return sections.join('\n\n');
}

export async function sendStatusLine(
  ctx: Context,
  chatId: number,
  sessionKey: string,
  usage?: AgentUsage,
  lastPrompt?: string,
): Promise<void> {
  if (!userPreferences.getShowStatusLine(chatId)) return;
  try {
    const markdown = buildStatusLineMarkdown(chatId, sessionKey, usage, lastPrompt);
    await ctx.reply(markdown, { parse_mode: 'MarkdownV2' });
  } catch (err) {
    console.debug('[StatusLine] Failed to send:', err instanceof Error ? err.message : err);
  }
}

function buildStatusLineMenu(chatId: number, sessionKey: string): { text: string; keyboard: { text: string; callback_data: string }[][] } {
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
      { text: showPrompt ? '✓ Show last prompt: On' : 'Show last prompt: On', callback_data: 'statusline:prompt:on' },
      { text: !showPrompt ? '✓ Show last prompt: Off' : 'Show last prompt: Off', callback_data: 'statusline:prompt:off' },
    ],
    [
      { text: showSession ? '✓ Show session: On' : 'Show session: On', callback_data: 'statusline:session:on' },
      { text: !showSession ? '✓ Show session: Off' : 'Show session: Off', callback_data: 'statusline:session:off' },
    ],
  ];

  const preview = buildStatusLineMarkdown(chatId, sessionKey, undefined, 'example prompt for preview');
  const text =
    `📍 *Status Line*\n\n` +
    `Status line: *${enabled ? 'ON' : 'OFF'}*\n` +
    `Show topic: *${showTopic ? 'ON' : 'OFF'}*\n` +
    `Show last prompt: *${showPrompt ? 'ON' : 'OFF'}*\n` +
    `Show session: *${showSession ? 'ON' : 'OFF'}*\n\n` +
    `_Sends a small italic line after each turn so you can see the current state without scrolling\\._ ` +
    `_Show last prompt is handy under /verbosity verbose, where the action log can push your prompt off screen\\._ ` +
    `_The session line shows a copy\\-pasteable \`claude \\-\\-resume\` command for CLI fallback\\._\n\n` +
    `Preview:\n${preview}`;

  return { text, keyboard };
}

export async function handleStatusLine(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { chatId, sessionKey } = keyInfo;

  const menu = buildStatusLineMenu(chatId, sessionKey);
  await ctx.reply(menu.text, {
    parse_mode: 'MarkdownV2',
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
    toastText = `Show last prompt ${newState ? 'ON' : 'OFF'}`;
  } else if (action === 'on' || action === 'off') {
    const newState = action === 'on';
    userPreferences.setShowStatusLine(chatId, newState);
    toastText = `Status line ${newState ? 'ON' : 'OFF'}`;
  } else {
    return;
  }

  const menu = buildStatusLineMenu(chatId, sessionKey);
  await ctx.answerCallbackQuery({ text: toastText });
  await ctx.editMessageText(menu.text, {
    parse_mode: 'MarkdownV2',
    reply_markup: { inline_keyboard: menu.keyboard },
  });
}

// ── /verbosity ──────────────────────────────────────────────────
// Pick a verbosity tier (quiet | normal | verbose | debug) for this chat.
// The tier sets defaults for rendering flags (usage footer, compaction
// notice, completion ping, untruncated tool inputs). Explicit env vars
// (CONTEXT_SHOW_USAGE, CONTEXT_NOTIFY_COMPACTION, TERMINAL_UI_VERBOSE)
// still win over the tier. "Default" clears the chat-specific pref so the
// env-level VERBOSITY_DEFAULT applies.

function buildVerbosityMenu(chatId: number): { text: string; keyboard: { text: string; callback_data: string }[][] } {
  const current = getVerbosityLevel(chatId);
  const hasPref = userPreferences.getVerbosity(chatId) !== undefined;

  const keyboard: { text: string; callback_data: string }[][] = VERBOSITY_INFO.map((info) => {
    const isCurrent = info.id === current && hasPref;
    const label = isCurrent ? `✓ ${info.label}` : info.label;
    return [{ text: label, callback_data: `verbosity:${info.id}` }];
  });
  const defaultLabel = !hasPref ? `✓ Default (${config.VERBOSITY_DEFAULT})` : `Default (${config.VERBOSITY_DEFAULT})`;
  keyboard.push([{ text: defaultLabel, callback_data: 'verbosity:default' }]);

  const descriptions = VERBOSITY_INFO
    .map((info) => `• *${esc(info.label)}* \\- ${esc(info.description)}`)
    .join('\n');

  const text =
    `🎚️ *Verbosity*\n\n` +
    `Current: *${esc(current)}*${hasPref ? '' : ' _\\(from env default\\)_'}\n\n` +
    `${descriptions}\n` +
    `• *Default* \\- Use the env\\-level setting \\(\`VERBOSITY_DEFAULT\`\\)`;

  return { text, keyboard };
}

export async function handleVerbosity(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { chatId } = keyInfo;

  const arg = (ctx.message?.text || '').split(' ').slice(1).join(' ').trim().toLowerCase();

  if (!arg) {
    const { text, keyboard } = buildVerbosityMenu(chatId);
    await ctx.reply(text, {
      parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: keyboard },
    });
    return;
  }

  if (arg === 'default' || arg === 'reset' || arg === 'auto') {
    userPreferences.clearVerbosity(chatId);
    await ctx.reply(
      `✅ Verbosity reset to env default \\(*${esc(config.VERBOSITY_DEFAULT)}*\\)`,
      { parse_mode: 'MarkdownV2' },
    );
    return;
  }

  if (!isValidVerbosityLevel(arg)) {
    await ctx.reply(
      `❌ Unknown verbosity level "${esc(arg)}"\\.\n\nValid: quiet, normal, verbose, debug, default`,
      { parse_mode: 'MarkdownV2' },
    );
    return;
  }

  userPreferences.setVerbosity(chatId, arg);
  const info = VERBOSITY_INFO.find((l) => l.id === arg);
  await ctx.reply(
    `✅ Verbosity set to *${esc(info?.label ?? arg)}*\n\n_${esc(info?.description ?? '')}_`,
    { parse_mode: 'MarkdownV2' },
  );
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
    await ctx.editMessageText(
      `✅ Verbosity reset to env default \\(*${esc(config.VERBOSITY_DEFAULT)}*\\)`,
      { parse_mode: 'MarkdownV2' },
    );
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
  await ctx.editMessageText(
    `✅ Verbosity set to *${esc(info?.label ?? level)}*\n\n_${esc(info?.description ?? '')}_`,
    { parse_mode: 'MarkdownV2' },
  );
}

export async function handleMethodCommand(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const descriptions: Record<string, string> = {
    sdk: "Use Claude Code SDK (default, recommended)",
    pty: "Use interactive PTY session (experimental, for Max subscription)",
  };

  const currentMethod = userPreferences.getMethod(chatId) ?? 'sdk';
  const availableMethods = ['sdk', 'pty'];

  const keyboard = availableMethods.map((method) => {
    const label = method === currentMethod ? `✓ ${method}` : method;
    return [{ text: label, callback_data: `method:${method}` }];
  });

  const descriptionText = Object.entries(descriptions)
    .map(([key, value]) => `*${key}*\\: ${esc(value)}`)
    .join('\n');

  await ctx.reply(`${descriptionText}`, {
    parse_mode: 'MarkdownV2',
    reply_markup: {
      inline_keyboard: keyboard,
    },
  });
}

export async function handleMethodCallback(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith('method:')) return;

  const newMethod = data.replace('method:', '');

  if (newMethod === 'sdk' || newMethod === 'pty') {
    userPreferences.setMethod(chatId, newMethod);
  }

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(`✅ Method set to *${esc(newMethod)}*`, {
    parse_mode: 'MarkdownV2',
  });
}

export async function handleSuggestions(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const menu = buildSuggestionsMenu(sessionKey);
  await ctx.reply(menu.text, {
    parse_mode: 'MarkdownV2',
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
    await ctx.editMessageText(menu.text, {
      parse_mode: 'MarkdownV2',
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
 * still belongs to the streaming toggle this command took its name from. A
 * keyboard from that older menu can be sitting in someone's chat right now,
 * and its buttons carry `mode:streaming`.
 */
function buildPermissionModeMenu(chatId: number): {
  text: string;
  keyboard: { text: string; callback_data: string }[][];
} {
  const current = userPreferences.getPermissionMode(chatId);

  const keyboard = PERMISSION_MODES.map((info) => [{
    text: info.id === current ? `✓ ${info.label}` : info.label,
    callback_data: `permmode:${info.id}`,
  }]);
  keyboard.push([{
    text: current ? 'Default' : '✓ Default',
    callback_data: 'permmode:default',
  }]);

  const descriptions = PERMISSION_MODES
    .map((info) => `• *${esc(info.label)}* \\- ${esc(info.description)}`)
    .join('\n');

  const currentLabel = current
    ? esc(permissionModeInfo(current).label)
    : 'Default _\\(what this bot has always used\\)_';

  return {
    text:
      `🔐 *Permission mode*\n\nCurrent: *${currentLabel}*\n\n`
      + `${descriptions}\n• *Default* \\- leave it to the transport\n\n`
      + '_Takes effect on your next message\\. Modes that ask will put Claude '
      + "Code's own prompts in the chat as buttons\\._",
    keyboard,
  };
}

/** Confirmation text shared by the command and its buttons. */
function permissionModeSetText(id: PermissionModeId): string {
  const info = permissionModeInfo(id);
  return `✅ Permission mode set to *${esc(info.label)}*\n\n_${esc(info.description)}_`;
}

export async function handlePermissionMode(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { chatId } = keyInfo;

  const arg = (ctx.message?.text || '').split(' ').slice(1).join(' ').trim();

  if (!arg) {
    const { text, keyboard } = buildPermissionModeMenu(chatId);
    await ctx.reply(text, {
      parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: keyboard },
    });
    return;
  }

  const lower = arg.toLowerCase();
  if (lower === 'default' || lower === 'reset') {
    userPreferences.clearPermissionMode(chatId);
    await replyMd(ctx, '✅ Permission mode reset to the transport default\\.');
    return;
  }

  const parsed = parsePermissionModeArg(arg);
  if (!parsed) {
    await replyMd(
      ctx,
      `❌ Unknown mode "${esc(arg)}"\\.\n\nValid: `
      + `${PERMISSION_MODES.map((m) => `\`${esc(m.id)}\``).join(', ')}, \`default\``,
    );
    return;
  }

  userPreferences.setPermissionMode(chatId, parsed);
  await replyMd(ctx, permissionModeSetText(parsed));
}

export async function handlePermissionModeCallback(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { chatId } = keyInfo;

  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith('permmode:')) return;
  const choice = data.replace('permmode:', '');

  if (choice === 'default') {
    userPreferences.clearPermissionMode(chatId);
    await ctx.answerCallbackQuery({ text: 'Permission mode reset to default' });
    await ctx.editMessageText('✅ Permission mode reset to the transport default\\.', {
      parse_mode: 'MarkdownV2',
    });
    return;
  }

  if (!isPermissionModeId(choice)) return;
  userPreferences.setPermissionMode(chatId, choice);
  await ctx.answerCallbackQuery({ text: `Mode: ${permissionModeInfo(choice).label}` });
  await ctx.editMessageText(permissionModeSetText(choice), { parse_mode: 'MarkdownV2' });
}
