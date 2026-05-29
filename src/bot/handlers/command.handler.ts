import { Context, InputFile } from 'grammy';
import { sessionManager } from '../../claude/session-manager.js';
import { sessionHistory } from '../../claude/session-history.js';
import {
  clearConversation,
  sendToAgent,
  sendLoopToAgent,
  setModel,
  getModel,
  isDangerousMode,
  getCachedUsage,
  getActiveProviderName,
  setActiveProvider,
  getAvailableProviders,
  getAvailableModels,
  clearModel,
  setEffort,
  getEffort,
  clearEffort,
  isValidEffortLevel,
  type ProviderName,
  type ModelInfo,
  type EffortLevel,
  type AgentUsage,
} from '../../providers/provider-router.js';
import { config, getReloadMarkerPath } from '../../config.js';
import { messageSender } from '../../telegram/message-sender.js';
import { getUptimeFormatted } from '../middleware/stale-filter.js';
import { getAvailableCommands } from '../../claude/command-parser.js';
import {
  cancelRequest,
  clearQueue,
  isProcessing,
  queueRequest,
  setAbortController,
  getActiveQuery,
} from '../../claude/request-queue.js';
import { createTelegraphFromFile, createTelegraphPage } from '../../telegram/telegraph.js';
import { isMediumUrl, fetchMediumArticle, FreediumArticle } from '../../medium/freedium.js';
import { escapeMarkdownV2 as esc, processMessageForTelegram } from '../../telegram/markdown.js';
import { getTTSSettings, setTTSEnabled, setTTSVoice, setTTSAutoplay } from '../../tts/tts-settings.js';
import { getTerminalUISettings, setTerminalUIEnabled } from '../../telegram/terminal-settings.js';
import { getBotNameSettings, setBotNameEnabled, isBotNameEnabled, rateLimitedSetMyName, notifyBotNameBlock } from '../../telegram/botname-settings.js';
import { getTelegraphSettings, setTelegraphEnabled } from '../../telegram/telegraph-settings.js';
import { getSuggestionsSettings, setSuggestionsEnabled } from '../../telegram/suggestions-settings.js';
import { userPreferences } from '../../providers/user-preferences.js';
import { projectFavorites } from '../../providers/project-favorites.js';
import { maybeSendVoiceReply } from '../../tts/voice-reply.js';
import { transcribeFile, downloadTelegramAudio } from '../../audio/transcribe.js';
import { executeVReddit } from '../../reddit/vreddit.js';
import { redditFetch, redditFetchBoth, type RedditFetchOptions } from '../../reddit/redditfetch.js';
import { fmtTokens, getProgressBar } from './message.handler.js';
import {
  detectPlatform,
  platformLabel,
  isValidUrl,
  extractMedia,
  cleanupExtractResult,
  type ExtractMode,
  type ExtractResult,
  type SubtitleFormat,
} from '../../media/extract.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { execFile, execSync, spawn } from 'child_process';
import { isMainThread } from 'worker_threads';
import { sanitizeError, sanitizePath } from '../../utils/sanitize.js';
import { getWorkspaceRoot, isPathWithinRoot } from '../../utils/workspace-guard.js';
import { getSessionKeyFromCtx, parseSessionKey } from '../../utils/session-key.js';
import { getPtyProvider } from '../../providers/claude-provider.js';
import {
  getDirectChildren,
  describeProcess,
  isDescendantOf,
  killTree,
  type ProcInfo,
} from '../../utils/proc-children.js';
import { taskTracker, type TaskState } from '../../telegram/task-tracker.js';
import { readRecentExchanges, readLastAiTitle, readLastAssistantTurnText, type RecapExchange } from '../../claude/session-jsonl.js';
import {
  VERBOSITY_INFO,
  isValidVerbosityLevel,
  getVerbosityLevel,
  type VerbosityLevel,
} from '../../utils/verbosity.js';

// Helper for consistent MarkdownV2 replies
async function replyMd(ctx: Context, text: string): Promise<void> {
  await ctx.reply(text, { parse_mode: 'MarkdownV2' });
}

/**
 * Resolve the session-key info and callback-data for a callback-query handler,
 * gated on the data starting with `prefix`. Returns null (so the caller can
 * early-return) when there is no session key, no callback data, or the data
 * doesn't match the prefix. Folds the repeated keyInfo + data guard preamble
 * that every prefix-scoped callback handler shares.
 */
export function parseCallback(
  ctx: Context,
  prefix: string,
): { chatId: number; threadId?: number; sessionKey: string; data: string } | null {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return null;
  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith(prefix)) return null;
  return { ...keyInfo, data };
}

function buildFeatureDisabledMessage(feature: string): string {
  return `⚠️ ${feature} feature is disabled in configuration.`;
}

// Per-session topic (ephemeral — not persisted across restarts)
const sessionTopics: Map<string, string> = new Map();
// Per-session timestamp of last setSessionTopic call. Used by the auto-topic
// reminder hook to skip the per-turn nudge when the topic was just updated.
const lastTopicSetAt: Map<string, number> = new Map();

/** Get the full label (e.g. "🐇 Low") for a chat's current effort level. */
export function getEffortLabel(chatId: number): string | undefined {
  const effort = getEffort(chatId);
  if (!effort) return undefined;
  return EFFORT_LEVELS.find((l) => l.id === effort)?.label;
}

/** Build the bot display name from base name and project. Topic now lives in the status line. */
function buildBotDisplayName(sessionKey: string): string {
  const session = sessionManager.getSession(sessionKey);
  const project = session?.workingDirectory ? path.basename(session.workingDirectory) : '';
  const parts: string[] = [config.BOT_NAME];
  if (project) parts.push(project);
  return parts.join(' — ').slice(0, 64);
}

/**
 * Push a display name to Telegram (rate-limited) and surface any block notice.
 * Swallows errors — a failed name update should never break the calling flow.
 * `context` is used only for the debug log so failures are attributable.
 */
async function pushBotName(ctx: Context, name: string, context: string): Promise<void> {
  try {
    const result = await rateLimitedSetMyName(ctx.api, (n) => ctx.api.setMyName(n), name);
    await notifyBotNameBlock(ctx, result);
  } catch (err) {
    console.debug(`[Bot] Failed to set bot name (${context}):`, err instanceof Error ? err.message : err);
  }
}

/** Update the Telegram bot display name to reflect the active project and topic. */
async function updateBotName(ctx: Context, sessionKey: string, projectPath: string): Promise<void> {
  if (!isBotNameEnabled(sessionKey)) return;
  await pushBotName(ctx, buildBotDisplayName(sessionKey), 'update');
}

/**
 * Clear the session topic and refresh the bot display name accordingly.
 * Called whenever the conversation context is wiped (clear, reset, project switch).
 */
export async function clearTopicAndRefreshBotName(ctx: Context, sessionKey: string): Promise<void> {
  setSessionTopic(sessionKey, '');
  if (!isBotNameEnabled(sessionKey)) return;
  await pushBotName(ctx, buildBotDisplayName(sessionKey), 'topic clear');
}

/**
 * Restore the session topic from the saved value (or clear if absent) and refresh
 * the bot display name. Called when resuming/continuing a previous conversation.
 *
 * When no persisted topic exists, fall back to Claude Code's `aiTitle` from the
 * session JSONL — better a stale session label than a blank topic line on resume.
 */
export async function restoreTopicAndRefreshBotName(ctx: Context, sessionKey: string, topic: string | undefined): Promise<void> {
  if (!topic) {
    const session = sessionManager.getSession(sessionKey);
    if (session?.claudeSessionId) {
      topic = readLastAiTitle(session.workingDirectory, session.claudeSessionId);
    }
  }
  setSessionTopic(sessionKey, topic || '');
  if (!isBotNameEnabled(sessionKey)) return;
  await pushBotName(ctx, buildBotDisplayName(sessionKey), 'topic restore');
}

/**
 * Set the session topic programmatically (used by MCP tool and auto-resume).
 * Returns the new display name string.
 */
export function setSessionTopic(sessionKey: string, topic: string): string {
  if (topic) {
    sessionTopics.set(sessionKey, topic);
  } else {
    sessionTopics.delete(sessionKey);
  }
  lastTopicSetAt.set(sessionKey, Date.now());
  // Persist so topic survives restarts
  sessionHistory.updateTopic(sessionKey, topic || undefined);
  return buildBotDisplayName(sessionKey);
}

/** Get the current session topic. */
export function getSessionTopic(sessionKey: string): string | undefined {
  return sessionTopics.get(sessionKey);
}

/** Milliseconds since the last setSessionTopic call (or undefined if never). */
export function getMsSinceTopicSet(sessionKey: string): number | undefined {
  const at = lastTopicSetAt.get(sessionKey);
  return at !== undefined ? Date.now() - at : undefined;
}

export async function handleTopic(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const text = ctx.message?.text || '';
  const topic = text.split(' ').slice(1).join(' ').trim();

  // Topic lives in the status line, not the Telegram bot name —
  // setSessionTopic updates in-memory + persistent state but the bot's
  // Telegram-side display name doesn't change, so no setMyName call.
  setSessionTopic(sessionKey, topic);
  await replyMd(ctx, topic ? `✅ Topic: *${esc(topic)}*` : '✅ Topic cleared');
}

export async function handleBotName(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const settings = getBotNameSettings(sessionKey);
  const currentStatus = settings.enabled ? 'ON' : 'OFF';

  const keyboard = [
    [
      {
        text: settings.enabled ? '✓ On' : 'On',
        callback_data: 'botname:on'
      },
      {
        text: !settings.enabled ? '✓ Off' : 'Off',
        callback_data: 'botname:off'
      },
    ],
  ];

  const description = settings.enabled
    ? '_Bot name updates to include the active project when switching_'
    : '_Bot name stays as configured in BOT\\_NAME_';

  await ctx.reply(
    `✏️ *Dynamic Bot Name*\n\nCurrent: *${currentStatus}*\n${description}`,
    {
      parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: keyboard },
    }
  );
}

export async function handleBotNameCallback(ctx: Context): Promise<void> {
  const cb = parseCallback(ctx, 'botname:');
  if (!cb) return;
  const { sessionKey, data } = cb;

  const newState = data.replace('botname:', '') === 'on';
  setBotNameEnabled(sessionKey, newState);

  const statusText = newState ? 'ON' : 'OFF';
  const description = newState
    ? '_Bot name updates to include the active project when switching_'
    : '_Bot name stays as configured in BOT\\_NAME_';

  await ctx.answerCallbackQuery({ text: `Dynamic bot name ${statusText}!` });
  await ctx.editMessageText(
    `✅ Dynamic Bot Name *${statusText}*\n\n${description}`,
    { parse_mode: 'MarkdownV2' }
  );

  // Reset bot name to base when disabling
  if (!newState) {
    await pushBotName(ctx, config.BOT_NAME, 'disable reset');
  }
}

async function replyFeatureDisabled(ctx: Context, feature: string): Promise<void> {
  await ctx.reply(buildFeatureDisabledMessage(feature), { parse_mode: undefined });
}

/** Build status lines appended to project confirmation messages. */
export function projectStatusSuffix(sessionKey: string): string {
  const { chatId } = parseSessionKey(sessionKey);
  const model = getModel(chatId);
  const provider = getActiveProviderName(chatId);
  const dangerous = isDangerousMode() ? '⚠️ ENABLED' : 'Disabled';
  const session = sessionManager.getSession(sessionKey);
  const created = session?.createdAt
    ? new Date(session.createdAt).toLocaleString()
    : new Date().toLocaleString();
  const sessionId = session?.claudeSessionId;

  const effortLabel = getEffortLabel(chatId) ?? 'Default';
  let suffix = `\n• *Provider:* ${esc(provider)}\n• *Model:* ${esc(model)}\n• *Effort:* ${esc(effortLabel)}\n• *Created:* ${esc(created)}\n• *Dangerous Mode:* ${esc(dangerous)}`;
  if (sessionId) {
    suffix += `\n• *Session ID:* \`${esc(sessionId)}\``;
    suffix += `\n\n💡 To continue this session from the terminal, copy the command below\\.`;
  } else {
    suffix += `\n• *Session ID:* _pending — send a message to start_`;
  }
  return suffix;
}

/** The copyable command sent as a separate message. */
export function resumeCommandMessage(sessionId: string): string {
  return `\`claude --resume ${sessionId}\``;
}

/** Truncate a string to fit within `maxBytes` UTF-8 bytes without splitting a codepoint. */
export function truncateToBytes(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  let out = '';
  for (const ch of s) {
    if (Buffer.byteLength(out + ch, 'utf8') > maxBytes) break;
    out += ch;
  }
  return out;
}

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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const BOTCTL_PATH = path.join(PROJECT_ROOT, 'scripts', 'claudegram-botctl.sh');
/** Write the reload marker so autoResumeAfterReload picks up sessions on restart. */
function writeReloadMarker(): void {
  try {
    const markerDir = path.dirname(getReloadMarkerPath());
    if (!fs.existsSync(markerDir)) {
      fs.mkdirSync(markerDir, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(
      getReloadMarkerPath(),
      JSON.stringify({ timestamp: new Date().toISOString() }),
      { mode: 0o600 }
    );
  } catch (err) {
    console.error('[ReloadMarker] Failed to write marker file:', err);
  }
}

/** Send Continue/Resume inline buttons for manual session restore. */
async function sendRestoreButtons(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  try {
    await ctx.api.sendMessage(chatId, '👇 Restore your session after restart:', {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '▶️ Continue', callback_data: 'restart:continue' },
            { text: '📜 Resume', callback_data: 'restart:resume' },
          ],
        ],
      },
    });
  } catch (e) {
    console.debug('[RestartBot] Failed to send restore buttons:', e instanceof Error ? e.message : e);
  }
}

const PROJECT_BROWSER_PAGE_SIZE = 8;

type ProjectBrowserState = {
  root: string;
  current: string;
  page: number;
};

const projectBrowserState = new Map<string, ProjectBrowserState>();

function botctlExists(): boolean {
  return fs.existsSync(BOTCTL_PATH);
}

type TTSMenuMode = 'main' | 'voices';

export function parseContextOutput(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return '⚠️ No context output received.';
  }

  const lines = trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let model = '';
  let tokensLine = '';
  const categories: Array<{ name: string; tokens: string; percent: string }> = [];
  let inCategories = false;

  for (const line of lines) {
    if (/^model:/i.test(line)) {
      model = line.replace(/^model:/i, '').trim();
      continue;
    }
    if (/^tokens:/i.test(line)) {
      tokensLine = line.replace(/^tokens:/i, '').trim();
      continue;
    }
    if (/estimated usage by category/i.test(line)) {
      inCategories = true;
      continue;
    }
    if (inCategories) {
      if (/^category/i.test(line)) continue;
      if (/^-+$/.test(line)) continue;

      const match = line.match(/^(.+?)\s{2,}([0-9.,kKmM]+)\s+([0-9.,]+%)$/);
      if (match) {
        categories.push({ name: match[1].trim(), tokens: match[2], percent: match[3] });
        continue;
      }

      const parts = line.split(/\s+/);
      if (parts.length >= 3 && parts[parts.length - 1].endsWith('%')) {
        const percent = parts.pop() as string;
        const tokens = parts.pop() as string;
        const name = parts.join(' ');
        categories.push({ name, tokens, percent });
      }
    }
  }

  if (!model && !tokensLine && categories.length === 0) {
    return `## 🧠 Context Usage\n\n\`\`\`\n${trimmed}\n\`\`\``;
  }

  let output = '## 🧠 Context Usage';
  if (model) output += `\n- **Model:** ${model}`;
  if (tokensLine) output += `\n- **Tokens:** ${tokensLine}`;

  if (categories.length > 0) {
    output += '\n\n### Estimated usage by category';
    for (const category of categories) {
      output += `\n- **${category.name}:** ${category.tokens} (${category.percent})`;
    }
  }

  output += '\n\n_If this looks stale, send a new message then run /context again._';
  return output;
}

const SESSION_ID_RE = /^[a-zA-Z0-9_-]{8,128}$/;

async function runClaudeContext(sessionId: string, cwd: string): Promise<string> {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error('Invalid session ID format');
  }
  return new Promise((resolve, reject) => {
    execFile(
      config.CLAUDE_EXECUTABLE_PATH,
      ['-p', '--resume', sessionId, '/context'],
      {
        cwd,
        timeout: 20_000,
        maxBuffer: 1024 * 1024,
        env: process.env,
      },
      (error, stdout, stderr) => {
        if (error) {
          const message = (stderr || error.message).trim();
          reject(new Error(message || 'Failed to run /context'));
          return;
        }
        resolve((stdout || stderr || '').trim());
      }
    );
  });
}

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
    `_When enabled, claudegram surfaces Claude Code's speculative next\\-prompt as an inline button under each response\\. Tap to send it as your next message\\._\n\n` +
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

function buildTelegraphMenu(sessionKey: string) {
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

export async function handleStart(ctx: Context): Promise<void> {
  const dangerousWarning = isDangerousMode()
    ? '\n\n⚠️ *DANGEROUS MODE ENABLED* \\- All tool permissions auto\\-approved'
    : '';

  const keyInfo = getSessionKeyFromCtx(ctx);
  const chatId = keyInfo ? parseSessionKey(keyInfo.sessionKey).chatId : undefined;
  const effortLabel = chatId !== undefined ? (getEffortLabel(chatId) ?? 'Default') : 'Default';

  const welcomeMessage = `👋 *Welcome to Claudegram\\!*

I bridge your messages to Claude Code running on your local machine\\.

*Getting Started:*
1\\. Set your project directory with \`/project /path/to/project\`
2\\. Start chatting with Claude about your code\\!

*Commands:*
• \`/project <path>\` \\- Open a project
• \`/newproject <name>\` \\- Create a new project
• \`/clear\` \\- Clear session and start fresh
• \`/status\` \\- Show current session info
• \`/commands\` \\- Show all available commands

Current mode: ${config.STREAMING_MODE}
Effort: ${esc(effortLabel)}${dangerousWarning}`;

  const currentConv = keyInfo
    ? sessionManager.getSession(keyInfo.sessionKey)?.conversationId
    : undefined;
  const backButton = keyInfo
    ? buildBackToPreviousButton(keyInfo.sessionKey, currentConv)
    : undefined;

  await ctx.reply(welcomeMessage, {
    parse_mode: 'MarkdownV2',
    ...(backButton ? { reply_markup: { inline_keyboard: backButton } } : {}),
  });
}

export async function handleClear(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  // After a bot restart the in-memory session map is empty; without this
  // pull-from-disk, startNewConversation silently no-ops and the project is
  // dropped, forcing the user to /project again. The default auto-restore
  // age cap doesn't apply here — the user is explicitly invoking /clear, so
  // any restorable project on disk should come back.
  sessionManager.getOrRestoreSession(sessionKey, Number.MAX_SAFE_INTEGER);

  const text = ctx.message?.text || '';
  const arg = text.split(' ').slice(1).join(' ').trim().toLowerCase();
  const skipConfirm = arg === '-y' || arg === '--yes' || arg === 'yes' || arg === 'force';

  if (skipConfirm) {
    clearConversation(sessionKey);
    sessionManager.startNewConversation(sessionKey);
    await clearTopicAndRefreshBotName(ctx, sessionKey);

    const session = sessionManager.getSession(sessionKey);
    const projectName = session ? path.basename(session.workingDirectory) : null;
    const msg = projectName
      ? `🔄 Conversation cleared\\. Project *${esc(projectName)}* is still selected\\.`
      : '🔄 Conversation cleared\\.';
    const newConv = session?.conversationId;
    const backButton = buildBackToPreviousButton(sessionKey, newConv);
    await ctx.reply(msg, {
      parse_mode: 'MarkdownV2',
      ...(backButton ? { reply_markup: { inline_keyboard: backButton } } : {}),
    });
    return;
  }

  const session = sessionManager.getSession(sessionKey);
  const projectName = session ? path.basename(session.workingDirectory) : 'current session';

  await ctx.reply(
    `⚠️ *Clear conversation?*\n\nThis wipes the conversation history for *${esc(projectName)}*\\. The project stays selected\\.\n\n_This cannot be undone\\._\n\n💡 Tip: \`/clear \\-y\` skips this confirmation\\.`,
    {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✓ Yes, clear it', callback_data: 'clear:confirm' },
            { text: '✗ Cancel', callback_data: 'clear:cancel' },
          ],
        ],
      },
    }
  );
}

