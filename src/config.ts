import { config as loadEnv } from 'dotenv';
import { z } from 'zod';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { legacyEnv } from './utils/legacy-env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultEnvPath = path.resolve(__dirname, '..', '.env');
// Read from the real process env, not the .env file — this is the var that
// says *which* .env to load, so it can't come from inside one.
const envPath = legacyEnv('ENV_PATH') || defaultEnvPath;
loadEnv({ path: envPath });

const toBool = (val: string) => val.toLowerCase() === 'true';

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'Telegram bot token is required'),
  ALLOWED_USER_IDS: z
    .string()
    .min(1, 'At least one allowed user ID is required')
    .transform((val) => val.split(',').map((id) => parseInt(id.trim(), 10))),
  ALLOWED_GROUP_IDS: z
    .string()
    .default('')
    .transform((val) => val ? val.split(',').map((id) => parseInt(id.trim(), 10)) : []),
  // In a group, only act on messages that address the bot — an @mention, a
  // reply to something the bot sent, or a slash command. Off means every
  // message in an allow-listed group is a prompt, which drowns out any human
  // conversation happening in the same group.
  GROUP_REQUIRE_MENTION: z.string().default('true').transform(toBool),
  // Prefix that opts a group message out of being a prompt, even when it
  // replies to the bot or mentions it — for quoting the bot at each other
  // without setting it off. Empty string disables the escape hatch.
  GROUP_IGNORE_PREFIX: z.string().default('//'),
  ANTHROPIC_API_KEY: z.string().optional(), // Optional - uses Claude Max subscription if not set
  // OpenAI (TTS)
  OPENAI_API_KEY: z.string().optional(),
  WORKSPACE_DIR: z.string().default(process.env.HOME || '.'),
  CLAUDE_EXECUTABLE_PATH: z.string().default('claude'),
  CLAUDE_USE_BUNDLED_EXECUTABLE: z
    .string()
    .default('true')
    .transform((val) => val.toLowerCase() === 'true'),
  CLAUDE_SDK_LOG_LEVEL: z.enum(['off', 'basic', 'verbose', 'trace']).default('basic'),
  CLAUDE_SDK_INCLUDE_PARTIAL: z
    .string()
    .default('false')
    .transform((val) => val.toLowerCase() === 'true'),
  // Load user-level Claude settings (~/.claude/settings.json: plugins, hooks, MCP servers)
  // into the bot's SDK subprocess. Default false so the bot runs in an isolated env;
  // user-level plugins/MCP servers can otherwise inflate tool counts and trigger the
  // SDK's tool-deferral mechanism, breaking proactive MCP tool calls (e.g. auto-topic).
  CLAUDE_SDK_LOAD_USER_SETTINGS: z
    .string()
    .default('false')
    .transform((val) => val.toLowerCase() === 'true'),
  CLAUDE_REASONING_SUMMARY: z
    .string()
    .default('true')
    .transform((val) => val.toLowerCase() === 'true'),
  BOT_NAME: z.string().default('TeleCoder'),
  DYNAMIC_BOT_NAME: z
    .string()
    .default('false')
    .transform((val) => val.toLowerCase() === 'true'),
  // Fire a parallel Haiku side-call on every user message to derive a topic
  // label, independent of the main agent's tool calls. Deferral-immune because
  // it bypasses settingSources and tools entirely. Only takes effect when
  // dynamic bot name is enabled for the chat.
  AUTO_TOPIC_HAIKU: z
    .string()
    .default('true')
    .transform((val) => val.toLowerCase() === 'true'),
  // Default for the per-chat "predicted next prompt" feature: when enabled,
  // TeleCoder sets CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=1 on the PTY spawn
  // and scrapes the ghost-text suggestion that claude renders into its input
  // box after each turn, surfacing it as an inline button under the response.
  // Per-chat override via /suggestions; takes effect on next session spawn.
  // Off by default — feature relies on Anthropic's growthbook flag being on
  // for the account, and the suggestion is a speculative API call.
  PROMPT_SUGGESTIONS_DEFAULT: z
    .string()
    .default('false')
    .transform((val) => val.toLowerCase() === 'true'),
  BOT_MODE: z.enum(['dev', 'prod']).default('dev'),
  STREAMING_MODE: z.enum(['streaming', 'wait']).default('streaming'),
  STREAMING_DEBOUNCE_MS: z
    .string()
    .default('500')
    .transform((val) => parseInt(val, 10)),
  MAX_MESSAGE_LENGTH: z
    .string()
    .default('4000')
    .transform((val) => parseInt(val, 10)),
  // TTS Configuration
  TTS_ENABLED: z.string().default('true').transform(toBool),
  TTS_PROVIDER: z.enum(['groq', 'openai']).default('groq'),
  TTS_MODEL: z.string().default('gpt-4o-mini-tts'),
  TTS_VOICE: z.string().default('coral'),
  TTS_INSTRUCTIONS: z.string().default('Speak in a friendly, natural conversational tone.'),
  TTS_SPEED: z
    .string()
    .default('1.0')
    .transform((val) => parseFloat(val)),
  TTS_MAX_CHARS: z
    .string()
    .default('4096')
    .transform((val) => parseInt(val, 10)),
  TTS_RESPONSE_FORMAT: z.string().default('opus'),
  IMAGE_MAX_FILE_SIZE_MB: z
    .string()
    .default('20')
    .transform((val) => parseInt(val, 10)),
  // 19, not 25: Telegram's getFile refuses anything over 20MB, so a 25MB
  // ceiling let files through this guard only to fail at download with an
  // opaque 400. Matches VOICE_MAX_FILE_SIZE_MB, which already sat under the cap.
  DOCUMENT_MAX_FILE_SIZE_MB: z
    .string()
    .default('19')
    .transform((val) => parseInt(val, 10)),
  // New config options
  DANGEROUS_MODE: z
    .string()
    .default('false')
    .transform((val) => val.toLowerCase() === 'true'),
  MAX_LOOP_ITERATIONS: z
    .string()
    .default('5')
    .transform((val) => parseInt(val, 10)),
  AUTO_RESTORE_SESSION: z.string().default('false').transform(toBool),
  REDDITFETCH_JSON_THRESHOLD_CHARS: z
    .string()
    .default('8000')
    .transform((val) => parseInt(val, 10)),
  // Reddit API credentials (native TypeScript module)
  REDDIT_CLIENT_ID: z.string().optional(),
  REDDIT_CLIENT_SECRET: z.string().optional(),
  REDDIT_USERNAME: z.string().optional(),
  REDDIT_PASSWORD: z.string().optional(),
  // Reddit fetch configuration
  REDDIT_ENABLED: z.string().default('true').transform(toBool),
  // DEPRECATED: REDDITFETCH_PATH — replaced by native TypeScript module; kept for reference only
  REDDITFETCH_PATH: z.string().default(''),
  REDDITFETCH_TIMEOUT_MS: z
    .string()
    .default('30000')
    .transform((val) => parseInt(val, 10)),
  REDDITFETCH_DEFAULT_LIMIT: z
    .string()
    .default('10')
    .transform((val) => parseInt(val, 10)),
  REDDITFETCH_DEFAULT_DEPTH: z
    .string()
    .default('5')
    .transform((val) => parseInt(val, 10)),
  // Reddit video download
  VREDDIT_ENABLED: z.string().default('true').transform(toBool),
  REDDIT_VIDEO_MAX_SIZE_MB: z
    .string()
    .default('50')
    .transform((val) => parseInt(val, 10)),
  // Telegraph (Instant View for long messages)
  TELEGRAPH_ENABLED: z.string().default('true').transform(toBool),
  // Medium / Freedium configuration
  MEDIUM_ENABLED: z.string().default('true').transform(toBool),
  MEDIUM_TIMEOUT_MS: z
    .string()
    .default('15000')
    .transform((val) => parseInt(val, 10)),
  MEDIUM_FILE_THRESHOLD_CHARS: z
    .string()
    .default('8000')
    .transform((val) => parseInt(val, 10)),
  FREEDIUM_HOST: z.string().default('freedium-mirror.cfd'),
  FREEDIUM_RATE_LIMIT_MS: z
    .string()
    .default('2000')
    .transform((val) => parseInt(val, 10)),
  // Voice transcription (Groq Whisper)
  GROQ_API_KEY: z.string().optional(),
  GROQ_TRANSCRIBE_PATH: z.string().default(''),
  TRANSCRIBE_ENABLED: z.string().default('true').transform(toBool),
  VOICE_SHOW_TRANSCRIPT: z
    .string()
    .default('true')
    .transform((val) => val.toLowerCase() === 'true'),
  VOICE_MAX_FILE_SIZE_MB: z
    .string()
    .default('19')
    .transform((val) => parseInt(val, 10)),
  VOICE_LANGUAGE: z.string().default('en'),
  VOICE_TIMEOUT_MS: z
    .string()
    .default('60000')
    .transform((val) => parseInt(val, 10)),
  // Transcribe command: send .txt file if transcript exceeds this many chars
  TRANSCRIBE_FILE_THRESHOLD_CHARS: z
    .string()
    .default('4000')
    .transform((val) => parseInt(val, 10)),
  // Media extraction (/extract command)
  EXTRACT_ENABLED: z.string().default('true').transform(toBool),
  YTDLP_COOKIES_PATH: z.string().default(''),
  YTDLP_PROXY_LIST_PATH: z.string().default(''),
  EXTRACT_TRANSCRIBE_TIMEOUT_MS: z
    .string()
    .default('180000')
    .transform((val) => parseInt(val, 10)),
  // Verbosity tier (quiet | normal | verbose | debug). Drives the defaults
  // for several rendering flags below; per-chat /verbosity overrides this,
  // and explicit env vars (CONTEXT_SHOW_USAGE etc.) override the tier.
  VERBOSITY_DEFAULT: z.enum(['quiet', 'normal', 'verbose', 'debug']).default('normal'),
  // Context visibility — when set, overrides the verbosity tier. Leave unset
  // to let the tier decide (recommended).
  CONTEXT_SHOW_USAGE: z
    .string()
    .default('false')
    .transform((val) => val.toLowerCase() === 'true'),
  CONTEXT_NOTIFY_COMPACTION: z
    .string()
    .default('true')
    .transform((val) => val.toLowerCase() === 'true'),
  // Terminal UI mode
  TERMINAL_UI_DEFAULT: z
    .string()
    .default('true')
    .transform((val) => val.toLowerCase() === 'true'),
  // Terminal UI verbose: show full commands/paths without truncation and longer session previews.
  // When set, overrides the verbosity tier.
  TERMINAL_UI_VERBOSE: z
    .string()
    .default('false')
    .transform((val) => val.toLowerCase() === 'true'),
  ALLOW_PRIVATE_NETWORK_URLS: z
    .string()
    .default('false')
    .transform((val) => val.toLowerCase() === 'true'),
  // Logging: show SDK hook JSON dumps (PreToolUse, PostToolUse, stderr, etc.)
  // When false (default), verbose mode shows clean operational logs without hook noise.
  // When true, verbose mode includes full hook JSON payloads and stderr output.
  LOG_AGENT_HOOKS: z
    .string()
    .default('false')
    .transform((val) => val.toLowerCase() === 'true'),
  // Message batching: combine rapid-fire messages (e.g. Telegram splitting long
  // pastes) into a single prompt. 0 = disabled.
  MESSAGE_BATCH_TIMEOUT_MS: z
    .string()
    .default('0')
    .transform((val) => parseInt(val, 10)),
  // Cancel behaviour: auto-cancel running query when user sends a new message
  CANCEL_ON_NEW_MESSAGE: z
    .string()
    .default('false')
    .transform((val) => val.toLowerCase() === 'true'),
  // Agent watchdog: detect stuck/unresponsive agent queries
  AGENT_WATCHDOG_ENABLED: z.string().default('true').transform(toBool),
  AGENT_WATCHDOG_WARN_SECONDS: z
    .string()
    .default('30')
    .transform((val) => parseInt(val, 10)),
  AGENT_WATCHDOG_LOG_SECONDS: z
    .string()
    .default('10')
    .transform((val) => parseInt(val, 10)),
  AGENT_QUERY_TIMEOUT_MS: z
    .string()
    .default('0')
    .transform((val) => parseInt(val, 10)), // 0 = disabled
  AGENT_SILENCE_TIMEOUT_MS: z
    .string()
    .default('180000')
    .transform((val) => parseInt(val, 10)), // 0 = disabled, default 3 minutes
  AGENT_STALE_TOOL_TIMEOUT_MS: z
    .string()
    .default('180000')
    .transform((val) => parseInt(val, 10)), // 0 = disabled, default 3 minutes
  // Absolute wall-clock cap for a single PTY turn (ms). The turn is killed
  // with a "turn exceeded" error if it runs longer. Default 2 h — long
  // enough for genuinely intensive multi-step work; raise it if you regularly
  // hit the cap on legitimately long turns.
  CLAUDE_PTY_HARD_TIMEOUT_MS: z
    .string()
    .default('7200000')
    .transform((val) => parseInt(val, 10)),
  // HTTP proxy for Telegram API requests (e.g. socks5://127.0.0.1:1080 or http://proxy:8080)
  TELEGRAM_PROXY_URL: z.string().optional(),
  // Completion notification (send a new message after long streaming tasks)
  NOTIFICATION_ENABLED: z.string().default('true').transform(toBool),
  NOTIFICATION_THRESHOLD_SECONDS: z
    .string()
    .default('60')
    .transform((val) => parseInt(val, 10)),
  // Claude Code Router (CCR) provider — redirects the spawned `claude` binary
  // through a local CCR proxy so it can be backed by non-Anthropic models.
  // Useful as a fallback when the Max usage limit is reached.
  CCR_ENABLED: z
    .string()
    .default('false')
    .transform((val) => val.toLowerCase() === 'true'),
  CCR_BASE_URL: z.string().default('http://localhost:3456'),
  CCR_AUTH_TOKEN: z.string().default(''),
  // When the CCR proxy isn't reachable, automatically spawn `ccr start` in
  // the background instead of letting the spawned `claude` CLI hang on a
  // ConnectionRefused. Off by default — opt in if you want hands-off recovery.
  CCR_AUTOSTART: z
    .string()
    .default('false')
    .transform((val) => val.toLowerCase() === 'true'),
  // Path or name of the `ccr` binary used for autostart. Defaults to `ccr`
  // (resolved via PATH). Override if `ccr` lives somewhere systemd can't see.
  CCR_BINARY: z.string().default('ccr'),
  // When the Anthropic API reports a Max usage limit, automatically prompt
  // the user with an inline keyboard offering to switch to CCR.
  CCR_AUTO_PROMPT_ON_THROTTLE: z
    .string()
    .default('true')
    .transform((val) => val.toLowerCase() === 'true'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment configuration:');
  console.error(parsed.error.message);
  process.exit(1);
}

