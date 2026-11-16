import { config as loadEnv } from 'dotenv';
import { z } from 'zod';
import * as path from 'path';
import { legacyEnv } from './utils/legacy-env.js';
import { parseIdList } from './utils/id-list.js';
import { configFile } from './utils/config-home.js';
import { isWellFormedBotToken, MALFORMED_TOKEN_MESSAGE } from './utils/bot-token.js';
import {
  envFileStatus, formatConfigReport, problemsFromIssues, type ConfigProblem,
} from './config-report.js';
import { exitForConfigError } from './utils/exit-codes.js';

// Next to package.json in a checkout, ~/.telecoder/.env for an npm install —
// see utils/config-home.ts.
const defaultEnvPath = configFile('.env');
// Read from the real process env, not the .env file — this is the var that
// says *which* .env to load, so it can't come from inside one.
const envPath = legacyEnv('ENV_PATH') || defaultEnvPath;
const loadedEnv = loadEnv({ path: envPath });
/** The .env file this process read, for messages that tell the user where to add a setting. */
export const envFilePath = envPath;

/**
 * Which values in the .env file are being ignored because the process was
 * started with them already in its environment.
 *
 * dotenv never overwrites what is already there, which is the right default —
 * it is how a launcher hands each worker its own instance config. The trap is
 * that a restart inherits the environment it was started from, so a value
 * exported into the shell that first launched the bot outranks the file
 * forever, and no amount of editing .env or restarting from chat can dislodge
 * it. Naming the shadowed keys at startup turns a silent mystery into a line
 * in the log.
 */
export function findShadowedEnvKeys(
  fromFile: Record<string, string> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (!fromFile) return [];
  // A launcher worker is handed its config through the environment on purpose.
  if (env.TELECODER_INSTANCE_NAME) return [];
  return Object.keys(fromFile).filter((key) => env[key] !== fromFile[key]);
}

const shadowed = findShadowedEnvKeys(loadedEnv.parsed);
if (shadowed.length > 0) {
  // Names only — one of these is the bot token.
  console.warn(
    `[env] Ignoring ${shadowed.length} value(s) from ${envPath}: this process was started with ` +
    `them already set in its environment, and that wins over the file — ${shadowed.join(', ')}. ` +
    'Restart from a shell that does not export them if you meant the file to apply.'
  );
}

const toBool = (val: string) => val.toLowerCase() === 'true';

/**
 * A comma-separated id list, validated by parseIdList: non-numeric entries
 * (`@alice`) and the .env.example placeholder fail startup with a message
 * saying what to put there instead.
 */
const idList = (name: string, kind: 'user' | 'group' = 'user') =>
  (val: string, ctx: z.RefinementCtx): number[] => {
    const result = parseIdList(name, val, kind);
    if (!result.ok) {
      ctx.addIssue({ code: 'custom', message: result.error });
      return z.NEVER;
    }
    return result.ids;
  };