export async function handleClearCallback(ctx: Context): Promise<void> {
  const cb = parseCallback(ctx, 'clear:');
  if (!cb) return;
  const { sessionKey, data } = cb;

  const action = data.replace('clear:', '');

  if (action === 'confirm') {
    // Same restore-from-disk guard as handleClear: a bot restart between the
    // confirm prompt and the tap would otherwise drop the project on confirm.
    sessionManager.getOrRestoreSession(sessionKey, Number.MAX_SAFE_INTEGER);
    // Preserve the working directory (project) — only wipe the conversation,
    // matching Claude Code's /clear semantics.
    clearConversation(sessionKey);
    sessionManager.startNewConversation(sessionKey);
    await clearTopicAndRefreshBotName(ctx, sessionKey);

    const session = sessionManager.getSession(sessionKey);
    const projectName = session ? path.basename(session.workingDirectory) : null;

    await ctx.answerCallbackQuery({ text: 'Conversation cleared!' });
    const msg = projectName
      ? `🔄 Conversation cleared\\. Project *${esc(projectName)}* is still selected\\.`
      : '🔄 Conversation cleared\\.';
    const newConv = session?.conversationId;
    const backButton = buildBackToPreviousButton(sessionKey, newConv);
    await ctx.editMessageText(msg, {
      parse_mode: 'MarkdownV2',
      ...(backButton ? { reply_markup: { inline_keyboard: backButton } } : {}),
    });
  } else {
    await ctx.answerCallbackQuery({ text: 'Cancelled' });
    await ctx.editMessageText('👍 Clear cancelled\\. Your session is intact\\.', { parse_mode: 'MarkdownV2' });
  }
}

async function selectProjectFromCallback(ctx: Context, sessionKey: string, projectPath: string): Promise<void> {
  sessionManager.setWorkingDirectory(sessionKey, projectPath);
  clearConversation(sessionKey);
  await clearTopicAndRefreshBotName(ctx, sessionKey);

  const state = getProjectState(sessionKey);
  state.current = projectPath;
  state.page = 0;

  const newConv = sessionManager.getSession(sessionKey)?.conversationId;
  const backButton = buildBackToPreviousButton(sessionKey, newConv);

  await ctx.editMessageText(
    `✅ Project: *${esc(path.basename(projectPath))}*\n\nYou can now chat with Claude about this project\\!${projectStatusSuffix(sessionKey)}`,
    {
      parse_mode: 'MarkdownV2',
      ...(backButton ? { reply_markup: { inline_keyboard: backButton } } : {}),
    },
  );

  const s = sessionManager.getSession(sessionKey);
  if (s?.claudeSessionId) {
    await replyMd(ctx, resumeCommandMessage(s.claudeSessionId));
  }
}

export async function handleProjectCallback(ctx: Context): Promise<void> {
  const cb = parseCallback(ctx, 'project:');
  if (!cb) return;
  const { sessionKey, data } = cb;

  const state = getProjectState(sessionKey);
  const action = data.split(':')[1] || '';

  if (action === 'manual') {
    await ctx.answerCallbackQuery();
    await sendProjectManualPrompt(ctx);
    return;
  }

  if (action === 'favorites') {
    await ctx.answerCallbackQuery();
    await sendFavoritesScreen(ctx, sessionKey, true);
    return;
  }

  if (action === 'browse') {
    syncProjectStateToSession(sessionKey);
    await ctx.answerCallbackQuery();
    await sendProjectBrowser(ctx, sessionKey, state, true);
    return;
  }

  if (action === 'fav-add-here') {
    const added = projectFavorites.add(sessionKey, state.current);
    await ctx.answerCallbackQuery({ text: added ? '⭐ Added to favorites' : 'Already a favorite' });
    await sendProjectBrowser(ctx, sessionKey, state, true);
    return;
  }

  if (action === 'fav-del-here') {
    const removed = projectFavorites.remove(sessionKey, state.current);
    await ctx.answerCallbackQuery({ text: removed ? 'Removed from favorites' : 'Not in favorites' });
    await sendProjectBrowser(ctx, sessionKey, state, true);
    return;
  }

  if (action === 'fav-add-current') {
    const session = sessionManager.getSession(sessionKey);
    if (!session) {
      await ctx.answerCallbackQuery({ text: 'No current project' });
      return;
    }
    const added = projectFavorites.add(sessionKey, session.workingDirectory);
    await ctx.answerCallbackQuery({ text: added ? '⭐ Added to favorites' : 'Already a favorite' });
    await sendFavoritesScreen(ctx, sessionKey, true);
    return;
  }

  if (action === 'fav-use') {
    const indexPart = data.split(':')[2];
    const index = Number.parseInt(indexPart || '', 10);
    if (Number.isNaN(index)) {
      await ctx.answerCallbackQuery({ text: 'Invalid selection' });
      return;
    }
    const favorites = projectFavorites.list(sessionKey);
    const fav = favorites[index];
    if (!fav) {
      await ctx.answerCallbackQuery({ text: 'Selection expired' });
      await sendFavoritesScreen(ctx, sessionKey, true);
      return;
    }
    if (!fs.existsSync(fav.path) || !fs.statSync(fav.path).isDirectory()) {
      await ctx.answerCallbackQuery({ text: 'Path no longer exists', show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: 'Project set' });
    await selectProjectFromCallback(ctx, sessionKey, fav.path);
    return;
  }

  if (action === 'fav-del') {
    const indexPart = data.split(':')[2];
    const index = Number.parseInt(indexPart || '', 10);
    if (Number.isNaN(index)) {
      await ctx.answerCallbackQuery({ text: 'Invalid selection' });
      return;
    }
    const favorites = projectFavorites.list(sessionKey);
    const fav = favorites[index];
    if (!fav) {
      await ctx.answerCallbackQuery({ text: 'Selection expired' });
      await sendFavoritesScreen(ctx, sessionKey, true);
      return;
    }
    projectFavorites.remove(sessionKey, fav.path);
    await ctx.answerCallbackQuery({ text: 'Removed' });
    await sendFavoritesScreen(ctx, sessionKey, true);
    return;
  }

  if (action === 'use') {
    await ctx.answerCallbackQuery({ text: 'Project set' });
    await selectProjectFromCallback(ctx, sessionKey, state.current);
    return;
  }

  if (action === 'up') {
    const parent = path.dirname(state.current);
    if (isWithinRoot(state.root, parent)) {
      state.current = parent;
      state.page = 0;
    }
    await ctx.answerCallbackQuery();
    await sendProjectBrowser(ctx, sessionKey, state, true);
    return;
  }

  if (action === 'page') {
    const direction = data.split(':')[2];
    if (direction === 'next') state.page += 1;
    if (direction === 'prev') state.page = Math.max(0, state.page - 1);
    await ctx.answerCallbackQuery();
    await sendProjectBrowser(ctx, sessionKey, state, true);
    return;
  }

  if (action === 'refresh') {
    await ctx.answerCallbackQuery();
    await sendProjectBrowser(ctx, sessionKey, state, true);
    return;
  }

  if (action === 'open') {
    const indexPart = data.split(':')[2];
    const index = Number.parseInt(indexPart || '', 10);
    if (Number.isNaN(index)) {
      await ctx.answerCallbackQuery({ text: 'Invalid selection' });
      return;
    }
    const entries = listDirectories(state.current);
    const selected = entries[index];
    if (!selected) {
      await ctx.answerCallbackQuery({ text: 'Selection expired' });
      await sendProjectBrowser(ctx, sessionKey, state, true);
      return;
    }
    const nextPath = path.join(state.current, selected);
    // Resolve symlinks before checking boundaries
    let resolvedPath: string;
    try {
      resolvedPath = fs.realpathSync(nextPath);
    } catch {
      await ctx.answerCallbackQuery({ text: 'Path not accessible' });
      return;
    }
    if (!isWithinRoot(state.root, resolvedPath)) {
      await ctx.answerCallbackQuery({ text: 'Outside workspace' });
      return;
    }
    state.current = resolvedPath;
    state.page = 0;
    await ctx.answerCallbackQuery();
    await sendProjectBrowser(ctx, sessionKey, state, true);
    return;
  }
}

function getProjectRoot(): string {
  return getWorkspaceRoot();
}

// Use shared isPathWithinRoot from workspace-guard for symlink-safe path validation
const isWithinRoot = isPathWithinRoot;

function listDirectories(dir: string): string[] {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function shortenName(name: string, maxLength: number = 24): string {
  if (name.length <= maxLength) return name;
  return `${name.slice(0, maxLength - 1)}…`;
}

function buildProjectBrowserText(state: ProjectBrowserState, totalDirs: number, totalPages: number): string {
  const pageNumber = totalPages === 0 ? 1 : state.page + 1;
  const safePath = esc(state.current);

  return (
    `📁 *Project Browser*\n\n` +
    `*Current:* \`${safePath}\`\n` +
    `*Folders:* ${totalDirs}\n` +
    `*Page:* ${pageNumber}/${Math.max(totalPages, 1)}\n\n` +
    `Select a folder below, or use the current folder\\.`
  );
}

function buildProjectBrowserKeyboard(state: ProjectBrowserState, entries: string[], totalPages: number, sessionKey: string): { inline_keyboard: { text: string; callback_data: string }[][] } {
  const rows: { text: string; callback_data: string }[][] = [];
  const pageOffset = state.page * PROJECT_BROWSER_PAGE_SIZE;

  for (let i = 0; i < entries.length; i += 2) {
    const row: { text: string; callback_data: string }[] = [];
    const first = entries[i];
    const second = entries[i + 1];

    if (first) {
      const index = pageOffset + i;
      row.push({ text: `📁 ${shortenName(first)}`, callback_data: `project:open:${index}` });
    }
    if (second) {
      const index = pageOffset + i + 1;
      row.push({ text: `📁 ${shortenName(second)}`, callback_data: `project:open:${index}` });
    }
    if (row.length > 0) rows.push(row);
  }

  const navRow: { text: string; callback_data: string }[] = [];
  if (state.current !== state.root) {
    navRow.push({ text: '⬆️ Up', callback_data: 'project:up' });
  }
  navRow.push({ text: '✅ Use this folder', callback_data: 'project:use' });
  const isFav = projectFavorites.has(sessionKey, state.current);
  navRow.push({
    text: isFav ? '★ Unfavorite' : '⭐ Favorite',
    callback_data: isFav ? 'project:fav-del-here' : 'project:fav-add-here',
  });
  rows.push(navRow);

  const utilRow: { text: string; callback_data: string }[] = [
    { text: '⭐ Favorites', callback_data: 'project:favorites' },
    { text: '✍️ Enter path', callback_data: 'project:manual' },
  ];
  rows.push(utilRow);

  const pageRow: { text: string; callback_data: string }[] = [];
  if (state.page > 0) {
    pageRow.push({ text: '◀️ Prev', callback_data: 'project:page:prev' });
  }
  if (state.page < totalPages - 1) {
    pageRow.push({ text: 'Next ▶️', callback_data: 'project:page:next' });
  }
  if (pageRow.length > 0) {
    rows.push(pageRow);
  }

  rows.push([{ text: '🔄 Refresh', callback_data: 'project:refresh' }]);

  return { inline_keyboard: rows };
}

async function sendProjectBrowser(ctx: Context, sessionKey: string, state: ProjectBrowserState, edit: boolean): Promise<void> {
  const allEntries = listDirectories(state.current);
  const totalPages = Math.max(1, Math.ceil(allEntries.length / PROJECT_BROWSER_PAGE_SIZE));
  const page = Math.min(Math.max(state.page, 0), totalPages - 1);
  state.page = page;

  const pageEntries = allEntries.slice(page * PROJECT_BROWSER_PAGE_SIZE, (page + 1) * PROJECT_BROWSER_PAGE_SIZE);
  const text = buildProjectBrowserText(state, allEntries.length, totalPages);
  const replyMarkup = buildProjectBrowserKeyboard(state, pageEntries, totalPages, sessionKey);

  if (edit) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', reply_markup: replyMarkup });
      return;
    } catch {
      // fall through to send new message
    }
  }

  await ctx.reply(text, { parse_mode: 'MarkdownV2', reply_markup: replyMarkup });
}

const FAVORITES_DISPLAY_MAX = 12;

function buildFavoritesScreen(sessionKey: string): { text: string; reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } } {
  const favorites = projectFavorites.list(sessionKey).slice(0, FAVORITES_DISPLAY_MAX);
  const session = sessionManager.getSession(sessionKey);
  const currentPath = session?.workingDirectory;
  const currentIsFav = currentPath ? projectFavorites.has(sessionKey, currentPath) : false;

  const lines = ['⭐ *Project Favorites*'];
  if (currentPath) {
    lines.push('', `*Current:* \`${esc(currentPath)}\``);
  }
  if (favorites.length === 0) {
    lines.push('', '_No favorites yet\\. Browse the workspace or enter a path, then tap ⭐ to save it here\\._');
  } else {
    lines.push('', '_Pick a favorite, or use the buttons below\\._');
  }

  const rows: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < favorites.length; i++) {
    const fav = favorites[i];
    const name = path.basename(fav.path) || fav.path;
    rows.push([
      { text: `📁 ${shortenName(name, 28)}`, callback_data: `project:fav-use:${i}` },
      { text: '🗑️', callback_data: `project:fav-del:${i}` },
    ]);
  }

  const actionRow: { text: string; callback_data: string }[] = [];
  if (currentPath && !currentIsFav) {
    actionRow.push({ text: '⭐ Add current', callback_data: 'project:fav-add-current' });
  }
  actionRow.push({ text: '🗂️ Browse', callback_data: 'project:browse' });
  actionRow.push({ text: '✍️ Enter path', callback_data: 'project:manual' });
  rows.push(actionRow);

  return { text: lines.join('\n'), reply_markup: { inline_keyboard: rows } };
}

async function sendFavoritesScreen(ctx: Context, sessionKey: string, edit: boolean): Promise<void> {
  const { text, reply_markup } = buildFavoritesScreen(sessionKey);
  if (edit) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', reply_markup });
      return;
    } catch {
      // fall through
    }
  }
  await ctx.reply(text, { parse_mode: 'MarkdownV2', reply_markup });
}

async function sendProjectManualPrompt(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;
  const session = sessionManager.getSession(sessionKey);
  const currentInfo = session
    ? `\n\n_Current: ${esc(path.basename(session.workingDirectory))}_`
    : '';

  await ctx.reply(
    `📁 *Set Project Directory*${currentInfo}\n\n👇 _Enter the path below:_`,
    {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        force_reply: true,
        input_field_placeholder: '/home/user/projects/myapp',
        selective: true,
      },
    }
  );
}

function getProjectState(sessionKey: string): ProjectBrowserState {
  const root = getProjectRoot();
  const existing = projectBrowserState.get(sessionKey);
  if (existing && existing.root === root) {
    if (!isWithinRoot(root, existing.current)) {
      existing.current = root;
      existing.page = 0;
    }
    // Refresh timestamp on access to keep active sessions alive
    projectBrowserTimestamps.set(sessionKey, Date.now());
    return existing;
  }

  const session = sessionManager.getSession(sessionKey);
  let initial = root;
  if (session && isWithinRoot(root, session.workingDirectory)) {
    initial = session.workingDirectory;
  }

  const state: ProjectBrowserState = {
    root,
    current: path.resolve(initial),
    page: 0,
  };
  projectBrowserState.set(sessionKey, state);
  projectBrowserTimestamps.set(sessionKey, Date.now());
  return state;
}

/**
 * Reset the browser to start at the session's current working directory.
 * Called when the user enters the browser fresh (e.g. via the Favorites
 * screen's "Browse" button), so MCP-driven project switches are reflected.
 * Not called on Up/Refresh/Page/Open — those preserve the user's navigation.
 */
function syncProjectStateToSession(sessionKey: string): void {
  const state = getProjectState(sessionKey);
  const session = sessionManager.getSession(sessionKey);
  if (session && isWithinRoot(state.root, session.workingDirectory)) {
    state.current = session.workingDirectory;
    state.page = 0;
  }
}

export async function handleProject(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const text = ctx.message?.text || '';
  const args = text.split(' ').slice(1).join(' ').trim();

  // No args - show favorites screen (falls through to browser if user taps Browse)
  if (!args) {
    await sendFavoritesScreen(ctx, sessionKey, false);
    return;
  }

  let projectPath: string;
  const workspaceRoot = getWorkspaceRoot();

  if (args.startsWith('/') || args.startsWith('~')) {
    // Absolute/home-relative paths are allowed to escape the workspace root —
    // the user has explicitly typed a full path.
    projectPath = args;
    if (projectPath.startsWith('~')) {
      projectPath = path.join(process.env.HOME || '', projectPath.slice(1));
    }
    projectPath = path.resolve(projectPath);
  } else {
    projectPath = path.join(workspaceRoot, args);
  }

  if (!fs.existsSync(projectPath)) {
    await replyMd(ctx, `📁 Project "${esc(args)}" doesn't exist\\.\n\nCreate it? Use: \`/newproject ${esc(args)}\``);
    return;
  }

  if (!fs.statSync(projectPath).isDirectory()) {
    await replyMd(ctx, `❌ Path is not a directory: \`${esc(projectPath)}\``);
    return;
  }

  sessionManager.setWorkingDirectory(sessionKey, projectPath);
  clearConversation(sessionKey);
  await clearTopicAndRefreshBotName(ctx, sessionKey);

  const newConv = sessionManager.getSession(sessionKey)?.conversationId;
  const backButton = buildBackToPreviousButton(sessionKey, newConv);
  await ctx.reply(`✅ Project: *${esc(args)}*\n\nYou can now chat with Claude about this project\\!${projectStatusSuffix(sessionKey)}`, {
    parse_mode: 'MarkdownV2',
    ...(backButton ? { reply_markup: { inline_keyboard: backButton } } : {}),
  });

  const s = sessionManager.getSession(sessionKey);
  if (s?.claudeSessionId) {
    await replyMd(ctx, resumeCommandMessage(s.claudeSessionId));
  }
}