// /reddit is the one integration with a hard credential gate: without an OAuth
// app it can only ever fail. Unless REDDIT_ENABLED says otherwise, key it off
// the credentials so a fresh install doesn't advertise a command that cannot
// work. Setting REDDIT_ENABLED explicitly still wins in both directions.
const redditConfigured = Boolean(
  parsed.data.REDDIT_CLIENT_ID &&
    parsed.data.REDDIT_CLIENT_SECRET &&
    parsed.data.REDDIT_USERNAME &&
    parsed.data.REDDIT_PASSWORD
);

export const config = {
  ...parsed.data,
  REDDIT_ENABLED: isEnvSet('REDDIT_ENABLED') ? parsed.data.REDDIT_ENABLED : redditConfigured,
};

export type Config = typeof config;

// Capture which override env vars were explicitly set (after dotenv has loaded
// process.env). The verbosity resolver consults these to decide whether to
// honor the env value or fall back to the per-tier default.
function isEnvSet(key: string): boolean {
  const raw = process.env[key];
  return raw !== undefined && raw !== '';
}

export const explicitFlags = {
  CONTEXT_SHOW_USAGE: isEnvSet('CONTEXT_SHOW_USAGE'),
  CONTEXT_NOTIFY_COMPACTION: isEnvSet('CONTEXT_NOTIFY_COMPACTION'),
  TERMINAL_UI_VERBOSE: isEnvSet('TERMINAL_UI_VERBOSE'),
} as const;

// ---------------------------------------------------------------------------
// Derived helpers (used by index.ts, command.handler.ts, session-history.ts)
// ---------------------------------------------------------------------------

import { getStateDir } from './utils/json-store.js';

/** Numeric bot ID extracted from the Telegram token (e.g. "123456" from "123456:ABC..."). */
export const BOT_ID = config.TELEGRAM_BOT_TOKEN.split(':')[0];

const STATE_DIR = getStateDir();

/** Per-bot reload marker file path so multi-instance setups don't cross-restore. */
export function getReloadMarkerPath(): string {
  return getReloadMarkerPathForBotId(BOT_ID);
}

/** Same as getReloadMarkerPath, but for an arbitrary bot ID — used by the
 * launcher when it needs to write markers for sibling bots on /restartbot all
 * and /rebuildbot all. */
export function getReloadMarkerPathForBotId(botId: string): string {
  return path.join(STATE_DIR, `pending-reload-${botId}.json`);
}
