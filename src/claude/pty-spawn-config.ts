/**
 * Spawn-time configuration for the `claude` pty.
 *
 * Everything here answers "how is the subprocess configured" rather than
 * "how do we drive it": the --settings hook JSON that wires Claude Code's
 * hooks back to our loopback IPC server, the MCP server config and its
 * environment, and the --append-system-prompt note listing the MCP tools.
 *
 * Pure functions over their arguments — no pty or session state — so they can
 * be read and changed without following the terminal-driving logic.
 *
 * The tool list below must track what src/bin/mcp-server.ts actually
 * registers; it is prose describing that registry, not derived from it.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';
import { DENY_MARKER_START, DENY_MARKER_END } from './permission-gate.js';
import { enabledPluginsSetting } from './enabled-plugins.js';

const PROVIDER_DIR = path.dirname(fileURLToPath(import.meta.url));
export const MCP_SERVER_JS = path.resolve(PROVIDER_DIR, '../bin/mcp-server.js');

/**
 * Build the `--settings` JSON we inject at spawn time. Each registered hook
 * runs a `curl` POST to our loopback IPC server; the hook command is wrapped
 * so it always exits 0 (so a transient IPC failure never blocks claude).
 *
 * Stop / SubagentStop are intentionally NOT registered here — Phase 2 will
 * use them as the end-of-turn signal. UserPromptSubmit is similarly deferred.
 *
 * CLAUDE_PLUGINS rides along in the same payload. The flag tier this lands in
 * outranks project and local settings and merges with them, so naming a plugin
 * here adds it to whatever the project already enables — see enabled-plugins.ts
 * for why the user's own settings.json cannot carry it instead.
 */
export function buildSettingsJson(ipcPort: number): string {
  const hookCommand = (eventName: string) =>
    `curl -s -X POST -H 'Content-Type: application/json' --data-binary @- 'http://127.0.0.1:${ipcPort}/hook/${eventName}' >/dev/null 2>&1; exit 0`;

  // PreToolUse needs a richer wrapper so it can BLOCK tool execution when
  // the IPC handler decides to deny. The marker protocol: if the IPC response
  // body contains DENY_MARKER_START + <reason> + DENY_MARKER_END, exit 2
  // (claude code's signal for "block this tool, feed the stderr back to the
  // model") with the reason on stderr. Otherwise exit 0 and let the tool
  // proceed.
  //
  // The markers are interpolated from permission-gate.ts rather than spelled
  // out here: this hook is the reader and evaluateToolCall() is the writer, so
  // a literal copy that drifts would make the `case` stop matching and the
  // gate would fail OPEN — denied tools would silently run.
  //
  // We use shell parameter expansion instead of jq so no extra binary is
  // required. The markers are intentionally distinctive so they can't collide
  // with normal JSON content.
  const preToolUseCommand =
    `RESP=$(curl -s --max-time 900 -X POST -H 'Content-Type: application/json' --data-binary @- 'http://127.0.0.1:${ipcPort}/hook/preToolUse' 2>/dev/null); ` +
    `case "$RESP" in *${DENY_MARKER_START}*) ` +
    `REASON=\${RESP##*${DENY_MARKER_START}}; REASON=\${REASON%%${DENY_MARKER_END}*}; ` +
    `printf '%s' "$REASON" >&2; exit 2 ;; esac; exit 0`;

  const enabledPlugins = enabledPluginsSetting();

  return JSON.stringify({
    ...(enabledPlugins ? { enabledPlugins } : {}),
    hooks: {
      PreToolUse: [{ hooks: [{ type: 'command', command: preToolUseCommand }] }],
      PostToolUse: [{ hooks: [{ type: 'command', command: hookCommand('postToolUse') }] }],
      PostToolUseFailure: [{ hooks: [{ type: 'command', command: hookCommand('postToolUseFailure') }] }],
      Stop: [{ hooks: [{ type: 'command', command: hookCommand('stop') }] }],
    },
  });
}

/**
 * Build the system-prompt suffix that tells claude about our MCP tools.
 * Without this, the MCP tools show up only as deferred-tool names (claude
 * sees `mcp__claudegram-tools__claudegram_fetch_reddit` but doesn't have
 * its description, so it'll often fall back to WebFetch/Bash for the same
 * task). Mentioning each tool with a description and a "prefer over X"
 * hint makes claude pick the right tool.
 *
 * Driven by the same TELECODER_*_ENABLED env flags that gate tool
 * registration in src/bin/mcp-server.ts.
 */