export async function handleNewProject(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const text = ctx.message?.text || '';
  const args = text.split(' ').slice(1).join(' ').trim();

  if (!args) {
    await replyMd(ctx, 'Usage: `/newproject <name>`');
    return;
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(args)) {
    await replyMd(ctx, '❌ Project name can only contain letters, numbers, dashes and underscores\\.');
    return;
  }

  const projectPath = path.join(config.WORKSPACE_DIR, args);

  if (fs.existsSync(projectPath)) {
    await replyMd(ctx, `❌ Project "${esc(args)}" already exists\\. Use \`/project ${esc(args)}\` to open it\\.`);
    return;
  }

  fs.mkdirSync(projectPath, { recursive: true, mode: 0o700 });
  sessionManager.setWorkingDirectory(sessionKey, projectPath);
  clearConversation(sessionKey);
  await clearTopicAndRefreshBotName(ctx, sessionKey);

  const newConv = sessionManager.getSession(sessionKey)?.conversationId;
  const backButton = buildBackToPreviousButton(sessionKey, newConv);
  await ctx.reply(`✅ Created and opened: *${esc(args)}*\n\nYou can now chat with Claude about this project\\!${projectStatusSuffix(sessionKey)}`, {
    parse_mode: 'MarkdownV2',
    ...(backButton ? { reply_markup: { inline_keyboard: backButton } } : {}),
  });

  const s = sessionManager.getSession(sessionKey);
  if (s?.claudeSessionId) {
    await replyMd(ctx, resumeCommandMessage(s.claudeSessionId));
  }
}

function listProjects(): string[] {
  try {
    const entries = fs.readdirSync(config.WORKSPACE_DIR, { withFileTypes: true });
    return entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name)
      .sort();
  } catch {
    return [];
  }
}

function listProjectFiles(projectPath: string, maxDepth: number = 2): string[] {
  const files: string[] = [];

  function walk(dir: string, depth: number, prefix: string = '') {
    if (depth > maxDepth) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isFile()) {
          files.push(relativePath);
        } else if (entry.isDirectory() && depth < maxDepth) {
          walk(path.join(dir, entry.name), depth + 1, relativePath);
        }
      }
    } catch {
      // Ignore permission errors
    }
  }

  walk(projectPath, 0);
  // Sort by common file types first (README, package.json, src files)
  return files.sort((a, b) => {
    const priority = (f: string) => {
      if (f === 'README.md') return 0;
      if (f === 'package.json') return 1;
      if (f.startsWith('src/')) return 2;
      if (f.endsWith('.md')) return 3;
      return 4;
    };
    return priority(a) - priority(b);
  });
}

function listMarkdownFiles(projectPath: string, maxDepth: number = 3): string[] {
  const files: string[] = [];

  function walk(dir: string, depth: number, prefix: string = '') {
    if (depth > maxDepth) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (ext === '.md' || ext === '.markdown') {
            files.push(relativePath);
          }
        } else if (entry.isDirectory() && depth < maxDepth) {
          walk(path.join(dir, entry.name), depth + 1, relativePath);
        }
      }
    } catch {
      // Ignore permission errors
    }
  }

  walk(projectPath, 0);
  // Sort README first, then by path
  return files.sort((a, b) => {
    const priority = (f: string) => {
      if (f === 'README.md') return 0;
      if (f === 'CHANGELOG.md') return 1;
      if (f.includes('docs/')) return 2;
      return 3;
    };
    const pa = priority(a), pb = priority(b);
    if (pa !== pb) return pa - pb;
    return a.localeCompare(b);
  });
}

export async function handleStatus(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) {
    await ctx.reply('❌ Could not determine chat context for /status.');
    return;
  }

  try {
    const { sessionKey } = keyInfo;
    const { chatId } = parseSessionKey(sessionKey);

    const session = sessionManager.getSession(sessionKey);

    if (!session) {
      await replyMd(ctx, 'ℹ️ No active session\\.\n\nUse `/project /path/to/project` to get started\\.');
      return;
    }

    const currentModel = getModel(chatId);
    const provider = getActiveProviderName(chatId);
    const dangerousMode = isDangerousMode() ? '⚠️ ENABLED' : 'Disabled';
    const effortLabel = getEffortLabel(chatId) ?? 'Default';
    const topic = getSessionTopic(sessionKey);

    const projectName = path.basename(session.workingDirectory);

    // On CCR, the SDK alias doesn't reflect which backend actually served
    // the turn — CCR picks per-request based on its router config. We
    // don't try to discover the true backend (would require log parsing).
    // The "Provider: ccr" line below already signals the routing.
    const cached = getCachedUsage(sessionKey);
    const modelLine =
      provider === 'ccr'
        ? `${esc(currentModel)} _\\(routed via CCR\\)_`
        : esc(currentModel);

    let status = `📊 *Session Status*

🤖 *Bot Name:* ${esc(config.BOT_NAME)}
📦 *Project:* ${esc(projectName)}
🏷️ *Topic:* ${topic ? esc(topic) : '_none_'}
🎚️ *Effort:* ${esc(effortLabel)}
🧠 *Model:* ${modelLine}
🔌 *Provider:* ${esc(provider)}
🆔 *Session ID:* \`${esc(session.claudeSessionId ?? session.conversationId)}\`
📁 *Working Directory:* \`${esc(session.workingDirectory)}\`
📡 *Mode:* ${esc(config.STREAMING_MODE)}
${isDangerousMode() ? '⚠️' : '🛡️'} *Dangerous Mode:* ${esc(dangerousMode)}`;
    if (cached) {
      const pct = cached.contextWindow > 0
        ? Math.round(((cached.inputTokens + cached.outputTokens) / cached.contextWindow) * 100)
        : 0;
      status += `\n📐 *Context:* ${esc(String(pct))}% \\(${esc(fmtTokens(cached.inputTokens + cached.outputTokens))}/${esc(fmtTokens(cached.contextWindow))}\\)`;
      status += `\n💰 *Session Cost:* \\$${esc(cached.totalCostUsd.toFixed(4))}`;
    }

    status += `\n🕰️ *Created:* ${esc(session.createdAt.toLocaleString())}`;
    status += `\n⏱️ *Last Activity:* ${esc(session.lastActivity.toLocaleString())}`;
    status += `\n⏳ *Uptime:* ${esc(getUptimeFormatted())}`;

    await replyMd(ctx, status);
  } catch (err) {
    console.error('[Status] Error:', err);
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.reply(`❌ /status failed: ${msg}`).catch(() => {});
  }
}

// Runtime streaming mode (can be toggled, defaults to config)
let runtimeStreamingMode: 'streaming' | 'wait' = config.STREAMING_MODE;

export function getStreamingMode(): 'streaming' | 'wait' {
  return runtimeStreamingMode;
}

export async function handleMode(ctx: Context): Promise<void> {
  const keyboard = [
    [
      {
        text: runtimeStreamingMode === 'streaming' ? '✓ Streaming' : 'Streaming',
        callback_data: 'mode:streaming'
      },
      {
        text: runtimeStreamingMode === 'wait' ? '✓ Wait' : 'Wait',
        callback_data: 'mode:wait'
      },
    ],
  ];

  const description = runtimeStreamingMode === 'streaming'
    ? '_Updates progressively as Claude types_'
    : '_Shows complete response when done_';

  await ctx.reply(
    `⚙️ *Response Mode*\n\nCurrent: *${runtimeStreamingMode}*\n${description}`,
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
  runtimeStreamingMode = newMode;

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

export async function handlePing(ctx: Context): Promise<void> {
  const uptime = getUptimeFormatted();
  await replyMd(ctx, `🏓 Pong\\!\n\nUptime: ${esc(uptime)}`);
}

export async function handleContext(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { chatId, sessionKey } = keyInfo;

  const session = sessionManager.getSession(sessionKey);
  if (!session) {
    await ctx.reply(
      '⚠️ No project set\\.\n\nIf the bot restarted, use `/continue` or `/resume` to restore your last session\\.\nOr use `/project` to open a project first\\.',
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  // Try cached SDK usage first (instant, no CLI shell-out)
  const cached = getCachedUsage(sessionKey);
  if (cached) {
    const pct = cached.contextWindow > 0
      ? Math.round(((cached.inputTokens + cached.outputTokens + cached.cacheReadTokens) / cached.contextWindow) * 100)
      : 0;
    const bar = getProgressBar(pct);

    const output = `## 🧠 Context Usage\n\n`
      + `${bar} **${pct}%** of context window\n\n`
      + `- **Model:** ${cached.model}\n`
      + `- **Input tokens:** ${fmtTokens(cached.inputTokens)}\n`
      + `- **Output tokens:** ${fmtTokens(cached.outputTokens)}\n`
      + `- **Cache read:** ${fmtTokens(cached.cacheReadTokens)}\n`
      + `- **Cache write:** ${fmtTokens(cached.cacheWriteTokens)}\n`
      + `- **Context window:** ${fmtTokens(cached.contextWindow)}\n`
      + `- **Turns this session:** ${cached.numTurns}\n`
      + `- **Cost this query:** $${cached.totalCostUsd.toFixed(4)}\n\n`
      + `_Data from last query. Send a message then run /context for fresh data._`;

    await messageSender.sendMessage(ctx, output);
    return;
  }

  // Fallback: CLI shell-out approach (Claude only)
  if (getActiveProviderName(chatId) === 'opencode') {
    await replyMd(ctx, '⚠️ No usage data yet\\.\n\nSend a message first, then run `/context` again\\.');
    return;
  }
  if (!session.claudeSessionId) {
    await replyMd(
      ctx,
      '⚠️ No Claude session ID found\\.\n\nSend a message to Claude after resuming, then run `/context` again\\.'
    );
    return;
  }

  const ack = await ctx.reply('🧠 Checking context...', { parse_mode: undefined });

  try {
    const raw = await runClaudeContext(session.claudeSessionId, session.workingDirectory);
    const formatted = parseContextOutput(raw);
    await messageSender.sendMessage(ctx, formatted);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const hint = message.toLowerCase().includes('unknown') || message.toLowerCase().includes('command')
      ? '\n\nThis CLI may not support `/context` yet.'
      : '';
    await messageSender.sendMessage(ctx, `❌ Failed to fetch context: ${message}${hint}`);
  } finally {
    try {
      await ctx.api.deleteMessage(chatId, ack.message_id);
    } catch {
      // ignore cleanup errors
    }
  }
}

export async function handleBotStatus(ctx: Context): Promise<void> {
  const uptimeSec = process.uptime();
  const hours = Math.floor(uptimeSec / 3600);
  const minutes = Math.floor((uptimeSec % 3600) / 60);
  const seconds = Math.floor(uptimeSec % 60);
  const uptimeStr = hours > 0
    ? `${hours}h ${minutes}m ${seconds}s`
    : minutes > 0
      ? `${minutes}m ${seconds}s`
      : `${seconds}s`;

  const mode = config.BOT_MODE === 'prod' ? 'Production' : 'Development';
  const keyInfo = getSessionKeyFromCtx(ctx);
  const model = keyInfo ? getModel(keyInfo.chatId) : 'opus';
  const streaming = config.STREAMING_MODE || 'streaming';
  const pid = process.pid;
  const memMB = (process.memoryUsage.rss() / 1024 / 1024).toFixed(1);

  const msg =
    `🟢 *${esc(config.BOT_NAME)} is running*\n\n` +
    `*Mode:* ${esc(mode)}\n` +
    `*Uptime:* ${esc(uptimeStr)}\n` +
    `*PID:* ${pid}\n` +
    `*Memory:* ${esc(memMB)} MB\n` +
    `*Model:* ${esc(model)}\n` +
    `*Streaming:* ${esc(streaming)}`;

  await replyMd(ctx, msg);
}

type RestartScope = 'one' | 'all';

async function performRestart(ctx: Context, scope: RestartScope): Promise<void> {
  // Multi-instance mode (worker thread) — restart via launcher, not shell script
  if (!isMainThread) {
    if (scope === 'all') {
      if (config.AUTO_RESTORE_SESSION) {
        await replyMd(ctx, '🔁 Restarting all bot instances\\.\n\n⏳ Sessions will be restored automatically\\.');
      } else {
        await replyMd(ctx, '🔁 Restarting all bot instances\\.\n\n⏳ Please wait ~10 seconds\\.');
        await sendRestoreButtons(ctx);
      }
      // Marker writing for sibling bots happens in the launcher — it has the
      // tokens to derive each bot's marker path. We can't write them here.
      const { requestRestartAll } = await import('../../index.js');
      requestRestartAll(config.AUTO_RESTORE_SESSION);
      return;
    }

    if (config.AUTO_RESTORE_SESSION) {
      await replyMd(ctx, '🔁 Restarting this bot instance\\.\n\n⏳ Session will be restored automatically\\.');
      writeReloadMarker();
    } else {
      await replyMd(ctx, '🔁 Restarting this bot instance\\.\n\n⏳ Other bots will not be affected\\. Please wait ~10 seconds\\.');
      await sendRestoreButtons(ctx);
    }

    const { requestRestart } = await import('../../index.js');
    requestRestart();
    return;
  }

  // Single-instance mode — use shell script to restart the whole process
  if (!botctlExists()) {
    await replyMd(ctx, '❌ Bot control script not found\\.\n\nExpected at `scripts/claudegram-botctl.sh`\\.');
    return;
  }

  if (config.AUTO_RESTORE_SESSION) {
    await replyMd(ctx, '🔁 Restarting bot\\.\n\n⏳ Session will be restored automatically\\.');
    writeReloadMarker();
  } else {
    await replyMd(ctx, '🔁 Restarting bot\\.\n\n⏳ Please wait at least *10\\-15 seconds* before checking status or resuming\\.');
    await sendRestoreButtons(ctx);
  }

  try {
    const child = spawn(
      BOTCTL_PATH,
      ['recover'],
      { cwd: PROJECT_ROOT, detached: true, stdio: 'ignore', env: { ...process.env, MODE: config.BOT_MODE } }
    );
    child.unref();
  } catch (error) {
    console.error('[BotCtl] Failed to restart:', sanitizeError(error));
  }
}

export async function handleRestartBot(ctx: Context): Promise<void> {
  const args = ctx.message?.text?.split(/\s+/).slice(1).join(' ').trim();

  // Cross-bot restart: /restartbot <name> — direct, no menu
  if (args && !isMainThread && args.toLowerCase() !== 'all' && args.toLowerCase() !== 'one' && args.toLowerCase() !== 'this') {
    const { requestSiblingRestart } = await import('../../index.js');
    const result = await requestSiblingRestart(args, config.AUTO_RESTORE_SESSION);
    if (result.success) {
      await replyMd(ctx, `🔁 Restarting *${esc(result.name ?? args)}*\\.\\.\\. it should be back in ~10 seconds\\.`);
    } else {
      await replyMd(ctx, `❌ Could not restart *${esc(args)}*: ${esc(result.reason ?? 'unknown error')}`);
    }
    return;
  }

  // Legacy direct invocations: /restartbot all | /restartbot one | /restartbot this
  if (args?.toLowerCase() === 'all') {
    await performRestart(ctx, 'all');
    return;
  }
  if (args?.toLowerCase() === 'one' || args?.toLowerCase() === 'this') {
    await performRestart(ctx, 'one');
    return;
  }

  // Single-instance mode: only one process exists, so just confirm.
  if (isMainThread) {
    await ctx.reply('🔁 Restart the bot?', {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Restart', callback_data: 'restartbot:one' },
            { text: '❌ Cancel', callback_data: 'restartbot:cancel' },
          ],
        ],
      },
    });
    return;
  }

  // Multi-instance (worker) mode: offer this/all/cancel
  await ctx.reply('🔁 Restart which?', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔧 This instance only', callback_data: 'restartbot:one' }],
        [{ text: '🌐 All instances', callback_data: 'restartbot:all' }],
        [{ text: '❌ Cancel', callback_data: 'restartbot:cancel' }],
      ],
    },
  });
}

export async function handleRestartBotCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  await ctx.answerCallbackQuery();

  // Remove the menu keyboard so it can't be tapped twice
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
  } catch {
    // ignore — message may have been edited or deleted
  }

  if (data === 'restartbot:cancel') {
    await ctx.reply('❌ Restart cancelled.');
    return;
  }

  if (data === 'restartbot:all') {
    await performRestart(ctx, 'all');
    return;
  }

  if (data === 'restartbot:one') {
    await performRestart(ctx, 'one');
    return;
  }
}

export async function handleRestartCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  if (data === 'restart:continue') {
    await ctx.answerCallbackQuery();
    await handleContinue(ctx);
  } else if (data === 'restart:resume') {
    await ctx.answerCallbackQuery();
    await handleResume(ctx);
  } else {
    await ctx.answerCallbackQuery();
  }
}

export async function handleStartupCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  await ctx.answerCallbackQuery();

  // Remove the inline keyboard so the buttons can't be tapped twice.
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
  } catch {
    // ignore — message may have been edited or deleted
  }

  if (data === 'startup:continue') {
    await handleContinue(ctx);
    return;
  }

  if (data === 'startup:fresh') {
    // No session is in memory at this point — the next user message will
    // naturally start a new conversation. Just acknowledge the choice.
    await replyMd(ctx, '🆕 Starting fresh\\. Send a message to begin a new session\\.');
    return;
  }
}

type RebuildScope = 'one' | 'all';