const envSchema = z.object({
  // Checked by shape here, before anything uses it; whether Telegram accepts
  // it is checked at startup (startup/verify-token.ts).
  TELEGRAM_BOT_TOKEN: z
    .string()
    .min(1, 'Telegram bot token is required')
    .refine(isWellFormedBotToken, MALFORMED_TOKEN_MESSAGE),
  ALLOWED_USER_IDS: z
    .string()
    .min(1, 'At least one allowed user ID is required (your own numeric Telegram id — get it from @userinfobot)')
    .transform(idList('ALLOWED_USER_IDS'))
    .refine((ids) => ids.length > 0, 'ALLOWED_USER_IDS has no ids in it — put your own numeric Telegram id there (get it from @userinfobot)'),
  ALLOWED_GROUP_IDS: z
    .string()
    .default('')
    .transform(idList('ALLOWED_GROUP_IDS', 'group')),
  // The subset of ALLOWED_USER_IDS that may approve permission prompts and run
  // bot-lifecycle / transport commands. Empty means every allowed user is an
  // admin, which is the behaviour every install had before this existed — so a
  // solo bot is unaffected and only a shared one needs to set it.
  // See src/utils/admins.ts for the roster logic.
  ADMIN_USER_IDS: z
    .string()
    .default('')
    .transform(idList('ADMIN_USER_IDS')),
  // The subset of ALLOWED_USER_IDS that may answer an approval prompt without
  // owning the bot. An approver is still a guest everywhere else — the charter
  // judge still reads their messages, the gate still stops their tool calls,
  // and the lifecycle commands are still closed to them. All they gain is the
  // right to answer *someone else's* prompt, which is what stops one owner
  // being the bottleneck for a bot several people use.
  //
  // They cannot answer their own: an approval the requester taps themselves
  // confirms nothing, which is the whole reason the roster is narrowed at all.
  // Ids that ADMIN_USER_IDS already carries are ignored here — admins can
  // approve anyway, and listing someone twice should not mean something new.
  // Only meaningful alongside ADMIN_USER_IDS; with that unset every allowed
  // user is already an admin and there is nothing left for this to widen.
  // See src/utils/admins.ts for the roster logic.
  APPROVER_USER_IDS: z
    .string()
    .default('')
    .transform(idList('APPROVER_USER_IDS')),
  // Confine non-admins to the groups in ALLOWED_GROUP_IDS. Without this a
  // shared bot is still reachable in a private chat, where the owner cannot
  // see what is being asked of it — which defeats the point of sharing it in a
  // group. Admins are unaffected and can always DM the bot.
  RESTRICT_TO_GROUPS: z.string().default('false').transform(toBool),
  // Scope guard: prompt when a tool call names a path outside the shared
  // projects, or a credential path anywhere. 'auto' follows the permission
  // gate, which is what a shared bot wants; 'on'/'off' force it.
  SCOPE_GUARD: z.enum(['auto', 'on', 'off']).default('auto'),
  // Extra directories the scope guard treats as in-bounds, on top of
  // WORKSPACE_DIR and the temp dir. Comma-separated absolute paths.
  SCOPE_ALLOWED_PATHS: z
    .string()
    .default('')
    .transform((val) => (val ? val.split(',').map((p) => p.trim()).filter(Boolean) : [])),
  // Charter judge: a Haiku side-call that reads each guest's message against a
  // plain-language charter and holds anything out of bounds for an admin.
  // 'auto' turns it on when the bot has guests.
  CHARTER_JUDGE: z.enum(['auto', 'on', 'off']).default('auto'),
  // Path to the charter the judge reads. Defaults to CHARTER.md in the
  // workspace root when that file exists, and to a generated one otherwise.
  CHARTER_FILE: z.string().default(''),
  // How long a permission prompt waits for an admin before auto-denying.
  // Ten minutes is fine when the approver is the person who typed the request;
  // when it is someone else's request waiting on you, it usually is not.
  PERMISSION_PROMPT_TIMEOUT_MINUTES: z
    .string()
    .default('10')
    .transform((val) => parseInt(val, 10)),
  // In a group, only act on messages that address the bot — an @mention, a
  // reply to something the bot sent, or a slash command. Off means every
  // message in an allow-listed group is a prompt, which drowns out any human
  // conversation happening in the same group.
  GROUP_REQUIRE_MENTION: z.string().default('true').transform(toBool),
  // Treat any reply to one of the bot's messages as addressing it, the way it
  // worked before mentions were required. Off by default: replying is also how
  // you quote a message, so a reply is a poor signal of intent. Answers to the
  // bot's own ForceReply prompts are always addressed regardless.
  GROUP_REPLY_IS_MENTION: z.string().default('false').transform(toBool),
  // What membership of an allow-listed group grants. 'spectator' makes it
  // presence only — people talk in the group and watch the bot work, but only
  // someone an admin has /allow'd can send it prompts. 'contributor' makes
  // Telegram membership the whole gate, so everyone in the room can drive the
  // agent; that is the right answer for a group of peers and the wrong one for
  // a group with an audience in it.
  //
  // Defaults to spectator, which is the safe direction and matches what the
  // roster gate already enforced before this setting existed: someone who is
  // in the group but not admitted could never prompt the bot.
  GROUP_MEMBERS_DEFAULT: z.enum(['contributor', 'spectator']).default('spectator'),
  ANTHROPIC_API_KEY: z.string().optional(), // Optional - uses Claude Max subscription if not set
  WORKSPACE_DIR: z.string().default(process.env.HOME || '.'),
  // The project this bot is for, set by /newbot for the bots it creates. A
  // conversation with nowhere else to be starts here, and a thread in it is
  // named without the project in front, since the bot's name already says it.
  // Absolute, or relative to WORKSPACE_DIR.
  HOME_PROJECT: z.string().optional(),
  // The `claude` the Haiku side calls (topic names, the charter judge) run
  // through: the copy bundled with the agent SDK, or CLAUDE_EXECUTABLE_PATH
  // when the flag is false. The ptys spawn CLAUDE_BIN, else the one on PATH.
  CLAUDE_EXECUTABLE_PATH: z.string().default('claude'),
  CLAUDE_USE_BUNDLED_EXECUTABLE: z
    .string()
    .default('true')
    .transform((val) => val.toLowerCase() === 'true'),
  // Path to a JSON file of extra MCP servers ({"mcpServers": {...}}) to hand the
  // pty alongside the bot's own. Opt-in and named explicitly: the spawn passes
  // --strict-mcp-config, which is what keeps the tool surface predictable, and
  // the alternative to this is loading every server the user has ever
  // configured — broken ones included. MCP servers live in ~/.claude.json
  // rather than in settings.json, so --setting-sources cannot reach them.
  EXTRA_MCP_CONFIG: z.string().optional(),
  // Marketplace plugins to enable inside the agent, as the `plugin@marketplace`
  // ids `claude plugin list` prints, comma-separated. Neither transport reads
  // ~/.claude/settings.json, which is where `enabledPlugins` normally lives, so
  // this is the only way a plugin you enabled in the terminal reaches a
  // Telegram session. See src/claude/enabled-plugins.ts for why they skip it.
  CLAUDE_PLUGINS: z
    .string()
    .default('')
    .transform((val) =>
      val ? val.split(',').map((name) => name.trim()).filter(Boolean) : []
    ),
  BOT_NAME: z.string().default('TeleCoder'),
  // Fire a parallel Haiku side-call on every user message to derive a topic
  // label for the status line and the thread name, independent of the main
  // agent's tool calls. Deferral-immune because it bypasses settingSources and
  // tools entirely. Skipped when nothing in the chat shows the topic.
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
  // The status line that closes every reply (project, effort, model, context,
  // cost), for chats that haven't used /statusline. On: in Telegram it's the
  // only place those show, and a new user doesn't know the command. The topic
  // line comes with it; the last prompts and the resume command stay opt-in.
  STATUS_LINE_DEFAULT: z
    .string()
    .default('true')
    .transform((val) => val.toLowerCase() === 'true'),
  MAX_MESSAGE_LENGTH: z
    .string()
    .default('4000')
    .transform((val) => parseInt(val, 10)),
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
  AUTO_RESTORE_SESSION: z.string().default('false').transform(toBool),
  // Voice transcription (Groq Whisper)
  GROQ_API_KEY: z.string().optional(),
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
  // Status-line verbose: show full commands/paths without truncation and longer session previews.
  // When set, overrides the verbosity tier.
  TERMINAL_UI_VERBOSE: z
    .string()
    .default('false')
    .transform((val) => val.toLowerCase() === 'true'),
  // Message batching: combine the parts of a long paste Telegram split up into
  // a single prompt. How long to wait for the next part, in ms. 0 = disabled.
  MESSAGE_BATCH_TIMEOUT_MS: z
    .string()
    .default('1500')
    .transform((val) => parseInt(val, 10)),
  // Absolute wall-clock cap for a single PTY turn (ms). The turn is killed
  // with a "turn exceeded" error if it runs longer. Default 2 h — long
  // enough for genuinely intensive multi-step work; raise it if you regularly
  // hit the cap on legitimately long turns.
  CLAUDE_PTY_HARD_TIMEOUT_MS: z
    .string()
    .default('7200000')
    .transform((val) => parseInt(val, 10)),
  // How long an idle PTY session's `claude` process is kept (ms). Each one
  // holds a few hundred MB between turns; past this it is ended, and the next
  // message resumes the conversation from its transcript in a new one. A
  // session with a turn, a background task or a background shell running is
  // never ended. Also what cleans up after a thread deleted by hand, which
  // Telegram doesn't tell the bot about. 0 = keep them until a restart.
  CLAUDE_PTY_IDLE_TIMEOUT_MS: z
    .string()
    .default('3600000')
    .transform((val) => parseInt(val, 10)),
  // `telecoder watch`: serve each PTY chat's live Claude Code screen, read-only,
  // on a Unix socket in ~/.telecoder/watch that only this user can open.
  // false turns it off.
  PTY_WATCH: z
    .string()
    .default('true')
    .transform((val) => val.toLowerCase() === 'true'),
  // Start a chat's `claude` as soon as its conversation is chosen — /project,
  // /clear, /resume — instead of on the first message after, so that message
  // doesn't wait for Claude Code to start. Skipped without a word when memory
  // is under the guard's floor; one nobody ends up using is ended by the idle
  // timeout like any other. false starts it on the first message.
  PREWARM_CLAUDE: z
    .string()
    .default('true')
    .transform((val) => val.toLowerCase() === 'true'),
  // Memory guard. Before a typed message starts a new `claude` for a PTY chat
  // — a new chat or thread, or one whose claude was ended — the machine's
  // available memory (MemAvailable) is checked, less a few hundred MB for
  // every claude still starting up (one just let through hasn't taken its
  // memory yet). Under this many MB, claudes idle longer than
  // MEMORY_GUARD_REAP_IDLE_MS are ended first; if that still leaves too
  // little, the chat is asked whether to start anyway, end the longest-idle
  // claude first, or drop the message. "auto" (the default) is a quarter of
  // the machine's RAM, at least 1024 MB: with 1 GB left on an 8 GB box the
  // machine is usually deep in swap already. 0 turns the guard off.
  MEMORY_GUARD_MIN_AVAILABLE_MB: z
    .string()
    .default('auto')
    .transform((val): number | 'auto' => (val.trim().toLowerCase() === 'auto' ? 'auto' : parseInt(val, 10))),
  // Swap in use above this many MB also counts as tight, so the guard asks
  // even while MemAvailable looks fine. Off by default (0): pages stay in swap
  // long after the pressure that put them there has passed, so on a machine
  // that swaps at all this nags on every new chat.
  MEMORY_GUARD_MAX_SWAP_USED_MB: z
    .string()
    .default('0')
    .transform((val) => parseInt(val, 10)),
  // The shorter idle window the guard reaps with when memory is tight, in ms.
  // A chat whose claude was reaped this way resumes from its transcript on its
  // next message, a few seconds slower. Default 300000 = 5 min.
  MEMORY_GUARD_REAP_IDLE_MS: z
    .string()
    .default('300000')
    .transform((val) => parseInt(val, 10)),
  // How long a question from the agent — telecoder_ask_user buttons, a
  // telecoder_poll_user poll, a Claude Code dialog relayed to the chat —
  // waits for an answer before the turn carries on without one. The turn is
  // paused for the whole wait, so a long timeout is a long stall whenever a
  // question goes unanswered; keep it well under CLAUDE_PTY_HARD_TIMEOUT_MS,
  // which ends the turn regardless. Permission prompts have their own,
  // PERMISSION_PROMPT_TIMEOUT_MINUTES.
  QUESTION_TIMEOUT_MINUTES: z
    .string()
    .default('10')
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
});

