---
title: Configuration
description: Every .env setting.
sidebar:
  order: 2
---

All config lives in a `.env` file: `~/.telecoder/.env` for an npm install (`telecoder init` writes it; `TELECODER_HOME` and `TELECODER_ENV_PATH` [move it](cli.md#where-the-config-lives)), or the `.env` next to `package.json` in a source checkout. Several bots share it and add their own settings in `instances.json` ([Multiple bots](../guides/multiple-bots.md)). The tables below list every setting; [`.env.example`](https://github.com/telecoderbot/telecoder/blob/main/.env.example) has them as an annotated file to copy from.

## Required

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `ALLOWED_USER_IDS` | Comma-separated numeric Telegram user IDs (not `@usernames`). The bot refuses to start on a non-numeric entry or on the `.env.example` placeholder `123456789`. Someone not on the list who DMs the bot is told their ID, and it is logged |

## Sharing (admins & guests)

Only needed for a bot other people use. Unset, every allowed user is an admin
and nothing below changes anything.

| Variable | Default | Description |
|----------|---------|-------------|
| `ADMIN_USER_IDS` | all allowed users | Who may approve permission prompts and run the lifecycle and backend commands |
| `APPROVER_USER_IDS` | — | Guests who may answer someone else's prompt — never their own — and get no lifecycle commands. Needs `ADMIN_USER_IDS`; the ids must be allowed, from `.env` or `/allow` |
| `ALLOWED_GROUP_IDS` | — | Group/supergroup chat IDs the bot is shared in |
| `RESTRICT_TO_GROUPS` | `false` | Confine guests to those groups; admins can still DM the bot |
| `TELECODER_PERMISSION_PROMPTS` | on when guests exist | `1`/`0` to force the permission gate on or off |
| `PERMISSION_PROMPT_TIMEOUT_MINUTES` | `10` | How long a prompt or held message waits for an admin |
| `SCOPE_GUARD` | `auto` | Prompt on tool calls naming paths outside the shared projects |
| `SCOPE_ALLOWED_PATHS` | — | Extra in-bounds directories, comma-separated |
| `CHARTER_JUDGE` | `auto` | Read each guest message against a charter before it runs |
| `CHARTER_FILE` | `WORKSPACE_DIR/CHARTER.md` | The charter the judge reads |

See [Sharing a bot](../guides/sharing.md) for how the pieces fit together.

## Core

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | — | API key (optional with Claude Max subscription) |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | A long-lived Claude token from `claude setup-token`, for a machine you won't sign in on ([Claude isn't logged in](../help/troubleshooting.md#claude-isnt-logged-in)) |
| `WORKSPACE_DIR` | `$HOME` | Root directory for project picker |
| `HOME_PROJECT` | — | The project this bot is for: new conversations start there, and its threads are named without it. Usually set per bot in `instances.json`, which `/newbot` does. Absolute, or relative to `WORKSPACE_DIR` |
| `CLAUDE_USER_SETUP` | `auto` | Whether Claude starts with your own Claude Code setup, as it does in your terminal: `~/.claude` (`CLAUDE.md`, skills, commands, agents and `settings.json`), your MCP servers, your plugins and your claude.ai connectors. `auto` brings it along unless the bot has guests ([why](../guides/sharing.md#your-own-claude-code-setup)); `on` and `off` force it |
| `CLAUDE_PLUGINS` | — | Marketplace plugins to enable for the bot, as `plugin@marketplace` ids, comma-separated. A plugin enabled in your terminal comes with your setup; this is for a bot where that stays out, or for a plugin only the bot should have |
| `EXTRA_MCP_CONFIG` | — | Path to a JSON file of MCP servers (`{"mcpServers": {...}}`, the shape of `~/.claude.json`) to add beside the bot's own. Your own servers come with your setup; this is for a bot where that stays out, or for a server only the bot should have |
| `CLAUDE_BIN` | the `claude` on PATH | The `claude` your chats run. Set it when the CLI lives where the service can't see it |
| `CLAUDE_USE_BUNDLED_EXECUTABLE` | `true` | Run the quick Haiku side calls (topic names, the charter judge) with the `claude` that comes with the Agent SDK. `false` runs them with `CLAUDE_EXECUTABLE_PATH` |
| `CLAUDE_EXECUTABLE_PATH` | `claude` | The `claude` for those side calls when `CLAUDE_USE_BUNDLED_EXECUTABLE` is `false` |
| `BOT_NAME` | `TeleCoder` | The bot's name: what it's called in the system prompt and its messages, and the display name it sets in Telegram at startup when the setting is given. Unset, the BotFather name is kept. A name given with `/botname` wins over this |
| `MESSAGE_BATCH_TIMEOUT_MS` | `1500` | How long to wait for the next part of a long paste that Telegram split (2000+ characters) before sending the parts as one prompt; `0` turns it off |
| `AUTO_TOPIC_HAIKU` | `true` | Name each conversation's topic with a quick Haiku call, for thread names and the status line. Off, the agent is asked to keep the topic itself with `telecoder_set_topic` |
| `CLAUDE_PTY_HARD_TIMEOUT_MS` | `7200000` | The longest one turn may run (2 h). A turn still running after that is ended with a "turn exceeded" error. Raise it if long turns of yours reach the cap |
| `CLAUDE_PTY_IDLE_TIMEOUT_MS` | `3600000` | How long an idle PTY session keeps its `claude` process (a few hundred MB) before it's ended; the next message resumes the conversation in a new one. Never while a turn, background task or background shell is running. `0` keeps them until a restart |
| `PTY_WATCH` | `true` | Serve each chat's live Claude Code screen, read-only, for [`telecoder watch`](cli.md#telecoder-watch). The socket is in `~/.telecoder/watch` and only your user can open it. `false` turns it off |
| `PREWARM_CLAUDE` | `true` | Start a chat's `claude` as soon as its conversation is chosen (`/project`, `/clear`, `/resume`), so the first message doesn't wait for Claude Code to start. Skipped silently when available memory is under the memory guard's floor: nothing is ended for it and nobody is asked. One nobody uses is ended by `CLAUDE_PTY_IDLE_TIMEOUT_MS` like any idle one. `false` starts it on the first message |
| `MEMORY_GUARD_MIN_AVAILABLE_MB` | `auto` | Before a message starts a new `claude` for a chat, the machine's available memory is checked, less a few hundred MB for every claude let through in the last half minute (one just started hasn't taken its memory yet, so two threads started together can't both slip past). Under this many MB, claudes idle longer than `MEMORY_GUARD_REAP_IDLE_MS` are ended first; if that still leaves too little, the chat is asked whether to start anyway, end the longest-idle claude first, check again, wait for room, or drop the message. Waiting checks every 30 s, reaping each time, and starts Claude the moment it fits; when the question's timeout runs out it asks again rather than dropping. `auto` is a quarter of the machine's RAM, at least 1024 MB. `0` turns the guard off |
| `MEMORY_GUARD_MAX_SWAP_USED_MB` | `0` | Swap in use above this many MB also counts as tight, so the guard asks even while available memory looks fine. Off at `0`: swap stays occupied long after the pressure that filled it has passed, so on a machine that swaps at all this asks on every new chat |
| `MEMORY_GUARD_REAP_IDLE_MS` | `300000` | The shorter idle window the memory guard reaps with when memory is tight (5 min). A chat reaped this way resumes from its transcript on its next message |
| `QUESTION_TIMEOUT_MINUTES` | `10` | How long a question from Claude (buttons, polls, relayed dialogs) waits before the turn carries on without an answer and the question closes |
| `AUTO_RESTORE_SESSION` | `false` | After `/restartbot` or `/rebuildbot`, post a "Reloaded and session restored" recap (project, topic, last prompt and last reply) in each chat used in the last hour, in place of the Continue and Resume buttons. Chats carry on in their conversation after a restart either way |
| `TELEGRAM_PROXY_URL` | — | An HTTP or HTTPS proxy for the bot's requests to Telegram, such as `http://127.0.0.1:8080`, for a network where Telegram is blocked. SOCKS proxies aren't supported. Unset, `HTTPS_PROXY` or `HTTP_PROXY` is used when the environment has one. Files you send the bot are fetched through it too, and `telecoder init` and `telecoder doctor --live` reach Telegram through it |
| `TELECODER_ALLOW_NATIVE_SCHEDULING` | — | `1` leaves Claude Code's own scheduling tools (`CronCreate`, `ScheduleWakeup`, `RemoteTrigger`) enabled. They're blocked by default because what they schedule fires outside the chat and never reaches Telegram; `/schedule` and the bot's own tools take their place |
| `TELECODER_IPC_PORT` | a free port | The port on `127.0.0.1` where the bot listens for Claude Code's hooks and its own MCP tools. Leave it unset unless something has to know the port; several bots in one launcher can't share one |

## Replies and notifications

| Variable | Default | Description |
|----------|---------|-------------|
| `VERBOSITY_DEFAULT` | `normal` | The `/verbosity` tier for chats that haven't picked one: `quiet`, `normal`, `verbose` or `debug` |
| `FULL_TOOL_INPUTS` | — | Show a tool's full input in the live status message (the whole Bash command, the full path or URL) instead of a shortened one, whatever the `/verbosity` tier; unset, the tier decides, and turns it on from verbose up. Was `TERMINAL_UI_VERBOSE`, which still works |
| `CONTEXT_SHOW_USAGE` | — | Show the context-use line after each turn (a bar, the percentage, tokens used and turns), whatever the `/verbosity` tier; unset, the tier decides, and shows it from verbose up. It closes the status line when that's on |
| `CONTEXT_NOTIFY_COMPACTION` | — | Say so in the chat when Claude Code compacts the conversation by itself. Unset, the tier decides, and every tier says so; `false` turns the notice off |
| `STATUS_LINE_DEFAULT` | `true` | The status line that closes every reply, with its topic line, for chats that haven't used `/statusline`. Its last-prompts and `claude --resume` lines stay opt-in |
| `PROMPT_SUGGESTIONS_DEFAULT` | `false` | Predicted next-prompt buttons for chats that haven't used `/suggestions` |
| `NOTIFICATION_ENABLED` | `true` | After a turn that took at least `NOTIFICATION_THRESHOLD_SECONDS`, send a short `✅ Done (1m 12s)` message, so that Telegram notifies you. The quiet `/verbosity` tier leaves it out |
| `NOTIFICATION_THRESHOLD_SECONDS` | `60` | How long a turn has to take to get the Done message. A background task that ran at least this long also notifies when it ends; a shorter one is noted silently, unless it failed |
| `MAX_MESSAGE_LENGTH` | `4000` | The longest one message of a reply may be, in characters. A longer reply is split into several. Telegram's own limit is 4096 |

## Group chats

| Variable | Default | Description |
|----------|---------|-------------|
| `ALLOWED_GROUP_IDS` | — | Group/supergroup IDs the bot may be used in |
| `GROUP_MEMBERS_DEFAULT` | `spectator` | What membership alone grants: `spectator` or `contributor` |
| `GROUP_REQUIRE_MENTION` | `true` | Only treat messages that address the bot as prompts |
| `GROUP_REPLY_IS_MENTION` | `false` | Treat any reply to the bot as addressing it |

How these three fit together: [Group roles](../guides/sharing.md#group-roles).

## Providers

| Variable | Default | Description |
|----------|---------|-------------|
| `CCR_ENABLED` | `false` | Enable CCR and `/ccr`, the switch to it |
| `CCR_BASE_URL` | `http://localhost:3456` | Where CCR's local proxy listens |
| `CCR_AUTH_TOKEN` | — | CCR's local auth token |
| `CCR_AUTOSTART` | `false` | Run `ccr start` when the proxy isn't reachable |
| `CCR_BINARY` | `ccr` | Path or name of the `ccr` binary for autostart |

## Uploads

| Variable | Default | Description |
|----------|---------|-------------|
| `IMAGE_MAX_FILE_SIZE_MB` | `20` | Largest photo or image file the bot accepts |
| `DOCUMENT_MAX_FILE_SIZE_MB` | `19` | Largest file of any other kind the bot accepts. Telegram won't let a bot download a file over 20 MB, so raising either limit past that doesn't help |

## Voice notes

| Variable | Default | Description |
|----------|---------|-------------|
| `GROQ_API_KEY` | — | Groq API key, for transcribing voice notes (Whisper) |
| `VOICE_SHOW_TRANSCRIPT` | `true` | Show transcript text before agent response |
| `VOICE_LANGUAGE` | `en` | The language voice notes are transcribed in |
| `VOICE_MAX_FILE_SIZE_MB` | `19` | Largest voice note to transcribe |
| `VOICE_TIMEOUT_MS` | `60000` | How long a transcription may take before the bot gives up on it |
| `TRANSCRIBE_ENABLED` | `true` | `false` turns voice notes off |

## Setting up voice

<details>
<summary><strong>Transcription: Groq Whisper</strong></summary>

```bash
# .env
GROQ_API_KEY=your_groq_key
```

</details>