async function performRebuild(ctx: Context, scope: RebuildScope): Promise<void> {
  // Step 1: Build
  await ctx.reply('🔨 Building...');

  try {
    execSync('npm run build', {
      cwd: PROJECT_ROOT,
      timeout: 120_000,
      stdio: 'pipe',
    });
  } catch (error: unknown) {
    const err = error as { stderr?: Buffer; message?: string };
    const stderr = err.stderr?.toString().slice(-500) || err.message || 'Unknown build error';
    await ctx.reply(`❌ Build failed. Aborting reload.\n\n${stderr.slice(0, 400)}`);
    return;
  }

  // Step 2: Restart. For 'all', the launcher writes markers for every sibling
  // (we can't — markers live at per-bot paths keyed by each bot's token). For
  // 'one' and single-instance, write the local marker now.
  if (!isMainThread) {
    if (scope === 'all') {
      await ctx.reply('✅ Build succeeded. Restarting all instances...');
      const { requestRestartAll } = await import('../../index.js');
      requestRestartAll(config.AUTO_RESTORE_SESSION);
    } else {
      if (config.AUTO_RESTORE_SESSION) writeReloadMarker();
      await ctx.reply('✅ Build succeeded. Restarting this instance...');
      if (!config.AUTO_RESTORE_SESSION) await sendRestoreButtons(ctx);
      const { requestRestart } = await import('../../index.js');
      requestRestart();
    }
    return;
  }

  if (config.AUTO_RESTORE_SESSION) writeReloadMarker();

  // Single-instance mode (scope is moot — only one process)
  await ctx.reply('✅ Build succeeded. Restarting...');
  if (!config.AUTO_RESTORE_SESSION) await sendRestoreButtons(ctx);

  if (!botctlExists()) {
    await replyMd(ctx, 'Build OK but cannot restart: `scripts/claudegram\\-botctl\\.sh` not found\\.');
    return;
  }

  try {
    const child = spawn(
      BOTCTL_PATH,
      ['recover'],
      { cwd: PROJECT_ROOT, detached: true, stdio: 'ignore', env: { ...process.env, MODE: config.BOT_MODE } }
    );
    child.unref();
  } catch (error) {
    console.error('[Reload] Failed to restart via botctl:', sanitizeError(error));
  }
}

export async function handleRebuild(ctx: Context): Promise<void> {
  const args = ctx.message?.text?.split(/\s+/).slice(1).join(' ').trim();

  // Legacy direct invocation: /rebuildbot all
  if (args?.toLowerCase() === 'all') {
    await performRebuild(ctx, 'all');
    return;
  }
  if (args?.toLowerCase() === 'one' || args?.toLowerCase() === 'this') {
    await performRebuild(ctx, 'one');
    return;
  }

  // Single-instance mode: only one process exists, so skip the this-vs-all
  // distinction and just confirm.
  if (isMainThread) {
    await ctx.reply('🔄 Rebuild and restart the bot?', {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Rebuild', callback_data: 'rebuild:one' },
            { text: '❌ Cancel', callback_data: 'rebuild:cancel' },
          ],
        ],
      },
    });
    return;
  }

  // Multi-instance (worker) mode: offer this/all/cancel
  await ctx.reply('🔄 Rebuild and restart which?', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔧 This instance only', callback_data: 'rebuild:one' }],
        [{ text: '🌐 All instances', callback_data: 'rebuild:all' }],
        [{ text: '❌ Cancel', callback_data: 'rebuild:cancel' }],
      ],
    },
  });
}

export async function handleRebuildCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  await ctx.answerCallbackQuery();

  // Remove the menu keyboard so it can't be tapped twice
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
  } catch {
    // ignore — message may have been edited or deleted
  }

  if (data === 'rebuild:cancel') {
    await ctx.reply('❌ Rebuild cancelled.');
    return;
  }

  if (data === 'rebuild:all') {
    await performRebuild(ctx, 'all');
    return;
  }

  if (data === 'rebuild:one') {
    await performRebuild(ctx, 'one');
    return;
  }
}

export async function handleCancel(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const wasProcessing = isProcessing(sessionKey);
  const cancelled = await cancelRequest(sessionKey);
  const clearedCount = clearQueue(sessionKey);

  if (cancelled || clearedCount > 0) {
    let message = '🛑 Cancelled\\.';
    if (clearedCount > 0) {
      message += ` \\(${clearedCount} queued request${clearedCount > 1 ? 's' : ''} cleared\\)`;
    }
    await replyMd(ctx, message);
  } else if (!wasProcessing) {
    await replyMd(ctx, 'ℹ️ Nothing to cancel\\.');
  }
}

export async function handleCommands(ctx: Context): Promise<void> {
  await replyMd(ctx, getAvailableCommands());
}

export async function handleModelCommand(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { chatId } = keyInfo;

  const text = ctx.message?.text || '';
  const args = text.split(' ').slice(1).join(' ').trim().toLowerCase();

  const providerName = getActiveProviderName(chatId);
  const models = await getAvailableModels(chatId);
  const validIds = models.map(m => m.id);

  if (!args) {
    const currentModel = getModel(chatId);

    const keyboard = models.map((m) => {
      const isCurrent = m.id === currentModel;
      const label = isCurrent ? `✓ ${m.label}` : m.label;
      return [{ text: label, callback_data: `model:${m.id}` }];
    });

    const descriptions = models
      .map(m => `• *${esc(m.label)}* \\- ${esc(m.description || '')}`)
      .join('\n');

    await ctx.reply(
      `🤖 *Select Model* \\(${esc(providerName)}\\)\n\n_Current: ${esc(currentModel)}_\n\n${descriptions}`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          inline_keyboard: keyboard,
        },
      }
    );
    return;
  }

  if (!validIds.includes(args)) {
    await replyMd(ctx, `❌ Unknown model "${esc(args)}"\\.\n\nAvailable: ${validIds.join(', ')}`);
    return;
  }

  setModel(chatId, args);
  await replyMd(ctx, `✅ Model set to *${esc(args)}*`);
}

export async function handleModelCallback(ctx: Context): Promise<void> {
  const cb = parseCallback(ctx, 'model:');
  if (!cb) return;
  const { chatId, data } = cb;

  const model = data.replace('model:', '');

  // Validate against current provider's models
  const models = await getAvailableModels(chatId);
  const validIds = models.map(m => m.id);

  if (!validIds.includes(model)) {
    await ctx.answerCallbackQuery({ text: 'Invalid model' });
    return;
  }

  setModel(chatId, model);

  const modelInfo = models.find(m => m.id === model);
  const displayName = modelInfo?.label || model;

  await ctx.answerCallbackQuery({ text: `Model set to ${displayName}!` });
  await ctx.editMessageText(
    `✅ Model set to *${esc(displayName)}*`,
    { parse_mode: 'MarkdownV2' }
  );
}

const PROVIDER_DESCRIPTIONS: Record<ProviderName, string> = {
  claude: '*claude* \\- Claude Code SDK \\(Anthropic / Max\\)',
  ccr: '*ccr* \\- Routed via Claude Code Router \\(alt providers\\)',
  opencode: '*opencode* \\- OpenCode \\(75\\+ LLM providers\\)',
};

export async function handleProviderCommand(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const providers = getAvailableProviders();
  const active = getActiveProviderName(chatId);

  const keyboard = providers.map((p) => {
    const label = p === active ? `✓ ${p}` : p;
    return [{ text: label, callback_data: `provider:${p}` }];
  });

  const descriptions = providers.map((p) => `• ${PROVIDER_DESCRIPTIONS[p]}`).join('\n');

  await ctx.reply(
    `🔌 *Select Provider*\n\n_Current: ${esc(active)}_\n\n${descriptions}`,
    {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        inline_keyboard: keyboard,
      },
    }
  );
}

/**
 * Quick toggle between Claude (Max) and CCR. Designed for the common case of
 * "I'm throttled on Max, send subsequent messages through CCR instead."
 * Sticky — stays on CCR until the user toggles back.
 */
export async function handleCcrCommand(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  if (!config.CCR_ENABLED) {
    await replyMd(
      ctx,
      '⚠️ CCR is not enabled\\. Set `CCR_ENABLED=true` in `.env` and restart the bot\\.',
    );
    return;
  }

  const active = getActiveProviderName(chatId);
  const next: ProviderName = active === 'ccr' ? 'claude' : 'ccr';
  await setActiveProvider(chatId, next);
  // Clear model — Claude and CCR share labels but CCR's mapping is different.
  clearModel(chatId);

  // Drop the Anthropic-side session_id so the next message starts fresh on
  // the new backend (resume of a stale session_id errors on CCR's target).
  const sessionKeyInfo = getSessionKeyFromCtx(ctx);
  if (sessionKeyInfo) clearConversation(sessionKeyInfo.sessionKey);

  const label = next === 'ccr' ? 'CCR \\(routed\\)' : 'Claude \\(Max\\)';
  await replyMd(ctx, `🔌 Switched provider to *${label}*\\.\n\n_Sticky — use /ccr again or /provider to switch back\\._`);
}

export async function handleProviderCallback(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith('provider:')) return;

  const provider = data.replace('provider:', '') as ProviderName;
  const providers = getAvailableProviders();

  if (!providers.includes(provider)) {
    await ctx.answerCallbackQuery({ text: 'Invalid provider' });
    return;
  }

  await setActiveProvider(chatId, provider);
  clearModel(chatId); // Models differ between providers

  await ctx.answerCallbackQuery({ text: `Switched to ${provider}!` });
  await ctx.editMessageText(
    `✅ Provider set to *${esc(provider)}*\n\n_Model selection cleared \\— use /model to pick a model\\._`,
    { parse_mode: 'MarkdownV2' }
  );
}

export async function handlePlan(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const session = sessionManager.getSession(sessionKey);
  if (!session) {
    await replyMd(ctx, '⚠️ No project set\\.\n\nIf the bot restarted, use `/continue` or `/resume` to restore your last session\\.\nOr use `/project` to open a project first\\.');
    return;
  }

  const text = ctx.message?.text || '';
  const task = text.split(' ').slice(1).join(' ').trim();

  if (!task) {
    await ctx.reply(
      `📋 *Plan Mode*\n\n_Project: ${esc(path.basename(session.workingDirectory))}_\n\nClaude will analyze your task and create a detailed implementation plan before coding\\.\n\n👇 _Describe your task:_`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'Add user authentication with JWT...',
          selective: true,
        },
      }
    );
    return;
  }

  try {
    await queueRequest(sessionKey, task, async () => {
      await messageSender.startStreaming(ctx);

      const abortController = new AbortController();
      setAbortController(sessionKey, abortController);

      try {
        const response = await sendToAgent(sessionKey, task, {
          onProgress: (progressText) => {
            messageSender.updateStream(ctx, progressText);
          },
          abortController,
          command: 'plan',
        });

        await messageSender.finishStreaming(ctx, response.text);
        await maybeSendVoiceReply(ctx, response.text);
      } catch (error) {
        await messageSender.cancelStreaming(ctx, error as Error);
        throw error;
      }
    });
  } catch (error) {
    if ((error as Error).message === 'Queue cleared') return;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    await replyMd(ctx, `❌ Error: ${esc(errorMessage)}`);
  }
}

export async function handleExplore(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const session = sessionManager.getSession(sessionKey);
  if (!session) {
    await replyMd(ctx, '⚠️ No project set\\.\n\nIf the bot restarted, use `/continue` or `/resume` to restore your last session\\.\nOr use `/project` to open a project first\\.');
    return;
  }

  const text = ctx.message?.text || '';
  const question = text.split(' ').slice(1).join(' ').trim();

  if (!question) {
    await ctx.reply(
      `🔍 *Explore Mode*\n\n_Project: ${esc(path.basename(session.workingDirectory))}_\n\nClaude will search and analyze the codebase to answer your question\\.\n\n👇 _What would you like to know?_`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'How does the auth system work?',
          selective: true,
        },
      }
    );
    return;
  }

  try {
    await queueRequest(sessionKey, question, async () => {
      await messageSender.startStreaming(ctx);

      const abortController = new AbortController();
      setAbortController(sessionKey, abortController);

      try {
        const response = await sendToAgent(sessionKey, question, {
          onProgress: (progressText) => {
            messageSender.updateStream(ctx, progressText);
          },
          abortController,
          command: 'explore',
        });

        await messageSender.finishStreaming(ctx, response.text);
        await maybeSendVoiceReply(ctx, response.text);
      } catch (error) {
        await messageSender.cancelStreaming(ctx, error as Error);
        throw error;
      }
    });
  } catch (error) {
    if ((error as Error).message === 'Queue cleared') return;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    await replyMd(ctx, `❌ Error: ${esc(errorMessage)}`);
  }
}

export async function handleResume(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const history = sessionManager.getSessionHistory(sessionKey, 10);
  // Only show sessions that actually have a Claude session (were chatted in)
  const resumable = history.filter((entry) => entry.claudeSessionId);

  if (resumable.length === 0) {
    await replyMd(ctx, 'ℹ️ No resumable sessions found\\.\n\nSessions need at least one Claude response to be resumable\\.\nUse `/project <name>` to start a new session\\.');
    return;
  }

  const keyboard = resumable.map((entry) => {
    const date = new Date(entry.lastActivity);
    const timeAgo = formatTimeAgo(date);
    const suffix = ` (${timeAgo})`;
    const base = entry.topic
      ? `${entry.projectName} · ${entry.topic}`
      : entry.projectName;
    // Telegram caps inline button labels at 64 bytes — truncate from the right
    // so the project name stays visible.
    const budget = 64 - suffix.length - 1;
    const text = (Buffer.byteLength(base, 'utf8') > budget
      ? truncateToBytes(base, budget - 1) + '…'
      : base) + suffix;

    return [
      {
        text,
        callback_data: `resume:${entry.conversationId}`,
      },
    ];
  });

  await ctx.reply('📜 *Recent Sessions*\n\nSelect a session to resume:', {
    parse_mode: 'MarkdownV2',
    reply_markup: {
      inline_keyboard: keyboard,
    },
  });
}

export async function handleResumeCallback(ctx: Context): Promise<void> {
  const cb = parseCallback(ctx, 'resume:');
  if (!cb) return;
  const { sessionKey, data } = cb;

  const conversationId = data.replace('resume:', '');
  const session = sessionManager.resumeSession(sessionKey, conversationId);

  if (!session) {
    await ctx.answerCallbackQuery({ text: 'Session not found' });
    return;
  }

  clearConversation(sessionKey);
  const entry = sessionHistory.getSessionByConversationId(sessionKey, conversationId);
  await restoreTopicAndRefreshBotName(ctx, sessionKey, entry?.topic);

  await ctx.answerCallbackQuery({ text: 'Session resumed!' });
  await ctx.editMessageText(
    `✅ Resumed session for *${esc(path.basename(session.workingDirectory))}*\n\n` +
    `Working directory: \`${esc(session.workingDirectory)}\`${projectStatusSuffix(sessionKey)}`,
    { parse_mode: 'MarkdownV2' }
  );

  // Send session ID as separate message for easy copying
  if (session.claudeSessionId) {
    await replyMd(ctx, resumeCommandMessage(session.claudeSessionId));
  }

  await sendRecapHint(ctx, sessionKey);
}

export async function handleContinue(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const session = sessionManager.resumeLastSession(sessionKey);

  if (!session) {
    await replyMd(ctx, 'ℹ️ No previous session to continue\\.\n\nUse `/project <name>` to start a new session\\.');
    return;
  }

  clearConversation(sessionKey);
  const entry = sessionHistory.getLastSession(sessionKey);
  await restoreTopicAndRefreshBotName(ctx, sessionKey, entry?.topic);

  await replyMd(ctx,
    `✅ Continuing *${esc(path.basename(session.workingDirectory))}*\n\n` +
    `Working directory: \`${esc(session.workingDirectory)}\`${projectStatusSuffix(sessionKey)}`
  );

  // Send session ID as separate message for easy copying
  if (session.claudeSessionId) {
    await replyMd(ctx, resumeCommandMessage(session.claudeSessionId));
  }

  await sendRecapHint(ctx, sessionKey);
}

// Cap for the user-prompt blockquote — long pasted prompts shouldn't dominate
// the recap. Assistant replies are NOT truncated: they go through the same
// converter+chunker as the original delivery, so their markdown renders
// (bold, code, lists) instead of showing escaped literals.
const RECAP_USER_MAX_CHARS = 500;
const RECAP_DEFAULT_N = 3;
const RECAP_MAX_N = 10;

function truncateUserPrompt(text: string, max: number = RECAP_USER_MAX_CHARS): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max - 1).trimEnd() + '…';
}

/**
 * Post the recap as a sequence of messages: a header, then for each exchange
 * the user prompt as a blockquote followed by the assistant reply rendered
 * with its original markdown intact. This mirrors how the assistant text
 * looked on first delivery, instead of cramming everything into one escaped
 * blockquote block where `*bold*` / backticks / lists show as raw characters.
 */
async function sendRecap(ctx: Context, exchanges: RecapExchange[]): Promise<void> {
  await replyMd(
    ctx,
    `📋 *Recap* — last ${exchanges.length} exchange${exchanges.length === 1 ? '' : 's'}`,
  );

  for (const ex of exchanges) {
    const userText = esc(truncateUserPrompt(ex.user));
    await replyMd(ctx, `>*You:* ${userText}`);

    for (const part of processMessageForTelegram(ex.assistant)) {
      try {
        await ctx.reply(part, { parse_mode: 'MarkdownV2' });
      } catch (error) {
        // Same fallback shape as MessageSender.sendMessage: if MarkdownV2 parse
        // fails (malformed entity from the converter), strip backslash-escapes
        // and resend as plain text rather than dropping the chunk.
        console.error('[Recap] MarkdownV2 send failed, falling back to plain text:', error);
        try {
          await ctx.reply(part.replace(/\\(.)/g, '$1'), { parse_mode: undefined });
        } catch (plainError) {
          console.error('[Recap] Plain text send also failed:', plainError);
        }
      }
    }
  }
}

/** Post a one-line tip pointing the user at /recap. Used after explicit restore. */
async function sendRecapHint(ctx: Context, sessionKey: string): Promise<void> {
  const session = sessionManager.getSession(sessionKey);
  if (!session?.claudeSessionId) return;
  const exchanges = readRecentExchanges(session.workingDirectory, session.claudeSessionId, 1);
  if (exchanges.length === 0) return;
  await replyMd(ctx, '💡 Tip: use `/recap` to see your last messages from this session\\.');
}

export async function handleRecap(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const text = ctx.message?.text || '';
  const arg = text.split(' ').slice(1).join(' ').trim();

  let n = RECAP_DEFAULT_N;
  if (arg) {
    const parsed = parseInt(arg, 10);
    if (Number.isNaN(parsed) || parsed < 1) {
      await replyMd(ctx, '⚠️ Usage: `/recap [N]` where N is the number of exchanges \\(default 3, max 10\\)\\.');
      return;
    }
    n = Math.min(parsed, RECAP_MAX_N);
  }

  const session = sessionManager.getSession(sessionKey);
  if (!session) {
    await replyMd(ctx, '⚠️ No active session\\. Use `/continue` or `/resume` first\\.');
    return;
  }
  if (!session.claudeSessionId) {
    await replyMd(ctx, 'ℹ️ This session has no recorded messages yet\\.');
    return;
  }

  const exchanges = readRecentExchanges(session.workingDirectory, session.claudeSessionId, n);
  if (exchanges.length === 0) {
    await replyMd(ctx, 'ℹ️ No recoverable exchanges found in this session\\.');
    return;
  }

  await sendRecap(ctx, exchanges);
}

/**
 * Dump the current session's conversation to a markdown file and deliver
 * via Telegram (Telegraph link + downloadable file). Useful before switching
 * projects, clearing context, or handing off to a teammate. Captures all
 * exchanges (capped at 200) plus session metadata.
 */