/**
 * Print the configuration report and stop. Everything that keeps the bot from
 * starting goes through here, so a first run sees one message in one shape —
 * which file was read, what is wrong, and how to fix it — whichever check
 * caught it. See config-report.ts.
 */
function failConfig(problems: ConfigProblem[]): never {
  console.error(formatConfigReport(
    problems,
    { path: envPath, status: envFileStatus(loadedEnv) },
    { instanceName: process.env.TELECODER_INSTANCE_NAME },
  ));
  exitForConfigError();
}

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  failConfig(problemsFromIssues(parsed.error.issues, process.env));
}

/**
 * ADMIN_USER_IDS narrows who, among the people ALLOWED_USER_IDS lets in, may
 * approve prompts and run lifecycle commands. It does not grant access itself.
 *
 * Reading it as a replacement rather than a subset is the natural mistake — the
 * variable that mentions "admin" looks like the more powerful one — and the
 * failure it produces is misleading: the bot dies on ALLOWED_USER_IDS being
 * empty and never mentions the line you actually filled in. So the check names
 * both, here, at the point of exit.
 */
if (parsed.data.ADMIN_USER_IDS.length > 0) {
  const orphaned = parsed.data.ADMIN_USER_IDS.filter(
    (id) => !parsed.data.ALLOWED_USER_IDS.includes(id)
  );
  if (orphaned.length > 0) {
    failConfig([{
      key: 'ADMIN_USER_IDS',
      message:
        `ADMIN_USER_IDS lists ${orphaned.join(', ')}, which ALLOWED_USER_IDS does not. ` +
        'ADMIN_USER_IDS picks the admins out of ALLOWED_USER_IDS; it does not grant access ' +
        'on its own, so an id in one and not the other can never do anything. ' +
        `Add ${orphaned.length === 1 ? 'it' : 'them'} to ALLOWED_USER_IDS too — the same id in both lines is normal.`,
    }]);
  }
}