export function buildMcpToolsSystemPromptNote(): string {
  const tools: string[] = [
    '- mcp__claudegram-tools__claudegram_list_projects — list available workspace projects the user can switch to',
    '- mcp__claudegram-tools__claudegram_switch_project — switch the working directory to a different project (call list_projects first). The change takes effect on the next user query.',
    '- mcp__claudegram-tools__claudegram_send_file — send a file from the bot\'s filesystem (within the workspace or /tmp) to the user via Telegram. Use after creating files (reports, SVGs, images, etc.) to deliver them directly. Max 50MB.',
    '- mcp__claudegram-tools__claudegram_ask_user — ask the user a multiple-choice question via a Telegram inline keyboard (2-8 options). Pauses until the user taps a button. Prefer this over the built-in AskUserQuestion whenever you need a decision from the user — AskUserQuestion is for terminal users and does not render correctly through TeleCoder.',
    '- mcp__claudegram-tools__claudegram_poll_user — like ask_user but uses a Telegram poll. Pick this when multiple chat members should vote, when you want visible vote counts, or when you need multi-select. 2-10 options, non-anonymous, resolves on the first vote.',
    '- mcp__claudegram-tools__claudegram_loop — schedule a prompt to re-fire on a fixed interval (min 60s). Use for periodic polling / "every N minutes do X" tasks. Prefer this over the built-in CronCreate or ScheduleWakeup — those don\'t reach back into Telegram. The user sees each fire as a "🔔 Scheduled" message.',
    '- mcp__claudegram-tools__claudegram_schedule — schedule a prompt on a 5-field cron expression (e.g. "0 9 * * *" for daily 9am). Use for time-of-day tasks (morning summary, end-of-day report). Same Telegram-visible behavior as claudegram_loop.',
    '- mcp__claudegram-tools__claudegram_list_schedules — list active schedules in this chat (id, cadence, runs, prompt preview). Call before creating a new schedule to check for duplicates, or to find an id to cancel.',
    '- mcp__claudegram-tools__claudegram_cancel_schedule — remove a scheduled task by id.',
  ];
  // Async built-ins (Monitor, backgrounded Bash, Task subagent) aren't
  // claudegram_* tools, but PTY mode wires up a relay so task-notifications
  // that arrive after the user-turn ends still reach Telegram. Mention it so
  // the model confidently uses these tools when they're the right fit.
  tools.push('- Async built-ins (Monitor, `Bash(run_in_background=true)`, `Task`/`Agent`) — supported in TeleCoder PTY mode. Task-notifications that fire between user turns are relayed to Telegram with a "📡 Monitor — ...", "⚙️ Backgrounded: ...", or "🤖 Subagent started: ..." header, paired with the actual event payload and your response. Use these freely for "watch X", "run X in background while continuing", or "delegate Y to a subagent" tasks.');
  tools.push('- PushNotification (built-in) — supported in TeleCoder PTY mode. The message text is relayed to Telegram as "🔔 <message>". Use the normal rules: only when the user might have walked away and there\'s something they\'d act on now.');
  tools.push('- For scheduled/recurring tasks, prefer claudegram_loop / claudegram_schedule over the built-in CronCreate / ScheduleWakeup / RemoteTrigger — those don\'t reach back into Telegram.');
  tools.push('- *Destructive-op safety:* before running anything irreversible — `rm -rf` on real paths, `sudo`, `git push --force` on shared branches, `DROP TABLE` / `TRUNCATE` against real DBs, `terraform destroy`, mass file rewrites — call `claudegram_ask_user` with a one-line summary of what you\'re about to do and "Confirm" / "Cancel" options. This bot runs unsupervised in Telegram and the user can\'t intervene mid-tool. When in doubt, ask.');
  if (config.REDDIT_ENABLED) {
    tools.push('- mcp__claudegram-tools__claudegram_fetch_reddit — fetch reddit content (subreddits, threads, user profiles). Use this for any reddit.com/r/<subreddit> or post URL; prefer over WebFetch.');
  }
  if (config.MEDIUM_ENABLED) {
    tools.push('- mcp__claudegram-tools__claudegram_fetch_medium — fetch a Medium article (bypasses paywall). Use for medium.com / towardsdatascience.com / etc. URLs; prefer over WebFetch.');
  }
  if (config.EXTRACT_ENABLED) {
    tools.push('- mcp__claudegram-tools__claudegram_extract_media — extract text/audio/video from YouTube/Instagram/TikTok URLs. Audio/video files are sent directly to the user; transcripts are returned as text. Use for any youtube.com/youtu.be/instagram.com/tiktok.com URL.');
  }
  if (config.TELEGRAPH_ENABLED) {
    tools.push('- mcp__claudegram-tools__claudegram_publish_telegraph — publish a markdown document as a Telegraph (telegra.ph) Instant View page; returns the URL.');
  }
  if (config.DYNAMIC_BOT_NAME) {
    tools.push('- mcp__claudegram-tools__claudegram_set_topic — update the conversation topic shown in the bot display name. Call proactively when the topic of work shifts. Empty string clears it. Keep topics 1-4 words.');
  }
  return [
    'You have access to TeleCoder-specific MCP tools listed below. They are loaded lazily — call them directly when relevant; do not try to reproduce their behavior with WebFetch/Bash.',
    ...tools,
  ].join('\n');
}