export async function handleHandoff(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const session = sessionManager.getSession(sessionKey);
  if (!session) {
    await replyMd(ctx, '⚠️ No active session\\. Use `/continue` or `/resume` first\\.');
    return;
  }
  if (!session.claudeSessionId) {
    await replyMd(ctx, 'ℹ️ This session has no recorded messages yet\\.');
    return;
  }

  const exchanges = readRecentExchanges(session.workingDirectory, session.claudeSessionId, 200);
  if (exchanges.length === 0) {
    await replyMd(ctx, 'ℹ️ No recoverable exchanges in this session\\.');
    return;
  }

  const projectName = path.basename(session.workingDirectory);
  const topic = getSessionTopic(sessionKey);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  const headerLines: string[] = [
    `# Session handoff — ${projectName}`,
    '',
    `**Project:** \`${session.workingDirectory}\`  `,
    `**Session id:** \`${session.claudeSessionId}\`  `,
    `**Conversation id:** \`${session.conversationId}\`  `,
    `**Exported:** ${new Date().toLocaleString()}  `,
    topic ? `**Topic:** ${topic}  ` : '',
    `**Exchanges:** ${exchanges.length}`,
    '',
    `Resume with: \`claude --resume ${session.claudeSessionId}\``,
    '',
    '---',
    '',
  ].filter(Boolean);

  const bodyLines: string[] = [];
  exchanges.forEach((ex, i) => {
    bodyLines.push(`## Exchange ${i + 1}`);
    bodyLines.push('');
    bodyLines.push('### User');
    bodyLines.push('');
    bodyLines.push(ex.user.trim());
    bodyLines.push('');
    bodyLines.push('### Assistant');
    bodyLines.push('');
    bodyLines.push(ex.assistant.trim());
    bodyLines.push('');
    bodyLines.push('---');
    bodyLines.push('');
  });

  const md = [...headerLines, ...bodyLines].join('\n');
  const outDir = path.join(session.workingDirectory, '.claudegram', 'handoffs');
  try {
    fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    await replyMd(ctx, `❌ Couldn't create handoff dir: ${esc(err instanceof Error ? err.message : String(err))}`);
    return;
  }
  const filePath = path.join(outDir, `handoff-${ts}.md`);
  try {
    fs.writeFileSync(filePath, md, { mode: 0o600 });
  } catch (err) {
    await replyMd(ctx, `❌ Couldn't write handoff: ${esc(err instanceof Error ? err.message : String(err))}`);
    return;
  }

  await replyMd(
    ctx,
    `📦 *Handoff written* — \`${esc(path.relative(session.workingDirectory, filePath))}\`\n` +
    `${exchanges.length} exchange${exchanges.length === 1 ? '' : 's'} captured\\.`,
  );

  // Telegraph preview + downloadable file (mirrors /telegraph)
  await messageSender.sendMarkdownFile(ctx, filePath, { useTelegraph: true, sendAsDocument: true });
}

/**
 * Manual safety net for the PTY → Telegram translation. Reads the canonical
 * latest assistant turn from Claude Code's session JSONL and posts whatever
 * the user hasn't seen yet. Mirrors the proactive catch-up that runs after
 * each turn (relayCatchUpIfMissed in message.handler.ts); /sync exists for
 * cases where the user suspects a miss outside that automatic window — e.g.
 * a quietly-failed catch-up, or after a bot restart that wiped the relayed
 * tracker.
 */
export async function handleSync(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const session = sessionManager.getSession(sessionKey);
  if (!session) {
    await replyMd(ctx, '⚠️ No active session\\. Use `/continue` or `/resume` first\\.');
    return;
  }
  if (!session.claudeSessionId) {
    await replyMd(ctx, 'ℹ️ This session has no recorded messages yet\\.');
    return;
  }

  const jsonlText = readLastAssistantTurnText(session.workingDirectory, session.claudeSessionId);
  if (!jsonlText) {
    await replyMd(ctx, 'ℹ️ No assistant reply found for the current turn\\.');
    return;
  }

  const relayed = sessionManager.getLastRelayedAssistantText(sessionKey);
  // Same 20-char slack as the proactive check — trim/whitespace deltas don't
  // count as a real miss.
  if (jsonlText.length <= relayed.length + 20) {
    await replyMd(ctx, "✅ You're caught up — nothing new in the session log\\.");
    return;
  }

  const missing = jsonlText.startsWith(relayed) && relayed.length > 0
    ? jsonlText.slice(relayed.length).trim()
    : jsonlText;
  if (!missing) {
    await replyMd(ctx, "✅ You're caught up — nothing new in the session log\\.");
    return;
  }

  await replyMd(ctx, '📨 *Sync* — from session log');
  await messageSender.sendMessage(ctx, missing);
  sessionManager.setLastRelayedAssistantText(sessionKey, jsonlText);
}

/**
 * List the current project's `.claude/commands/*.md` slash commands. They
 * pass through to claude code untouched (typing `/mycommand` in chat sends
 * `/mycommand` to claude, which dispatches to the file), so this is purely
 * a discoverability helper — no per-command registration needed.
 */
/** Show the current permission-gate state and the patterns it enforces. */
export async function handlePermissions(ctx: Context): Promise<void> {
  const { isPermissionGateEnabled, listDangerousPatterns } = await import('../../claude/permission-gate.js');
  const enabled = isPermissionGateEnabled();
  const patterns = listDangerousPatterns();

  const lines: string[] = [
    `🔐 *Permission gate* — ${enabled ? '✅ enabled' : '⛔️ disabled'}`,
    '',
    enabled
      ? 'Bash commands matching the patterns below trigger a Telegram approval prompt before claude executes them\\. Other tools auto\\-allow\\.'
      : 'Disabled\\. Set `CLAUDEGRAM_PERMISSION_PROMPTS=1` and restart the bot to enable\\.',
    '',
    '*Guarded patterns:*',
    ...patterns.map((p) => `• ${esc(p.reason)}`),
  ];
  await replyMd(ctx, lines.join('\n'));
}

export async function handleProjectCommands(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const session = sessionManager.getSession(sessionKey);
  if (!session) {
    await replyMd(ctx, '⚠️ No project set\\. Use `/project` first\\.');
    return;
  }

  const { getProjectCommands } = await import('../../claude/project-commands.js');
  const commands = getProjectCommands(session.workingDirectory);
  if (commands.length === 0) {
    await replyMd(
      ctx,
      `No project slash commands in \`${esc(path.basename(session.workingDirectory))}\`\\.\n\n` +
      `Add markdown files under \`.claude/commands/\` to define them — see [docs](https://docs.claude.com/en/docs/claude-code/slash-commands)\\.`,
    );
    return;
  }

  const lines: string[] = [
    `📜 *Project commands* \\(${commands.length}\\) in \`${esc(path.basename(session.workingDirectory))}\``,
    '',
    ...commands.map((c) => {
      const desc = c.description ? ` — ${esc(c.description)}` : '';
      return `• \`/${esc(c.name)}\`${desc}`;
    }),
  ];
  await replyMd(ctx, lines.join('\n'));
}

export async function handleLoop(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const session = sessionManager.getSession(sessionKey);
  if (!session) {
    await replyMd(ctx, '⚠️ No project set\\.\n\nIf the bot restarted, use `/continue` or `/resume` to restore your last session\\.\nOr use `/project` to open a project first\\.');
    return;
  }

  const text = ctx.message?.text || '';
  const task = text.split(' ').slice(1).join(' ').trim();

  if (!task) {
    await ctx.reply(
      `🔄 *Loop Mode*\n\n_Project: ${esc(path.basename(session.workingDirectory))}_\n\nClaude will work iteratively until done \\(max ${config.MAX_LOOP_ITERATIONS} iterations\\)\\.\n\n👇 _Describe the task:_`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'Fix all TypeScript errors in src/',
          selective: true,
        },
      }
    );
    return;
  }

  try {
    await queueRequest(sessionKey, task, async () => {
      await messageSender.startStreaming(ctx);

      const abortController = new AbortController();
      setAbortController(sessionKey, abortController);

      try {
        const response = await sendLoopToAgent(sessionKey, task, {
          onProgress: (progressText) => {
            messageSender.updateStream(ctx, progressText);
          },
          abortController,
        });

        await messageSender.finishStreaming(ctx, response.text);
        await maybeSendVoiceReply(ctx, response.text);
      } catch (error) {
        await messageSender.cancelStreaming(ctx, error as Error);
        throw error;
      }
    });
  } catch (error) {
    if ((error as Error).message === 'Queue cleared') return;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    await replyMd(ctx, `❌ Error: ${esc(errorMessage)}`);
  }
}

export async function handleSessions(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const history = sessionManager.getSessionHistory(sessionKey, 10);
  const currentSession = sessionManager.getSession(sessionKey);

  if (history.length === 0 && !currentSession) {
    await replyMd(ctx, 'ℹ️ No sessions found\\.\n\nUse `/project <name>` to start a new session\\.');
    return;
  }

  let message = '📋 *Sessions*\n\n';

  if (currentSession) {
    message += `*Active:*\n• \`${esc(path.basename(currentSession.workingDirectory))}\` \\(${esc(formatTimeAgo(currentSession.lastActivity))}\\)\n\n`;
  }

  if (history.length > 0) {
    message += '*Recent:*\n';
    for (const entry of history) {
      const isActive = currentSession && currentSession.conversationId === entry.conversationId;
      const marker = isActive ? '→ ' : '• ';
      const date = new Date(entry.lastActivity);
      const topicSuffix = entry.topic ? ` — _${esc(entry.topic)}_` : '';
      message += `${marker}\`${esc(entry.projectName)}\` \\(${esc(formatTimeAgo(date))}\\)${topicSuffix}\n`;
    }
  }

  message += '\n_Use `/resume` to switch sessions or `/continue` to resume the last one\\._';

  await replyMd(ctx, message);
}

export async function handleTeleport(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;
  const { chatId } = parseSessionKey(sessionKey);

  if (getActiveProviderName(chatId) === 'opencode') {
    await replyMd(ctx, 'ℹ️ `/teleport` is not available for the OpenCode provider\\.');
    return;
  }

  const session = sessionManager.getSession(sessionKey);

  if (!session) {
    await replyMd(ctx, 'ℹ️ No active session to teleport\\.\n\nStart a conversation first with `/project <name>`\\.');
    return;
  }

  if (!session.claudeSessionId) {
    await replyMd(ctx, 'ℹ️ No Claude session available yet\\.\n\nSend a message first to start a session, then use `/teleport`\\.');
    return;
  }

  const projectName = path.basename(session.workingDirectory);
  const claudeBin = config.CLAUDE_EXECUTABLE_PATH ?? 'claude';
  const command = `cd "${session.workingDirectory}" && ${claudeBin} --resume ${session.claudeSessionId}`;

  const message = `🚀 *Teleport to Terminal*

*Project:* \`${esc(projectName)}\`
*Session:* \`${esc(session.claudeSessionId.substring(0, 8))}\\.\\.\\.\`

Copy and run in your terminal:

\`\`\`
${esc(command)}
\`\`\`

_Both Telegram and terminal can continue independently \\(forked session\\)\\._`;

  await replyMd(ctx, message);
}

function formatTimeAgo(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

/**
 * One-tap "Back to previous" inline keyboard, reusing the /resume callback.
 * Skips the entry whose conversationId matches `excludeConversationId` so we
 * don't offer to return to the session you're already in.
 */
export function buildBackToPreviousButton(
  sessionKey: string,
  excludeConversationId?: string,
): { text: string; callback_data: string }[][] | undefined {
  const history = sessionManager.getSessionHistory(sessionKey, 5);
  const entry = history.find(
    (e) => e.claudeSessionId && e.conversationId !== excludeConversationId,
  );
  if (!entry) return undefined;

  const timeAgo = formatTimeAgo(new Date(entry.lastActivity));
  const detail = entry.topic ? `${entry.projectName}: ${entry.topic}` : entry.projectName;
  const trimmed = detail.length > 45 ? `${detail.slice(0, 44)}…` : detail;
  return [[{ text: `↩️ Back to ${trimmed} (${timeAgo})`, callback_data: `resume:${entry.conversationId}` }]];
}

export async function handleFile(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const text = ctx.message?.text || '';
  const filePath = text.split(' ').slice(1).join(' ').trim();

  const session = sessionManager.getSession(sessionKey);
  if (!session) {
    await replyMd(ctx, '⚠️ No project set\\.\n\nIf the bot restarted, use `/continue` or `/resume` to restore your last session\\.\nOr use `/project <path>` to open a project first\\.');
    return;
  }

  if (!filePath) {
    // List some files in the project to help user
    const projectFiles = listProjectFiles(session.workingDirectory);
    const fileList = projectFiles.length > 0
      ? `\n\n*Recent files:*\n${projectFiles.slice(0, 8).map(f => `• \`${esc(f)}\``).join('\n')}`
      : '';

    await ctx.reply(
      `📎 *Download File*\n\n_Project: ${esc(path.basename(session.workingDirectory))}_${fileList}\n\n👇 _Enter the file path:_`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'src/index.ts',
          selective: true,
        },
      }
    );
    return;
  }

  const fullPath = filePath.startsWith('/')
    ? filePath
    : path.join(session.workingDirectory, filePath);
  const workspaceRoot = getWorkspaceRoot();

  if (!isPathWithinRoot(workspaceRoot, fullPath)) {
    await replyMd(ctx, `❌ File path must be within workspace root: \`${esc(workspaceRoot)}\``);
    return;
  }

  if (!fs.existsSync(fullPath)) {
    await replyMd(ctx, `❌ File not found: \`${esc(filePath)}\``);
    return;
  }

  if (fs.statSync(fullPath).isDirectory()) {
    await replyMd(ctx, `❌ Path is a directory, not a file: \`${esc(filePath)}\``);
    return;
  }

  const success = await messageSender.sendDocument(ctx, fullPath, `📎 ${path.basename(fullPath)}`);

  if (!success) {
    await replyMd(ctx, '❌ Failed to send file\\. It may be too large \\(\\>50MB\\) or inaccessible\\.');
  }
}

export async function handleTelegraph(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const text = ctx.message?.text || '';
  const filePath = text.split(' ').slice(1).join(' ').trim();

  // If no argument provided, show the settings menu
  if (!filePath) {
    const menu = buildTelegraphMenu(sessionKey);
    await ctx.reply(menu.text, {
      parse_mode: 'MarkdownV2',
      reply_markup: menu.keyboard.length > 0 ? { inline_keyboard: menu.keyboard } : undefined,
    });
    return;
  }

  const session = sessionManager.getSession(sessionKey);
  if (!session) {
    await replyMd(ctx, '⚠️ No project set\\.\n\nIf the bot restarted, use `/continue` or `/resume` to restore your last session\\.\nOr use `/project <path>` to open a project first\\.');
    return;
  }

  const fullPath = filePath.startsWith('/')
    ? filePath
    : path.join(session.workingDirectory, filePath);
  const workspaceRoot = getWorkspaceRoot();

  if (!isPathWithinRoot(workspaceRoot, fullPath)) {
    await replyMd(ctx, `❌ File path must be within workspace root: \`${esc(workspaceRoot)}\``);
    return;
  }

  if (!fs.existsSync(fullPath)) {
    await replyMd(ctx, `❌ File not found: \`${esc(filePath)}\``);
    return;
  }

  const ext = path.extname(fullPath).toLowerCase();
  if (ext !== '.md' && ext !== '.markdown') {
    await replyMd(ctx, '⚠️ Telegraph works best with Markdown files \\(\\.md\\)');
  }

  await replyMd(ctx, '📤 Creating Telegraph page\\.\\.\\.');

  const pageUrl = await createTelegraphFromFile(fullPath);

  if (pageUrl) {
    const fileName = path.basename(fullPath);
    await replyMd(ctx, `📄 *${esc(fileName)}*\n\n[Open in Instant View](${esc(pageUrl)})`);
  } else {
    await replyMd(ctx, '❌ Failed to create Telegraph page\\.');
  }
}

/**
 * Tokenize a user-provided argument string, preserving quoted substrings.
 * Returns an array of individual arguments safe for execFile.
 */
function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"| '([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(input)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

type RedditFormat = 'markdown' | 'json';

function parseRedditArgs(tokens: string[]): {
  cleanTokens: string[];
  format: RedditFormat | null;
  hadOutputFlag: boolean;
} {
  const cleanTokens: string[] = [];
  let format: RedditFormat | null = null;
  let hadOutputFlag = false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '-o' || token === '--output') {
      hadOutputFlag = true;
      i++; // skip value
      continue;
    }

    if ((token === '-f' || token === '--format') && tokens[i + 1]) {
      const next = tokens[i + 1] as RedditFormat;
      if (next === 'json' || next === 'markdown') {
        format = next;
      }
      i++; // skip value, don't push to cleanTokens (handled here)
      continue;
    }

    cleanTokens.push(token);
  }

  return { cleanTokens, format, hadOutputFlag };
}

function ensureRedditOutputDir(ctx: Context): string {
  const keyInfo = getSessionKeyFromCtx(ctx);
  const session = keyInfo ? sessionManager.getSession(keyInfo.sessionKey) : null;
  const baseDir = session ? session.workingDirectory : process.cwd();
  const dir = path.join(baseDir, '.claudegram', 'reddit');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function buildRedditOutputPath(ctx: Context, tokens: string[]): string {
  const dir = ensureRedditOutputDir(ctx);
  const raw = tokens[0] || 'reddit';
  const slug = raw.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40) || 'reddit';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(dir, `reddit_${slug}_${stamp}.json`);
}

function slugFromUrl(input: string): string {
  const cleaned = input.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9_-]+/g, '_');
  return cleaned.slice(0, 60) || 'medium';
}

function ensureMediumOutputDir(ctx: Context, url: string): string {
  const keyInfo = getSessionKeyFromCtx(ctx);
  const session = keyInfo ? sessionManager.getSession(keyInfo.sessionKey) : null;
  const baseDir = session ? session.workingDirectory : process.cwd();
  const slug = slugFromUrl(url);
  const dir = path.join(baseDir, '.claudegram', 'medium', slug);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}


// Pending Reddit fetch results keyed by messageId, with 5-min TTL.
// Keyed by messageId (not chatId) so concurrent fetches don't overwrite each other.
const pendingRedditResults = new Map<number, {
  chatId: number;
  output: string;
  jsonOutput: string;
  targets: string[];
  options: RedditFetchOptions;
  format: RedditFormat | null;
  hadOutputFlag: boolean;
  expiresAt: number;
}>();
const REDDIT_RESULT_TTL_MS = 5 * 60 * 1000;

/**
 * Execute native Reddit fetch, cache the result, and show an inline picker
 * so the user can choose File / Chat / Both.
 * Exported so message.handler.ts can reuse it for ForceReply flow.
 */