/**
 * APPROVER_USER_IDS with no ADMIN_USER_IDS is a no-op: with that unset every
 * allowed user is already an admin, so there is nobody left for this list to
 * promote. Someone who filled it in wanted a split and got none, which is the
 * same silent nothing the ADMIN_USER_IDS check above exists to prevent.
 *
 * The other way of getting it wrong — an approver no allow-list carries —
 * is checked at startup instead, by findOrphanedApprovers(). It has to read the
 * roster that `/allow` writes to, and this file cannot: user-roster.ts imports
 * it. Checking only ALLOWED_USER_IDS here was wrong in precisely the case the
 * tier exists for — a friend admitted from chat is never in that line.
 */
if (parsed.data.APPROVER_USER_IDS.length > 0 && parsed.data.ADMIN_USER_IDS.length === 0) {
  failConfig([{
    key: 'APPROVER_USER_IDS',
    message:
      'APPROVER_USER_IDS is set but ADMIN_USER_IDS is not. With no admin subset configured every ' +
      'allowed user is already an admin and can approve anything, so this list would promote nobody ' +
      'and change nothing. Set ADMIN_USER_IDS to the people who own the bot, and leave the rest here.',
  }]);
}

export const config = { ...parsed.data };

export type Config = typeof config;

// Capture which override env vars were explicitly set (after dotenv has loaded
// process.env). The verbosity resolver consults these to decide whether to
// honor the env value or fall back to the per-tier default; the startup name
// sync only renames the bot when BOT_NAME was asked for.
function isEnvSet(key: string): boolean {
  const raw = process.env[key];
  return raw !== undefined && raw !== '';
}