/**
 * Build the env we hand to the spawned MCP subprocess via --mcp-config.
 * MCP server env is the controlled subset listed here — anything not present
 * won't be visible to the subprocess. We pass:
 *   - required routing info (TELECODER_IPC_PORT, _CLAUDE_SESSION_ID,
 *     _WORKSPACE_ROOT)
 *   - PATH/HOME/NODE_ENV so node can find binaries and home-relative files
 *   - every TELECODER_*-prefixed var from this process's env (feature flags
 *     like TELECODER_REDDIT_ENABLED gate which tools register)
 */
/** True if claude's status line reports that it isn't persisting the session. */

export function buildMcpEnv(required: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH || '',
    HOME: process.env.HOME || '',
    NODE_ENV: process.env.NODE_ENV || '',
    // Translate the bot's parsed config flags into the TELECODER_*_ENABLED
    // form the MCP subprocess gates on. The bot's own env vars are unprefixed
    // (REDDIT_ENABLED, MEDIUM_ENABLED, …) so we can't just pass through.
    TELECODER_REDDIT_ENABLED: config.REDDIT_ENABLED ? 'true' : 'false',
    TELECODER_MEDIUM_ENABLED: config.MEDIUM_ENABLED ? 'true' : 'false',
    TELECODER_TELEGRAPH_ENABLED: config.TELEGRAPH_ENABLED ? 'true' : 'false',
    TELECODER_EXTRACT_ENABLED: config.EXTRACT_ENABLED ? 'true' : 'false',
    TELECODER_DYNAMIC_BOT_NAME: config.DYNAMIC_BOT_NAME ? 'true' : 'false',
    TELECODER_REDDITFETCH_DEFAULT_LIMIT: String(config.REDDITFETCH_DEFAULT_LIMIT),
    TELECODER_REDDITFETCH_DEFAULT_DEPTH: String(config.REDDITFETCH_DEFAULT_DEPTH),
    // Reddit credentials — the redditfetch module reads these from its own
    // process.env, so they need to be present in the subprocess env or
    // OAuth will fail with "Missing Reddit credentials".
    REDDIT_CLIENT_ID: process.env.REDDIT_CLIENT_ID || '',
    REDDIT_CLIENT_SECRET: process.env.REDDIT_CLIENT_SECRET || '',
    REDDIT_USERNAME: process.env.REDDIT_USERNAME || '',
    REDDIT_PASSWORD: process.env.REDDIT_PASSWORD || '',
    ...required,
  };
  // Any extra TELECODER_*-prefixed vars the bot's env carries (e.g. user
  // overrides not codified in config.ts) get passed through too. Pre-rename
  // CLAUDEGRAM_* overrides are translated to the new name rather than forwarded
  // verbatim — the subprocess only reads TELECODER_*, so passing the old key
  // through unchanged would silently drop the override. New name wins when both
  // are set, which is why this runs as two passes instead of one.
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('TELECODER_') && typeof v === 'string' && env[k] === undefined) {
      env[k] = v;
    }
  }
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('CLAUDEGRAM_') || typeof v !== 'string') continue;
    const renamed = `TELECODER_${k.slice('CLAUDEGRAM_'.length)}`;
    if (env[renamed] === undefined) env[renamed] = v;
  }
  return env;
}

/**
 * Extra MCP servers to spawn beside our own, from the file EXTRA_MCP_CONFIG
 * names. `{}` when the var is unset, which is the default.
 *
 * A file rather than the user's own MCP config, because the spawn passes
 * `--strict-mcp-config`: that flag is what stops every server in
 * ~/.claude.json — auth-expired ones, failing ones, and their combined tool
 * counts — from landing in the bot's context. Naming a file keeps that
 * property and adds only what was asked for.
 *
 * Never throws. This runs on the path that starts the agent, and a typo in an
 * optional file must not be the reason the bot does not come up; a warning on
 * stderr and no extra servers is the failure that leaves everything else
 * working. Same reasoning as the missing-token read in the pm2 config.
 */
function readExtraMcpServers(): Record<string, unknown> {
  const file = config.EXTRA_MCP_CONFIG;
  if (!file) return {};

  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
      console.warn(`[mcp] ${file} has no "mcpServers" object; no extra servers loaded`);
      return {};
    }
    return servers as Record<string, unknown>;
  } catch (err) {
    console.warn(`[mcp] could not read EXTRA_MCP_CONFIG ${file}:`, err);
    return {};
  }
}

/**
 * Build the `--mcp-config` JSON we inject at spawn time. claude will spawn the
 * referenced node script as a stdio MCP subprocess. The env we pass through is
 * what the subprocess uses to reach back to our loopback IPC server.
 *
 * Ours is written last on purpose: an extra config that happens to define
 * `claudegram-tools` cannot shadow the tools this bot needs to talk to Telegram
 * at all, which is the one server whose absence has no visible failure mode —
 * it just stops answering.
 */
export function buildMcpConfigJson(env: Record<string, string>): string {
  return JSON.stringify({
    mcpServers: {
      ...readExtraMcpServers(),
      'claudegram-tools': {
        command: 'node',
        args: [MCP_SERVER_JS],
        env,
      },
    },
  });
}