export async function executeRedditFetch(
  ctx: Context,
  args: string
): Promise<void> {
  if (!config.REDDIT_ENABLED) {
    await replyFeatureDisabled(ctx, 'Reddit');
    return;
  }

  await ctx.replyWithChatAction('typing');

  const tokens = tokenizeArgs(args);
  const { cleanTokens, format, hadOutputFlag } = parseRedditArgs(tokens);

  // Extract targets and options from cleanTokens
  const targets: string[] = [];
  const options: RedditFetchOptions = {
    format: format || 'markdown',
    limit: config.REDDITFETCH_DEFAULT_LIMIT,
    depth: config.REDDITFETCH_DEFAULT_DEPTH,
  };

  const VALID_SORTS = new Set(['hot', 'new', 'top', 'rising', 'controversial', 'best']);
  const VALID_TIMES = new Set(['hour', 'day', 'week', 'month', 'year', 'all']);

  for (let i = 0; i < cleanTokens.length; i++) {
    const token = cleanTokens[i];
    if (token === '--sort' && cleanTokens[i + 1]) {
      const val = cleanTokens[++i];
      if (VALID_SORTS.has(val)) options.sort = val;
    } else if (token === '--limit' && cleanTokens[i + 1]) {
      const parsed = parseInt(cleanTokens[++i], 10);
      if (!Number.isNaN(parsed) && parsed > 0) options.limit = parsed;
    } else if ((token === '-l') && cleanTokens[i + 1]) {
      const parsed = parseInt(cleanTokens[++i], 10);
      if (!Number.isNaN(parsed) && parsed > 0) options.limit = parsed;
    } else if (token === '--depth' && cleanTokens[i + 1]) {
      const parsed = parseInt(cleanTokens[++i], 10);
      if (!Number.isNaN(parsed) && parsed > 0) options.depth = parsed;
    } else if (token === '--time' && cleanTokens[i + 1]) {
      const val = cleanTokens[++i];
      if (VALID_TIMES.has(val)) options.timeFilter = val;
    } else {
      targets.push(token);
    }
  }

  if (targets.length === 0) {
    await replyMd(ctx, '❌ No target specified\\. Example: `/reddit r/ClaudeAI` or `/reddit <post\\-url>`');
    return;
  }

  const chatId = ctx.chat?.id;
  if (!chatId) return;

  try {
    // Fetch both formats in a single API call to avoid double-dipping
    const { markdown: output, json: jsonOutput } = await redditFetchBoth(targets, options);

    if (!output.trim()) {
      await replyMd(ctx, '❌ No results returned\\.');
      return;
    }

    // Build a short preview for the picker message
    const charCount = output.length;
    const targetLabel = targets.join(', ');
    const previewSnippet = output.length > 200
      ? output.slice(0, 200).trimEnd() + '...'
      : output;

    const previewText =
      `📡 *Reddit Fetch*\n` +
      `Target: \`${esc(targetLabel)}\`\n` +
      `Size: _${charCount} chars_\n\n` +
      `${esc(previewSnippet)}\n\n` +
      `_Choose how to consume this content:_`;

    const msg = await ctx.reply(previewText, {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '📄 File', callback_data: 'reddit_action:file' },
            { text: '💬 Chat', callback_data: 'reddit_action:chat' },
            { text: '📄💬 Both', callback_data: 'reddit_action:both' },
          ],
        ],
      },
    });

    // Cache both formats for callback handling (keyed by messageId)
    pendingRedditResults.set(msg.message_id, {
      chatId,
      output,
      jsonOutput,
      targets,
      options,
      format,
      hadOutputFlag,
      expiresAt: Date.now() + REDDIT_RESULT_TTL_MS,
    });
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    let userMessage: string;

    if (errorMessage.includes('Missing Reddit credentials') || errorMessage.includes('REDDIT_CLIENT_ID')) {
      userMessage = "❌ Reddit credentials not configured\\.\n\nSet `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USERNAME`, `REDDIT_PASSWORD` in claudegram's `\\.env` file\\.";
    } else if (errorMessage.includes('timed out') || errorMessage.includes('AbortError')) {
      userMessage = '❌ Reddit fetch timed out\\.';
    } else {
      userMessage = `❌ Reddit fetch failed: ${esc(sanitizeError(errorMessage).substring(0, 300))}`;
    }

    await replyMd(ctx, userMessage);
  }
}

/**
 * Handle inline keyboard callbacks for Reddit action picker (File / Chat / Both).
 */
export async function handleRedditActionCallback(ctx: Context): Promise<void> {
  const cb = parseCallback(ctx, 'reddit_action:');
  if (!cb) return;
  const { sessionKey, data } = cb;

  const action = data.replace('reddit_action:', '');

  // Look up pending result by messageId (keyed by picker message ID)
  const callbackMsgId = ctx.callbackQuery?.message?.message_id;
  if (!callbackMsgId) return;
  const pending = pendingRedditResults.get(callbackMsgId);
  if (!pending || Date.now() > pending.expiresAt) {
    if (callbackMsgId) pendingRedditResults.delete(callbackMsgId);
    await ctx.answerCallbackQuery({ text: 'Result expired. Please fetch again.' });
    return;
  }

  await ctx.answerCallbackQuery();

  const { output, jsonOutput, targets, format, hadOutputFlag } = pending;
  const doFile = action === 'file' || action === 'both';
  const doChat = action === 'chat' || action === 'both';

  try {
    // ── File mode ──────────────────────────────────────────────────
    if (doFile) {
      // Large thread JSON fallback (uses cached JSON, no second API call)
      if (!format && output.length > config.REDDITFETCH_JSON_THRESHOLD_CHARS) {
        try {
          const outputPath = buildRedditOutputPath(ctx, targets);
          fs.writeFileSync(outputPath, jsonOutput, { encoding: 'utf-8', mode: 0o600 });

          const sent = await messageSender.sendDocument(
            ctx,
            outputPath,
            `📎 Reddit JSON saved: ${path.basename(outputPath)}`
          );

          const displayPath = `.claudegram/reddit/${path.basename(outputPath)}`;
          const notice = sent
            ? `Large thread detected \\(${output.length} chars\\) — sent JSON file for structured review\\.`
            : `Large thread detected \\(${output.length} chars\\) — JSON saved at \`${esc(displayPath)}\`\\.`;

          await replyMd(ctx, notice);
        } catch (jsonError) {
          console.error('[Reddit] JSON fallback failed:', jsonError);
          await messageSender.sendMessage(ctx, output);
        }
      } else {
        await messageSender.sendMessage(ctx, output);
      }

      if (hadOutputFlag) {
        await replyMd(ctx, 'ℹ️ Note: `-o/--output` is ignored in this picker flow\\. JSON is saved automatically for large threads\\.');
      }
    }

    // ── Chat mode ──────────────────────────────────────────────────
    if (doChat) {
      const session = sessionManager.getSession(sessionKey);
      if (!session) {
        await replyMd(ctx, '⚠️ No project set\\. Use `/project` first to enable Chat mode\\.');
      } else {
        // 1. Save content to disk
        const dir = ensureRedditOutputDir(ctx);
        const slug = (targets[0] || 'reddit').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const mdPath = path.join(dir, `reddit_${slug}_${stamp}.md`);
        fs.writeFileSync(mdPath, output, { encoding: 'utf-8', mode: 0o600 });

        // 2. Build prompt with inline content (truncated for large results)
        const CHAT_INLINE_LIMIT = 3000;
        const truncated = output.length > CHAT_INLINE_LIMIT;
        const inlineContent = truncated
          ? output.slice(0, CHAT_INLINE_LIMIT).trimEnd()
          : output;

        // Use relative display path to avoid leaking absolute server paths in conversation
        const displayPath = `.claudegram/reddit/${path.basename(mdPath)}`;

        let prompt = `I just fetched Reddit content and saved it to ${displayPath}. Here's the content:\n\n${inlineContent}`;
        if (truncated) {
          prompt += `\n\n[Content truncated — full content (${output.length} chars) is saved at ${displayPath}.]`;
        }
        prompt += '\n\nPlease summarize the key points and let me know if you have any questions.';

        // 3. Queue a streaming response
        try {
          await queueRequest(sessionKey, prompt, async () => {
            if (getStreamingMode() === 'streaming') {
              await messageSender.startStreaming(ctx);
              const abortController = new AbortController();
              setAbortController(sessionKey, abortController);
              try {
                const response = await sendToAgent(sessionKey, prompt, {
                  onProgress: (progressText) => {
                    messageSender.updateStream(ctx, progressText);
                  },
                  abortController,
                });
                await messageSender.finishStreaming(ctx, response.text);
                await maybeSendVoiceReply(ctx, response.text);
              } catch (error) {
                await messageSender.cancelStreaming(ctx, error as Error);
                throw error;
              }
            } else {
              await ctx.replyWithChatAction('typing');
              const abortController = new AbortController();
              setAbortController(sessionKey, abortController);
              const response = await sendToAgent(sessionKey, prompt, { abortController });
              await messageSender.sendMessage(ctx, response.text);
              await maybeSendVoiceReply(ctx, response.text);
            }
          });
        } catch (error) {
          if ((error as Error).message !== 'Queue cleared') {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            await replyMd(ctx, `❌ Chat failed: ${esc(errorMessage)}`);
          }
        }
      }
    }

    // Edit the original picker message to show what was selected
    const actionLabel = action === 'file' ? '📄 File' : action === 'chat' ? '💬 Chat' : '📄💬 Both';
    try {
      const targetLabel = targets.join(', ');
      await ctx.editMessageText(
        `📡 *Reddit Fetch* — ${esc(actionLabel)}\n` +
        `Target: \`${esc(targetLabel)}\` · ${output.length} chars`,
        { parse_mode: 'MarkdownV2' }
      );
    } catch { /* ignore edit failure */ }

    // Clean up
    pendingRedditResults.delete(callbackMsgId);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    await replyMd(ctx, `❌ Action failed: ${esc(message.substring(0, 300))}`);
    pendingRedditResults.delete(callbackMsgId);
  }
}

// Pending Freedium results keyed by sessionKey, with 5-min TTL
const pendingMediumResults = new Map<string, { article: FreediumArticle; messageId: number; expiresAt: number }>();
const MEDIUM_RESULT_TTL_MS = 5 * 60 * 1000;

// Periodic cleanup of expired pending results to prevent memory leaks.
// .unref() so this timer doesn't prevent graceful process shutdown.
const _cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [msgId, entry] of pendingRedditResults) {
    if (now > entry.expiresAt) pendingRedditResults.delete(msgId);
  }
  for (const [key, entry] of pendingMediumResults) {
    if (now > entry.expiresAt) pendingMediumResults.delete(key);
  }
}, REDDIT_RESULT_TTL_MS);
_cleanupInterval.unref();

/**
 * Fetch a Medium article via Freedium and present inline action buttons.
 */
export async function executeMediumFetch(
  ctx: Context,
  args: string
): Promise<void> {
  if (!config.MEDIUM_ENABLED) {
    await replyFeatureDisabled(ctx, 'Medium');
    return;
  }

  await ctx.replyWithChatAction('typing');

  const url = args.trim().split(/\s+/)[0];

  if (!url) {
    await replyMd(ctx, '❌ Missing URL\\. Example: `/medium https://medium.com/...`');
    return;
  }

  if (!isMediumUrl(url)) {
    await replyMd(ctx, '❌ Not a recognized Medium URL\\.\n\nSupported: medium\\.com, towardsdatascience\\.com, and other known Medium publication domains\\.');
    return;
  }

  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  try {
    const article = await fetchMediumArticle(url);

    // Build preview: title + author + first ~200 chars of markdown
    const preview = article.markdown.length > 200
      ? article.markdown.slice(0, 200).trimEnd() + '...'
      : article.markdown;

    const previewText =
      `📰 *${esc(article.title)}*\n` +
      `_by ${esc(article.author)}_\n\n` +
      `${esc(preview)}\n\n` +
      `_${article.markdown.length} chars — choose an action:_`;

    // Build inline keyboard based on Telegraph availability
    const inlineKeyboard = config.TELEGRAPH_ENABLED
      ? [
          [
            { text: '📄 Telegraph', callback_data: 'medium:telegraph' },
            { text: '💾 Save .md', callback_data: 'medium:save' },
            { text: '📄💾 Both', callback_data: 'medium:both' },
          ],
        ]
      : [
          [
            { text: '💬 Send to Chat', callback_data: 'medium:chat' },
            { text: '💾 Save .md', callback_data: 'medium:save' },
            { text: '💬💾 Both', callback_data: 'medium:chatboth' },
          ],
        ];

    const msg = await ctx.reply(previewText, {
      parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: inlineKeyboard },
    });

    // Store result for callback handling
    pendingMediumResults.set(sessionKey, {
      article,
      messageId: msg.message_id,
      expiresAt: Date.now() + MEDIUM_RESULT_TTL_MS,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    await replyMd(ctx, `❌ Medium fetch failed: ${esc(message.substring(0, 300))}`);
  }
}

/**
 * Handle inline keyboard callbacks for Medium article actions.
 */
export async function handleMediumCallback(ctx: Context): Promise<void> {
  if (!config.MEDIUM_ENABLED) {
    await ctx.answerCallbackQuery({ text: 'Feature disabled' });
    await replyFeatureDisabled(ctx, 'Medium');
    return;
  }

  const cb = parseCallback(ctx, 'medium:');
  if (!cb) return;
  const { sessionKey, data } = cb;

  const action = data.replace('medium:', '');

  // Look up pending result
  const pending = pendingMediumResults.get(sessionKey);
  if (!pending || Date.now() > pending.expiresAt) {
    pendingMediumResults.delete(sessionKey);
    await ctx.answerCallbackQuery({ text: 'Result expired. Please fetch again.' });
    return;
  }

  const { article } = pending;
  await ctx.answerCallbackQuery();

  const doTelegraph = action === 'telegraph' || action === 'both';
  const doChat = action === 'chat' || action === 'chatboth';
  const doSave = action === 'save' || action === 'both' || action === 'chatboth';

  let telegraphUrl: string | null = null;
  let mdPath: string | null = null;

  try {
    if (doTelegraph) {
      telegraphUrl = await createTelegraphPage(article.title, article.markdown);
    }

    if (doSave) {
      const outputDir = ensureMediumOutputDir(ctx, article.url);
      const slug = slugFromUrl(article.url);
      mdPath = path.join(outputDir, `${slug}.md`);
      fs.writeFileSync(mdPath, article.markdown, { encoding: 'utf-8', mode: 0o600 });
    }

    // Build result message
    let resultText = `📰 *${esc(article.title)}*\n_by ${esc(article.author)}_\n\n`;

    if (telegraphUrl) {
      resultText += `📄 [Open in Instant View](${esc(telegraphUrl)})\n`;
    }
    if (doChat) {
      resultText += `💬 Sending to chat\\.\\.\\.\n`;
    }
    if (mdPath) {
      resultText += `💾 Markdown saved \\(${article.markdown.length} chars\\)`;
    }

    // Edit the original message to show results
    try {
      await ctx.editMessageText(resultText, { parse_mode: 'MarkdownV2' });
    } catch {
      // If edit fails (e.g. message too old), send new message
      await replyMd(ctx, resultText);
    }

    // Send content to chat if requested (inline messages)
    if (doChat) {
      await messageSender.sendMessage(ctx, article.markdown);
    }

    // Send .md file as document
    if (mdPath) {
      await messageSender.sendDocument(ctx, mdPath, `📎 ${path.basename(mdPath)}`);
    }

    // Clean up pending result
    pendingMediumResults.delete(sessionKey);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    await replyMd(ctx, `❌ Action failed: ${esc(message.substring(0, 300))}`);
  }
}

export async function handleMedium(ctx: Context): Promise<void> {
  if (!config.MEDIUM_ENABLED) {
    await replyFeatureDisabled(ctx, 'Medium');
    return;
  }

  const text = ctx.message?.text || '';
  const args = text.split(' ').slice(1).join(' ').trim();

  if (!args) {
    await ctx.reply(
      `📰 *Medium Fetch*\n\n` +
      `Fetch a Medium article via Freedium and convert to Markdown\\.\n\n` +
      `*Examples:*\n` +
      `• \`https://medium.com/@user/post\\-id\`\n` +
      `• \`https://towardsdatascience.com/some\\-article\`\n\n` +
      `👇 _Paste a Medium article URL:_`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'https://medium.com/@user/post-id',
          selective: true,
        },
      }
    );
    return;
  }

  await executeMediumFetch(ctx, args);
}

export async function handleReddit(ctx: Context): Promise<void> {
  if (!config.REDDIT_ENABLED) {
    await replyFeatureDisabled(ctx, 'Reddit');
    return;
  }

  const text = ctx.message?.text || '';
  const args = text.split(' ').slice(1).join(' ').trim();

  if (!args) {
    await ctx.reply(
      `📡 *Reddit Fetch*\n\n` +
      `Fetch posts, subreddits, or user profiles from Reddit\\.\n\n` +
      `*Examples:*\n` +
      `• \`r/ClaudeAI \\-\\-sort new \\-\\-limit 5\`\n` +
      `• \`1lmkfhf\` \\(post ID\\)\n` +
      `• \`u/username \\-\\-limit 5\`\n` +
      `• \`r/LocalLLaMA \\-\\-sort top \\-\\-time week\`\n\n` +
      `👇 _Enter your Reddit target:_`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'r/ClaudeAI --sort new --limit 10',
          selective: true,
        },
      }
    );
    return;
  }

  await executeRedditFetch(ctx, args);
}

export async function handleVReddit(ctx: Context): Promise<void> {
  if (!config.VREDDIT_ENABLED) {
    await replyFeatureDisabled(ctx, 'Reddit video');
    return;
  }

  const text = ctx.message?.text || '';
  const args = text.split(' ').slice(1).join(' ').trim();

  if (!args) {
    await ctx.reply(
      `🎬 *Reddit Video*\n\n` +
      `Download a Reddit\\-hosted video from a post URL\\.\n\n` +
      `*Examples:*\n` +
      `• \`https://www.reddit.com/r/sub/comments/abc123/title/\`\n` +
      `• \`https://www.reddit.com/r/sub/s/shareCode\`\n` +
      `• \`https://redd.it/abc123\`\n\n` +
      `👇 _Paste a Reddit post URL:_`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'https://www.reddit.com/r/sub/comments/abc123/',
          selective: true,
        },
      }
    );
    return;
  }

  await executeVReddit(ctx, args);
}

// ── /transcribe command ────────────────────────────────────────────

/**
 * Send a transcript as text (short) or .txt document (long).
 * Exported so voice.handler.ts can reuse it for the ForceReply path.
 */
export async function sendTranscriptResult(ctx: Context, transcript: string): Promise<void> {
  if (transcript.length <= config.TRANSCRIBE_FILE_THRESHOLD_CHARS) {
    await messageSender.sendMessage(ctx, transcript);
  } else {
    const tmpPath = path.join(os.tmpdir(), `claudegram_transcript_${Date.now()}.txt`);
    try {
      fs.writeFileSync(tmpPath, transcript, { encoding: 'utf-8', mode: 0o600 });
      const inputFile = new InputFile(fs.readFileSync(tmpPath), 'transcript.txt');
      await ctx.replyWithDocument(inputFile, {
        caption: `🎤 Transcript (${transcript.length} chars)`,
      });
    } finally {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch (e) {
        console.warn(`[transcribe] Cleanup failed for ${sanitizePath(tmpPath)}:`, sanitizeError(e));
      }
    }
  }
}