export const explicitFlags = {
  CONTEXT_SHOW_USAGE: isEnvSet('CONTEXT_SHOW_USAGE'),
  CONTEXT_NOTIFY_COMPACTION: isEnvSet('CONTEXT_NOTIFY_COMPACTION'),
  TERMINAL_UI_VERBOSE: isEnvSet('TERMINAL_UI_VERBOSE'),
  BOT_NAME: isEnvSet('BOT_NAME'),
} as const;

// ---------------------------------------------------------------------------
// Derived helpers (used by index.ts, command.handler.ts, session-history.ts)
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import { getStateDir, ensureStateDir, readJsonFile, writeJsonFile } from './utils/json-store.js';

/** Numeric bot ID extracted from the Telegram token (e.g. "123456" from "123456:ABC..."). */
export const BOT_ID = config.TELEGRAM_BOT_TOKEN.split(':')[0];

const STATE_DIR = getStateDir();

// ---------------------------------------------------------------------------
// The bot's name
// ---------------------------------------------------------------------------

/** Where the bot's name comes from: `/botname`, the `BOT_NAME` setting, or the default. */
export type BotNameSource = 'command' | 'env' | 'default';

const botNameFileSchema = z.object({ name: z.string().min(1).max(64) });
const envBotName = config.BOT_NAME;
let botNameSource: BotNameSource = explicitFlags.BOT_NAME ? 'env' : 'default';

/** The file holding the name set with `/botname`, one per bot. */
export function getBotNameFilePath(): string {
  return path.join(STATE_DIR, `botname-${BOT_ID}.json`);
}

// A name set with /botname wins over BOT_NAME. It's applied here, as the config
// loads, so every module that reads config.BOT_NAME at import time sees it too.
{
  const stored = readJsonFile(getBotNameFilePath(), botNameFileSchema, 'BotName')?.name;
  if (stored) {
    config.BOT_NAME = stored;
    botNameSource = 'command';
  }
}

export function getBotNameSource(): BotNameSource {
  return botNameSource;
}

/**
 * Save the name set with `/botname`, or clear it (`undefined`) so the bot goes
 * back to `BOT_NAME`. Updates `config.BOT_NAME` in place for the running process;
 * the Telegram side is the caller's job. Throws when the file can't be written.
 */
export function setStoredBotName(name: string | undefined): void {
  const file = getBotNameFilePath();
  if (name) {
    ensureStateDir(STATE_DIR, 'BotName');
    writeJsonFile(file, { name }, 'BotName', { rethrow: true });
    config.BOT_NAME = name;
    botNameSource = 'command';
    return;
  }
  fs.rmSync(file, { force: true });
  config.BOT_NAME = envBotName;
  botNameSource = explicitFlags.BOT_NAME ? 'env' : 'default';
}

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