/**
 * Download a Telegram file by file_id → transcribe → send result.
 * Shared helper for reply-to and ForceReply paths.
 */
async function transcribeAndSend(
  ctx: Context,
  fileId: string,
  mimeHint?: string
): Promise<void> {
  if (!config.TRANSCRIBE_ENABLED) {
    await replyFeatureDisabled(ctx, 'Transcribe');
    return;
  }

  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const ackMsg = await ctx.reply('🎤 Transcribing...', { parse_mode: undefined });
  let tempFilePath: string | null = null;

  try {
    const file = await ctx.api.getFile(fileId);
    if (!file.file_path) throw new Error('Telegram did not return file_path.');

    const ext = mimeHint?.includes('ogg') ? '.ogg'
      : mimeHint?.includes('mp3') ? '.mp3'
      : mimeHint?.includes('wav') ? '.wav'
      : mimeHint?.includes('mp4') ? '.m4a'
      : '.oga';
    tempFilePath = path.join(os.tmpdir(), `claudegram_transcribe_${Date.now()}${ext}`);

    await downloadTelegramAudio(config.TELEGRAM_BOT_TOKEN, file.file_path, tempFilePath);

    const buf = fs.readFileSync(tempFilePath);
    if (!buf.length) throw new Error('Downloaded empty audio file.');

    const transcript = await transcribeFile(tempFilePath);

    // Remove ack
    try {
      await ctx.api.deleteMessage(chatId, ackMsg.message_id);
    } catch (e) {
      console.debug('[Transcribe] Failed to delete ack message:', e instanceof Error ? e.message : e);
    }

    await sendTranscriptResult(ctx, transcript);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Transcribe] Error:', sanitizeError(error));
    try {
      await ctx.api.editMessageText(chatId, ackMsg.message_id, `❌ ${errorMessage}`, { parse_mode: undefined });
    } catch {
      await ctx.reply(`❌ Transcription error: ${esc(errorMessage)}`, { parse_mode: 'MarkdownV2' });
    }
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
      } catch (e) {
        console.warn(`[Transcribe] Cleanup failed for ${sanitizePath(tempFilePath)}:`, sanitizeError(e));
      }
    }
  }
}

export async function handleTranscribe(ctx: Context): Promise<void> {
  if (!config.TRANSCRIBE_ENABLED) {
    await replyFeatureDisabled(ctx, 'Transcribe');
    return;
  }

  // Path A: reply to a voice/audio/audio-document message
  const reply = ctx.message?.reply_to_message;
  if (reply) {
    const voice = (reply as { voice?: { file_id: string; mime_type?: string } }).voice;
    const audio = (reply as { audio?: { file_id: string; mime_type?: string } }).audio;
    const doc = (reply as { document?: { file_id: string; mime_type?: string } }).document;

    const fileId = voice?.file_id
      || audio?.file_id
      || (doc?.mime_type?.startsWith('audio/') ? doc.file_id : null);
    const mime = voice?.mime_type || audio?.mime_type || doc?.mime_type;

    if (fileId) {
      await transcribeAndSend(ctx, fileId, mime);
      return;
    }
  }

  // Path B: no audio attached — send ForceReply prompt
  await ctx.reply(
    '🎤 *Transcribe Audio*\n\n_Send a voice note or audio file:_',
    {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        force_reply: true,
        input_field_placeholder: 'Send a voice note or audio file',
        selective: true,
      },
    }
  );
}

/**
 * Handle audio messages (message:audio) sent as reply to the Transcribe ForceReply.
 */
export async function handleTranscribeAudio(ctx: Context): Promise<void> {
  if (!config.TRANSCRIBE_ENABLED) {
    await replyFeatureDisabled(ctx, 'Transcribe');
    return;
  }

  const replyTo = ctx.message?.reply_to_message;
  if (!replyTo || !replyTo.from?.is_bot) return;
  const replyText = (replyTo as { text?: string }).text || '';
  if (!replyText.includes('Transcribe Audio')) return;

  const audio = ctx.message?.audio;
  if (!audio) return;

  await transcribeAndSend(ctx, audio.file_id, audio.mime_type);
}

/**
 * Handle document messages with audio MIME sent as reply to the Transcribe ForceReply.
 */
export async function handleTranscribeDocument(ctx: Context): Promise<void> {
  if (!config.TRANSCRIBE_ENABLED) {
    await replyFeatureDisabled(ctx, 'Transcribe');
    return;
  }

  const replyTo = ctx.message?.reply_to_message;
  if (!replyTo || !replyTo.from?.is_bot) return;
  const replyText = (replyTo as { text?: string }).text || '';
  if (!replyText.includes('Transcribe Audio')) return;

  const doc = ctx.message?.document;
  if (!doc || !doc.mime_type?.startsWith('audio/')) return;

  await transcribeAndSend(ctx, doc.file_id, doc.mime_type);
}

// ── /extract command ───────────────────────────────────────────────

// Store pending extract URLs keyed by sessionKey so the callback knows what to process
const pendingExtractUrls = new Map<string, string>();

// TTLs for cleanup (in ms)
const EXTRACT_URL_TTL_MS = 10 * 60 * 1000; // 10 minutes
const PROJECT_BROWSER_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Track timestamps for extract URLs and project browser
const pendingExtractTimestamps = new Map<string, number>();
const projectBrowserTimestamps = new Map<string, number>();

/**
 * Cleanup interval to prevent memory leaks from unbounded Maps.
 * Runs every 60 seconds and removes stale entries.
 */
// Interval assigned to call .unref() for graceful shutdown
const cleanupInterval = setInterval(() => {
  const now = Date.now();

  // Clean pendingMediumResults (already has expiresAt field)
  for (const [key, entry] of pendingMediumResults.entries()) {
    if (now > entry.expiresAt) {
      pendingMediumResults.delete(key);
      console.log(`[cleanup] Removed stale pendingMediumResults for ${key}`);
    }
  }

  // Clean pendingExtractUrls
  for (const [key, timestamp] of pendingExtractTimestamps.entries()) {
    if (now - timestamp > EXTRACT_URL_TTL_MS) {
      pendingExtractUrls.delete(key);
      pendingExtractTimestamps.delete(key);
      console.log(`[cleanup] Removed stale pendingExtractUrls for ${key}`);
    }
  }

  // Clean projectBrowserState
  for (const [key, timestamp] of projectBrowserTimestamps.entries()) {
    if (now - timestamp > PROJECT_BROWSER_TTL_MS) {
      projectBrowserState.delete(key);
      projectBrowserTimestamps.delete(key);
      console.log(`[cleanup] Removed stale projectBrowserState for ${key}`);
    }
  }
}, 60_000);
cleanupInterval.unref();

export async function handleExtract(ctx: Context): Promise<void> {
  if (!config.EXTRACT_ENABLED) {
    await replyFeatureDisabled(ctx, 'Extract');
    return;
  }

  const text = ctx.message?.text || '';
  const args = text.split(' ').slice(1).join(' ').trim();

  if (!args) {
    await ctx.reply(
      `\u{1F4E5} *Extract Media*\n\n` +
      `Extract text, audio, or video from a URL\\.\n\n` +
      `*Supported platforms:*\n` +
      `\u{25B6}\u{FE0F} YouTube\n` +
      `\u{1F4F7} Instagram\n` +
      `\u{1F3B5} TikTok\n\n` +
      `\u{1F447} _Paste a URL:_`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'https://youtube.com/watch?v=...',
          selective: true,
        },
      }
    );
    return;
  }

  await showExtractMenu(ctx, args);
}

export async function showExtractMenu(ctx: Context, url: string): Promise<void> {
  if (!config.EXTRACT_ENABLED) {
    await replyFeatureDisabled(ctx, 'Extract');
    return;
  }

  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  if (!isValidUrl(url)) {
    await ctx.reply('\u{274C} Invalid URL\\. Please provide a valid link\\.', { parse_mode: 'MarkdownV2' });
    return;
  }

  const platform = detectPlatform(url);
  if (platform === 'unknown') {
    await ctx.reply(
      '\u{26A0}\u{FE0F} Unsupported platform\\. Supported: YouTube, Instagram, TikTok\\.',
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  const label = platformLabel(platform);

  // Store URL for callback (with timestamp for cleanup)
  pendingExtractUrls.set(sessionKey, url);
  pendingExtractTimestamps.set(sessionKey, Date.now());

  await ctx.reply(
    `\u{1F4E5} *Extract from ${esc(label)}*\n\n` +
    `\`${esc(url.length > 60 ? url.slice(0, 57) + '...' : url)}\`\n\n` +
    `What do you want?`,
    {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '\u{1F4DD} Text', callback_data: 'extract:text' },
            { text: '\u{1F3A7} Audio', callback_data: 'extract:audio' },
          ],
          [
            { text: '\u{1F3AC} Video', callback_data: 'extract:video' },
            { text: '\u{2728} All', callback_data: 'extract:all' },
          ],
        ],
      },
    }
  );
}

export async function handleExtractCallback(ctx: Context): Promise<void> {
  if (!config.EXTRACT_ENABLED) {
    await ctx.answerCallbackQuery({ text: 'Feature disabled' });
    await replyFeatureDisabled(ctx, 'Extract');
    return;
  }

  const data = ctx.callbackQuery?.data;
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!data || !keyInfo) return;
  const { chatId, sessionKey } = keyInfo;

  // Handle subtitle format selection (extract:subfmt:<format>)
  if (data.startsWith('extract:subfmt:')) {
    const subtitleFormat = data.replace('extract:subfmt:', '') as SubtitleFormat;
    if (!['text', 'srt', 'vtt'].includes(subtitleFormat)) return;

    await ctx.answerCallbackQuery();

    const url = pendingExtractUrls.get(sessionKey);
    if (!url) {
      await ctx.reply('\u{26A0}\u{FE0F} Session expired\\. Please send the URL again with `/extract`\\.', {
        parse_mode: 'MarkdownV2',
      });
      return;
    }
    pendingExtractUrls.delete(sessionKey);
    pendingExtractTimestamps.delete(sessionKey);

    // Remove the subtitle format menu
    try {
      const menuMsgId = ctx.callbackQuery?.message?.message_id;
      if (menuMsgId) await ctx.api.deleteMessage(chatId, menuMsgId);
    } catch (e) {
      console.debug('[extract] Failed to delete menu message:', e instanceof Error ? e.message : e);
    }

    await executeExtract(ctx, url, 'text', subtitleFormat);
    return;
  }

  const mode = data.replace('extract:', '') as ExtractMode;
  if (!['text', 'audio', 'video', 'all'].includes(mode)) return;

  await ctx.answerCallbackQuery();

  const url = pendingExtractUrls.get(sessionKey);
  if (!url) {
    await ctx.reply('\u{26A0}\u{FE0F} Session expired\\. Please send the URL again with `/extract`\\.', {
      parse_mode: 'MarkdownV2',
    });
    return;
  }

  // YouTube + Text → show subtitle format submenu (keep URL pending)
  const platform = detectPlatform(url);
  if (mode === 'text' && platform === 'youtube') {
    try {
      await ctx.editMessageText(
        `\u{1F4DD} *Subtitle Format*\n\n` +
        `How would you like the transcript?`,
        {
          parse_mode: 'MarkdownV2',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '\u{1F4DD} Plain Text', callback_data: 'extract:subfmt:text' },
              ],
              [
                { text: '\u{1F4CB} SRT', callback_data: 'extract:subfmt:srt' },
                { text: '\u{1F4C4} VTT', callback_data: 'extract:subfmt:vtt' },
              ],
            ],
          },
        }
      );
    } catch {
      // If edit fails, send new message
      await ctx.reply(
        `\u{1F4DD} *Subtitle Format*\n\nHow would you like the transcript?`,
        {
          parse_mode: 'MarkdownV2',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '\u{1F4DD} Plain Text', callback_data: 'extract:subfmt:text' },
              ],
              [
                { text: '\u{1F4CB} SRT', callback_data: 'extract:subfmt:srt' },
                { text: '\u{1F4C4} VTT', callback_data: 'extract:subfmt:vtt' },
              ],
            ],
          },
        }
      );
    }
    return;
  }

  pendingExtractUrls.delete(sessionKey);
  pendingExtractTimestamps.delete(sessionKey);

  // Remove the menu message
  try {
    const menuMsgId = ctx.callbackQuery?.message?.message_id;
    if (menuMsgId) {
      await ctx.api.deleteMessage(chatId, menuMsgId);
    }
  } catch (e) {
    console.debug('[extract] Failed to delete menu message:', e instanceof Error ? e.message : e);
  }

  await executeExtract(ctx, url, mode);
}

export async function executeExtract(ctx: Context, url: string, mode: ExtractMode, subtitleFormat?: SubtitleFormat): Promise<void> {
  if (!config.EXTRACT_ENABLED) {
    await replyFeatureDisabled(ctx, 'Extract');
    return;
  }

  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const ackMsg = await ctx.reply('\u{1F4E5} Processing...', { parse_mode: undefined });

  const updateAck = async (text: string) => {
    try {
      await ctx.api.editMessageText(chatId, ackMsg.message_id, text, { parse_mode: undefined });
    } catch (e) {
      // Update can fail if message was deleted or content unchanged
      console.debug('[extract] Failed to update ack message:', e instanceof Error ? e.message : e);
    }
  };

  let result: ExtractResult | null = null;

  try {
    result = await extractMedia({
      url,
      mode,
      subtitleFormat,
      onProgress: (msg) => updateAck(msg),
    });

    // Delete ack message
    try {
      await ctx.api.deleteMessage(chatId, ackMsg.message_id);
    } catch (e) {
      console.debug('[extract] Failed to delete ack message:', e instanceof Error ? e.message : e);
    }

    // Send results
    const platform = platformLabel(result.platform);
    const title = result.title || 'Untitled';
    const durationStr = result.duration
      ? ` (${Math.floor(result.duration / 60)}:${String(Math.floor(result.duration % 60)).padStart(2, '0')})`
      : '';

    // Header
    const header = `\u{1F4E5} *${esc(platform)}*: ${esc(title)}${esc(durationStr)}`;

    // Send video if available
    if (result.videoPath && fs.existsSync(result.videoPath)) {
      try {
        await ctx.replyWithChatAction('upload_video');
        await ctx.replyWithVideo(new InputFile(result.videoPath), {
          caption: `\u{1F3AC} ${title}${durationStr}`,
          supports_streaming: true,
        });
      } catch (videoSendErr) {
        console.warn('[extract] Failed to send video:', videoSendErr);
        await ctx.reply('\u{26A0}\u{FE0F} Video file could not be sent (may be too large).', { parse_mode: undefined });
      }
    }

    // Send audio if requested (and not already handled by video)
    if (result.audioPath && fs.existsSync(result.audioPath) && (mode === 'audio' || mode === 'all')) {
      try {
        await ctx.replyWithChatAction('upload_voice');
        await ctx.replyWithAudio(new InputFile(result.audioPath), {
          title: title,
          caption: `\u{1F3A7} ${title}${durationStr}`,
        });
      } catch (audioSendErr) {
        console.warn('[extract] Failed to send audio:', audioSendErr);
        await ctx.reply('\u{26A0}\u{FE0F} Audio file could not be sent.', { parse_mode: undefined });
      }
    }

    // Send subtitle file (SRT/VTT) if available
    if (result.subtitlePath && result.subtitleFormat && fs.existsSync(result.subtitlePath)) {
      const ext = result.subtitleFormat; // 'srt' or 'vtt'
      const safeTitle = title.replace(/[^a-zA-Z0-9]/g, '_');
      const fileName = `${safeTitle}.${ext}`;
      try {
        const inputFile = new InputFile(fs.readFileSync(result.subtitlePath), fileName);
        await ctx.replyWithDocument(inputFile, {
          caption: `\u{1F4DD} ${ext.toUpperCase()} subtitles for: ${title}${durationStr}`,
        });
      } catch (subSendErr) {
        console.warn('[extract] Failed to send subtitle file:', subSendErr);
        await ctx.reply('\u{26A0}\u{FE0F} Subtitle file could not be sent.', { parse_mode: undefined });
      }
    }

    // Send transcript (plain text from Whisper or YouTube VTT→text)
    if (result.transcript) {
      if (result.transcript.length <= config.TRANSCRIBE_FILE_THRESHOLD_CHARS) {
        await ctx.reply(`${header}\n\n${esc(result.transcript)}`, {
          parse_mode: 'MarkdownV2',
        });
      } else {
        // Send as .txt file
        const tmpPath = path.join(os.tmpdir(), `extract_transcript_${Date.now()}.txt`);
        try {
          fs.writeFileSync(tmpPath, result.transcript, { encoding: 'utf-8', mode: 0o600 });
          const inputFile = new InputFile(fs.readFileSync(tmpPath), `${title.replace(/[^a-zA-Z0-9]/g, '_')}_transcript.txt`);
          await ctx.replyWithDocument(inputFile, {
            caption: `\u{1F4DD} Transcript (${result.transcript.length} chars)`,
          });
        } finally {
          try {
            if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
          } catch (e) {
            console.warn(`[extract] Cleanup failed for ${sanitizePath(tmpPath)}:`, sanitizeError(e));
          }
        }
      }
    } else if ((mode === 'text' || mode === 'all') && !result.subtitlePath) {
      // Transcript was expected but empty and no subtitle file was sent either
      await ctx.reply('\u{26A0}\u{FE0F} No speech detected in the audio.', { parse_mode: undefined });
    }

    // Show any warnings
    for (const warning of result.warnings) {
      await ctx.reply(`\u{26A0}\u{FE0F} ${warning}`, { parse_mode: undefined });
    }

    // Success summary for non-text modes when no transcript was sent
    if (mode !== 'text' && !result.transcript) {
      await ctx.reply(header, { parse_mode: 'MarkdownV2' });
    }

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[extract] Error:', sanitizeError(error));
    try {
      await ctx.api.editMessageText(chatId, ackMsg.message_id, `\u{274C} ${errorMessage}`, { parse_mode: undefined });
    } catch {
      await ctx.reply(`\u{274C} Extraction failed: ${esc(errorMessage)}`, { parse_mode: 'MarkdownV2' });
    }
  } finally {
    if (result) {
      cleanupExtractResult(result);
    }
  }
}

// ── /btw ─────────────────────────────────────────────────────────

export async function handleBtw(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const text = ctx.message?.text || '';
  const question = text.replace(/^\/btw\s*/i, '').trim();

  if (!question) {
    await ctx.reply('Usage: /btw <your question>\n\nAsk a side question without interrupting the current task.', { parse_mode: undefined });
    return;
  }

  const activeQuery = getActiveQuery(sessionKey);
  if (!activeQuery) {
    await ctx.reply('No active session. Send your question as a regular message instead.', { parse_mode: undefined });
    return;
  }

  // askSideQuestion exists at runtime but isn't in the TypeScript types yet
  const queryAny = activeQuery as unknown as Record<string, unknown>;
  if (typeof queryAny.askSideQuestion !== 'function') {
    await ctx.reply('Side questions are not supported by the current SDK version.', { parse_mode: undefined });
    return;
  }

  try {
    const result = await (queryAny.askSideQuestion as (q: string) => Promise<{ response: string; synthetic: boolean } | null>)(question);
    if (!result || !result.response) {
      await ctx.reply("I don't have enough context to answer that.", { parse_mode: undefined });
      return;
    }
    await messageSender.sendMessage(ctx, `${result.response}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[btw] Error:', msg);
    await ctx.reply(`Failed to answer side question: ${msg}`, { parse_mode: undefined });
  }
}

// ── /effort ──────────────────────────────────────────────────────

const EFFORT_LEVELS: { id: EffortLevel; label: string; description: string }[] = [
  { id: 'low', label: '🐇 Low', description: 'Minimal thinking, fastest' },
  { id: 'medium', label: '⚖️ Medium', description: 'Balanced speed/quality' },
  { id: 'high', label: '🧠 High', description: 'Deep reasoning (default)' },
  { id: 'xhigh', label: '🔬 XHigh', description: 'Extra deep (Opus 4.8)' },
  { id: 'max', label: '🚀 Max', description: 'Maximum effort' },
];

export async function handleEffort(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { chatId } = keyInfo;

  const text = ctx.message?.text || '';
  const args = text.split(' ').slice(1).join(' ').trim().toLowerCase();

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

    await ctx.reply(
      `🎯 *Effort Level*\n\n_Current: ${esc(currentEffort)}_\n\n${descriptions}\n• *Auto* \\- SDK default`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: { inline_keyboard: keyboard },
      }
    );
    return;
  }

  if (args === 'auto' || args === 'default' || args === 'reset') {
    clearEffort(chatId);
    await replyMd(ctx, '✅ Effort reset to *auto* \\(SDK default\\)');
    return;
  }

  if (!isValidEffortLevel(args)) {
    await replyMd(ctx, `❌ Unknown effort level "${esc(args)}"\\.\n\nValid: low, medium, high, xhigh, max, auto`);
    return;
  }

  setEffort(chatId, args);
  const info = EFFORT_LEVELS.find(l => l.id === args);
  await replyMd(ctx, `✅ Effort set to *${esc(info?.label || args)}*`);
}

export async function handleEffortCallback(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { chatId } = keyInfo;

  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith('effort:')) return;

  const level = data.replace('effort:', '');

  if (level === 'auto') {
    clearEffort(chatId);
    await ctx.answerCallbackQuery({ text: 'Effort reset to auto!' });
    await ctx.editMessageText('✅ Effort reset to *auto* \\(SDK default\\)', { parse_mode: 'MarkdownV2' });
    return;
  }

  if (!isValidEffortLevel(level)) {
    await ctx.answerCallbackQuery({ text: 'Invalid effort level' });
    return;
  }

  setEffort(chatId, level);

  const info = EFFORT_LEVELS.find(l => l.id === level);
  const displayName = info?.label || level;

  await ctx.answerCallbackQuery({ text: `Effort set to ${displayName}!` });
  await ctx.editMessageText(`✅ Effort set to *${esc(displayName)}*`, { parse_mode: 'MarkdownV2' });
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
    const topic = sessionTopics.get(sessionKey);
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

// ---------------------------------------------------------------------------
// /tasks — list and inspect SDK background tasks
// ---------------------------------------------------------------------------

interface TaskGroup {
  emoji: string;
  label: string;
  tasks: TaskState[];
}

function groupTasksForDisplay(tasks: TaskState[]): TaskGroup[] {
  const monitors: TaskState[] = [];
  const shells: TaskState[] = [];
  const agents: TaskState[] = [];
  const workflows: TaskState[] = [];
  const other: TaskState[] = [];

  for (const task of tasks) {
    switch (task.taskType) {
      case 'monitor_mcp': monitors.push(task); break;
      case 'local_bash': shells.push(task); break;
      case 'local_workflow': workflows.push(task); break;
      case 'local_agent':
      case 'remote_agent':
      case undefined:
        agents.push(task);
        break;
      default:
        other.push(task);
    }
  }

  const groups: TaskGroup[] = [];
  if (agents.length) groups.push({ emoji: '🤖', label: 'Agents', tasks: agents });
  if (monitors.length) groups.push({ emoji: '📡', label: 'Monitors', tasks: monitors });
  if (shells.length) groups.push({ emoji: '💻', label: 'Shells', tasks: shells });
  if (workflows.length) groups.push({ emoji: '📋', label: 'Workflows', tasks: workflows });
  if (other.length) groups.push({ emoji: '🔹', label: 'Other', tasks: other });
  return groups;
}

function formatTaskElapsed(task: TaskState): string {
  const elapsedMs = (task.endedAt ?? Date.now()) - task.startedAt;
  const seconds = Math.floor(elapsedMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function getActiveTasks(sessionKey: string): TaskState[] {
  return taskTracker.getTasks(sessionKey).filter(t =>
    t.status === 'running' || t.status === 'pending'
  );
}

function renderTasksList(sessionKey: string, tasks: TaskState[]): { text: string; keyboard: { text: string; callback_data: string }[][] } {
  if (tasks.length === 0) {
    // Cross-pointer: a `Bash(run_in_background=true)` shell can outlive its SDK
    // task entry (npm release scripts, deploys), so the statusline's 🔍 counter
    // may show > 0 while /tasks is empty. Surface that here so users know
    // where to look next.
    const claudePid = getPtyProvider().getSessionPid(sessionKey);
    const shellCount = claudePid !== undefined ? getBgProcesses(claudePid).length : 0;
    const lines = ['🔄 *Active background tasks*', '', 'None running\\.'];
    if (shellCount > 0) {
      const noun = shellCount === 1 ? 'shell' : 'shells';
      lines.push('');
      lines.push(`_🔍 ${shellCount} background ${noun} still running — see /bg\\._`);
    }
    return {
      text: lines.join('\n'),
      keyboard: [[{ text: '🔄 Refresh', callback_data: 'tasks:refresh' }]],
    };
  }

  const groups = groupTasksForDisplay(tasks);
  const lines: string[] = [`🔄 *Active background tasks* \\(${tasks.length}\\)`, ''];

  // Number tasks globally so callback buttons match the listed indices.
  let index = 1;
  const numberedTasks: TaskState[] = [];

  for (const group of groups) {
    lines.push(`${group.emoji} *${esc(group.label)}* \\(${group.tasks.length}\\)`);
    for (const task of group.tasks) {
      const desc = task.description.length > 70
        ? task.description.substring(0, 67) + '...'
        : task.description;
      lines.push(`  ${index}\\. ${esc(desc)} · ${esc(formatTaskElapsed(task))}`);
      numberedTasks.push(task);
      index++;
    }
    lines.push('');
  }
  lines.push('_Tap a number to view details\\._');

  const keyboard: { text: string; callback_data: string }[][] = [];
  // Telegram inline keyboards render best at 5 buttons per row for short labels.
  const numberRow: { text: string; callback_data: string }[] = [];
  numberedTasks.forEach((task, i) => {
    numberRow.push({ text: String(i + 1), callback_data: `tasks:view:${task.id}` });
    if (numberRow.length === 5 || i === numberedTasks.length - 1) {
      keyboard.push([...numberRow]);
      numberRow.length = 0;
    }
  });
  keyboard.push([{ text: '🔄 Refresh', callback_data: 'tasks:refresh' }]);

  return { text: lines.join('\n'), keyboard };
}

function renderTaskDetail(task: TaskState): { text: string; keyboard: { text: string; callback_data: string }[][] } {
  const groupHint = (() => {
    switch (task.taskType) {
      case 'monitor_mcp': return '📡 Monitor';
      case 'local_bash': return '💻 Shell';
      case 'local_workflow': return '📋 Workflow';
      case 'local_agent':
      case 'remote_agent':
      case undefined: return '🤖 Agent';
      default: return '🔹 Task';
    }
  })();

  const lines: string[] = [
    `${groupHint}: *${esc(task.description)}*`,
    '',
    `• *Status:* ${esc(task.status)}`,
    `• *Backgrounded:* ${task.isBackgrounded ? 'yes' : 'no'}`,
    `• *Started:* ${esc(formatTaskElapsed(task))} ago`,
  ];
  if (task.taskType) {
    lines.push(`• *Type:* \`${esc(task.taskType)}\``);
  }
  if (task.lastProgress?.lastToolName) {
    lines.push(`• *Last tool:* \`${esc(task.lastProgress.lastToolName)}\``);
  }
  if (task.lastProgress?.usage) {
    const u = task.lastProgress.usage;
    lines.push(`• *Tokens:* ${esc(String(u.totalTokens))} · *Tool uses:* ${esc(String(u.toolUses))}`);
  }
  if (task.lastProgress?.summary) {
    const summary = task.lastProgress.summary.length > 300
      ? task.lastProgress.summary.substring(0, 297) + '...'
      : task.lastProgress.summary;
    lines.push('');
    lines.push('*Latest progress:*');
    lines.push(`> ${esc(summary)}`);
  }
  if (task.error) {
    lines.push('');
    lines.push(`⚠️ ${esc(task.error)}`);
  }

  return {
    text: lines.join('\n'),
    keyboard: [
      [
        { text: '← Back to list', callback_data: 'tasks:back' },
        { text: '🔄 Refresh', callback_data: `tasks:view:${task.id}` },
      ],
    ],
  };
}

export async function handleTasks(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) {
    await ctx.reply('❌ Could not determine chat context for /tasks.');
    return;
  }

  const tasks = getActiveTasks(keyInfo.sessionKey);
  const { text, keyboard } = renderTasksList(keyInfo.sessionKey, tasks);

  await ctx.reply(text, {
    parse_mode: 'MarkdownV2',
    reply_markup: { inline_keyboard: keyboard },
  });
}

export async function handleTasksCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!data || !keyInfo) {
    await ctx.answerCallbackQuery().catch(() => {});
    return;
  }
  const { sessionKey } = keyInfo;

  if (data === 'tasks:refresh' || data === 'tasks:back') {
    const tasks = getActiveTasks(sessionKey);
    const { text, keyboard } = renderTasksList(sessionKey, tasks);
    await ctx.answerCallbackQuery().catch(() => {});
    try {
      await ctx.editMessageText(text, {
        parse_mode: 'MarkdownV2',
        reply_markup: { inline_keyboard: keyboard },
      });
    } catch (err) {
      // "message is not modified" is fine — content already up to date.
      const msg = err instanceof Error ? err.message.toLowerCase() : '';
      if (!msg.includes('message is not modified')) {
        console.error('[Tasks] Failed to refresh list:', err);
      }
    }
    return;
  }

  if (data.startsWith('tasks:view:')) {
    const taskId = data.substring('tasks:view:'.length);
    const task = taskTracker.getTask(sessionKey, taskId);
    if (!task) {
      // Task finished or was cleared between renders — go back to the list.
      const tasks = getActiveTasks(sessionKey);
      const { text, keyboard } = renderTasksList(sessionKey, tasks);
      await ctx.answerCallbackQuery({ text: 'Task no longer active.' }).catch(() => {});
      try {
        await ctx.editMessageText(text, {
          parse_mode: 'MarkdownV2',
          reply_markup: { inline_keyboard: keyboard },
        });
      } catch { /* ignore */ }
      return;
    }
    const { text, keyboard } = renderTaskDetail(task);
    await ctx.answerCallbackQuery().catch(() => {});
    try {
      await ctx.editMessageText(text, {
        parse_mode: 'MarkdownV2',
        reply_markup: { inline_keyboard: keyboard },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message.toLowerCase() : '';
      if (!msg.includes('message is not modified')) {
        console.error('[Tasks] Failed to render detail:', err);
      }
    }
    return;
  }

  await ctx.answerCallbackQuery().catch(() => {});
}

// ── /bg ─────────────────────────────────────────────────────────
// List OS-level child processes of the chat's PTY claude session and offer
// a one-tap SIGTERM. Complements /tasks (which only sees SDK-tracked tasks)
// and rescues `Bash(run_in_background=true)` shells whose stop condition
// will never fire.

const BG_MCP_SERVER_MARKER = 'mcp-server.js';

function formatBgAge(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return m > 0 ? `${h}h${m}m` : `${h}h`;
  }
  return `${Math.floor(sec / 86400)}d`;
}

function truncateBgCmd(cmd: string, max = 150): string {
  if (cmd.length <= max) return cmd;
  return cmd.substring(0, max - 1) + '…';
}

// Claude's `Bash(run_in_background=true)` shells are spawned as
//   <shell> -c "source <snapshot> && setopt … && eval '<USER_CMD>' < /dev/null && pwd -P >| /tmp/…"
// The wrapper is noise — pull out the real command between `eval '` and the
// trailing `' < /dev/null`. Returns the original cmd if the pattern doesn't
// match (e.g. the MCP server, foreign children).
function unwrapBgCmd(cmd: string): string {
  const evalIdx = cmd.indexOf("eval '");
  if (evalIdx === -1) return cmd;
  const start = evalIdx + "eval '".length;
  const tail = cmd.indexOf("' < /dev/null", start);
  if (tail === -1 || tail <= start) return cmd;
  return cmd.substring(start, tail);
}

function getBgProcesses(claudePid: number): ProcInfo[] {
  const result: ProcInfo[] = [];
  for (const childPid of getDirectChildren(claudePid)) {
    const info = describeProcess(childPid);
    if (!info) continue;
    if (info.cmd.includes(BG_MCP_SERVER_MARKER)) continue;
    result.push(info);
  }
  return result;
}

function renderBgList(sessionKey: string, claudePid: number | undefined, procs: ProcInfo[]): {
  text: string;
  keyboard: { text: string; callback_data: string }[][];
} {
  if (claudePid === undefined) {
    return {
      text:
        '🔍 *Background processes*\n\n' +
        '_No active PTY session for this chat\\._\n\n' +
        'In SDK mode, use /tasks to inspect tracked background tasks\\.',
      keyboard: [],
    };
  }
  if (procs.length === 0) {
    // Cross-pointer to /tasks when SDK-tracked tasks (agents, monitors) are
    // running but no OS shells are.
    const taskCount = getActiveTasks(sessionKey).length;
    const lines = ['🔍 *Background processes*', '', 'None running\\.'];
    if (taskCount > 0) {
      const noun = taskCount === 1 ? 'task' : 'tasks';
      lines.push('');
      lines.push(`_🔄 ${taskCount} SDK ${noun} still running — see /tasks\\._`);
    }
    return {
      text: lines.join('\n'),
      keyboard: [[{ text: '🔄 Refresh', callback_data: 'bg:refresh' }]],
    };
  }

  const lines: string[] = [`🔍 *Background processes* \\(${procs.length}\\)`, ''];
  procs.forEach((p, i) => {
    lines.push(`*${i + 1}\\.* \\[${esc(formatBgAge(p.ageSec))}\\] pid \`${esc(String(p.pid))}\``);
    lines.push(`\`${esc(truncateBgCmd(unwrapBgCmd(p.cmd)))}\``);
    lines.push('');
  });
  lines.push('_Tap a number to SIGTERM that process \\(and its descendants\\)\\._');

  const keyboard: { text: string; callback_data: string }[][] = [];
  let row: { text: string; callback_data: string }[] = [];
  procs.forEach((p, i) => {
    row.push({ text: `🛑 #${i + 1}`, callback_data: `bg:kill:${p.pid}` });
    if (row.length === 4 || i === procs.length - 1) {
      keyboard.push(row);
      row = [];
    }
  });
  keyboard.push([
    { text: '🛑 Kill all', callback_data: 'bg:killall' },
    { text: '🔄 Refresh', callback_data: 'bg:refresh' },
  ]);
  return { text: lines.join('\n'), keyboard };
}

async function rerenderBg(ctx: Context, sessionKey: string, claudePid: number | undefined): Promise<void> {
  // Brief grace period so killed processes drop out of /proc before we re-read.
  await new Promise((r) => setTimeout(r, 200));
  const procs = claudePid !== undefined ? getBgProcesses(claudePid) : [];
  const { text, keyboard } = renderBgList(sessionKey, claudePid, procs);
  try {
    await ctx.editMessageText(text, {
      parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: keyboard },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message.toLowerCase() : '';
    if (!msg.includes('message is not modified')) {
      console.error('[/bg] Failed to refresh list:', err);
    }
  }
}

export async function handleBg(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) {
    await ctx.reply('❌ Could not determine chat context for /bg.');
    return;
  }
  const claudePid = getPtyProvider().getSessionPid(keyInfo.sessionKey);
  const procs = claudePid !== undefined ? getBgProcesses(claudePid) : [];
  const { text, keyboard } = renderBgList(keyInfo.sessionKey, claudePid, procs);
  await ctx.reply(text, {
    parse_mode: 'MarkdownV2',
    reply_markup: { inline_keyboard: keyboard },
  });
}

export async function handleBgCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!data || !keyInfo) {
    await ctx.answerCallbackQuery().catch(() => {});
    return;
  }
  const claudePid = getPtyProvider().getSessionPid(keyInfo.sessionKey);

  if (data === 'bg:refresh') {
    await ctx.answerCallbackQuery().catch(() => {});
    await rerenderBg(ctx, keyInfo.sessionKey, claudePid);
    return;
  }

  if (data === 'bg:killall') {
    if (claudePid === undefined) {
      await ctx.answerCallbackQuery({ text: 'No active session.' }).catch(() => {});
      return;
    }
    const procs = getBgProcesses(claudePid);
    let total = 0;
    for (const p of procs) total += killTree(p.pid);
    await ctx.answerCallbackQuery({ text: `SIGTERM sent to ${total} process(es).` }).catch(() => {});
    await rerenderBg(ctx, keyInfo.sessionKey, claudePid);
    return;
  }

  if (data.startsWith('bg:kill:')) {
    const pid = Number.parseInt(data.substring('bg:kill:'.length), 10);
    if (claudePid === undefined || !Number.isFinite(pid)) {
      await ctx.answerCallbackQuery({ text: 'Unknown target.' }).catch(() => {});
      return;
    }
    // PIDs can be recycled — refuse to signal anything that's no longer a
    // descendant of this chat's claude session.
    if (!isDescendantOf(claudePid, pid)) {
      await ctx.answerCallbackQuery({ text: `PID ${pid} no longer belongs to this session.` }).catch(() => {});
      await rerenderBg(ctx, keyInfo.sessionKey, claudePid);
      return;
    }
    const killed = killTree(pid);
    await ctx.answerCallbackQuery({ text: `SIGTERM sent (${killed} process(es)).` }).catch(() => {});
    await rerenderBg(ctx, keyInfo.sessionKey, claudePid);
    return;
  }

  await ctx.answerCallbackQuery().catch(() => {});
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
