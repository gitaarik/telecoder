---
title: Configuration
description: Every .env setting.
sidebar:
  order: 2
---

All config lives in a `.env` file: `~/.telecoder/.env` for an npm install (`telecoder init` writes it, and `TELECODER_HOME` moves it), or the `.env` next to `package.json` in a source checkout. Several bots share it and add their own settings in `instances.json` ([Multiple bots](../guides/multiple-bots.md)). [`.env.example`](https://github.com/gitaarik/telecoder/blob/main/.env.example) is the full annotated reference; the tables below cover the settings most people change.

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
| `WORKSPACE_DIR` | `$HOME` | Root directory for project picker |
| `HOME_PROJECT` | — | The project this bot is for: new conversations start there, and its threads are named without it. Usually set per bot in `instances.json`, which `/newbot` does. Absolute, or relative to `WORKSPACE_DIR` |
| `CLAUDE_PLUGINS` | — | Marketplace plugins to bring into the agent, as `plugin@marketplace` ids, comma-separated. The pty doesn't read `~/.claude/settings.json`, so a plugin enabled in your terminal is missing in Telegram until it's named here |
| `CLAUDE_EXECUTABLE_PATH` | `claude` | The `claude` the Haiku side calls run when `CLAUDE_USE_BUNDLED_EXECUTABLE=false`. Chats run `CLAUDE_BIN`, else the `claude` on PATH |
| `BOT_NAME` | `TeleCoder` | The bot's name: what it's called in the system prompt and its messages, and the display name it sets in Telegram at startup when the setting is given. Unset, the BotFather name is kept. A name given with `/botname` wins over this |
| `MESSAGE_BATCH_TIMEOUT_MS` | `1500` | How long to wait for the next part of a long paste that Telegram split (2000+ characters) before sending the parts as one prompt; `0` turns it off |
| `AUTO_TOPIC_HAIKU` | `true` | Name each conversation's topic with a quick Haiku call, for thread names and the status line. Off, the agent is asked to keep the topic itself with `telecoder_set_topic` |
| `CLAUDE_PTY_IDLE_TIMEOUT_MS` | `3600000` | How long an idle PTY session keeps its `claude` process (a few hundred MB) before it's ended; the next message resumes the conversation in a new one. Never while a turn, background task or background shell is running. `0` keeps them until a restart |
| `PTY_WATCH` | `true` | Serve each PTY chat's live Claude Code screen, read-only, for [`telecoder watch`](cli.md#telecoder-watch). The socket is in `~/.telecoder/watch` and only your user can open it. `false` turns it off |
| `PREWARM_CLAUDE` | `true` | Start a chat's `claude` as soon as its conversation is chosen (`/project`, `/clear`, `/resume`), so the first message doesn't wait for Claude Code to start. Skipped silently when available memory is under the memory guard's floor: nothing is ended for it and nobody is asked. One nobody uses is ended by `CLAUDE_PTY_IDLE_TIMEOUT_MS` like any idle one. `false` starts it on the first message |
| `MEMORY_GUARD_MIN_AVAILABLE_MB` | `auto` | Before a message starts a new `claude` for a PTY chat, the machine's available memory is checked, less a few hundred MB for every claude let through in the last half minute (one just started hasn't taken its memory yet, so two threads started together can't both slip past). Under this many MB, claudes idle longer than `MEMORY_GUARD_REAP_IDLE_MS` are ended first; if that still leaves too little, the chat is asked whether to start anyway, end the longest-idle claude first, check again, wait for room, or drop the message. Waiting checks every 30 s, reaping each time, and starts Claude the moment it fits; when the question's timeout runs out it asks again rather than dropping. `auto` is a quarter of the machine's RAM, at least 1024 MB. `0` turns the guard off |
| `MEMORY_GUARD_MAX_SWAP_USED_MB` | `0` | Swap in use above this many MB also counts as tight, so the guard asks even while available memory looks fine. Off at `0`: swap stays occupied long after the pressure that filled it has passed, so on a machine that swaps at all this asks on every new chat |
| `MEMORY_GUARD_REAP_IDLE_MS` | `300000` | The shorter idle window the memory guard reaps with when memory is tight (5 min). A chat reaped this way resumes from its transcript on its next message |
| `PROMPT_SUGGESTIONS_DEFAULT` | `false` | Predicted next-prompt buttons for chats that haven't used `/suggestions` |
| `STATUS_LINE_DEFAULT` | `true` | The status line that closes every reply, with its topic line, for chats that haven't used `/statusline`. Its last-prompts and `claude --resume` lines stay opt-in |
| `QUESTION_TIMEOUT_MINUTES` | `10` | How long a question from Claude (buttons, polls, relayed dialogs) waits before the turn carries on without an answer and the question closes |

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
| `CCR_ENABLED` | `false` | Enable `/ccr` and CCR in `/provider` |
| `CCR_BASE_URL` | `http://localhost:3456` | Where CCR's local proxy listens |
| `CCR_AUTH_TOKEN` | — | CCR's local auth token |
| `CCR_AUTOSTART` | `false` | Run `ccr start` when the proxy isn't reachable |
| `CCR_BINARY` | `ccr` | Path or name of the `ccr` binary for autostart |

## Voice notes

| Variable | Default | Description |
|----------|---------|-------------|
| `GROQ_API_KEY` | — | Groq API key, for transcribing voice notes (Whisper) |
| `VOICE_SHOW_TRANSCRIPT` | `true` | Show transcript text before agent response |
| `VOICE_LANGUAGE` | `en` | The language voice notes are transcribed in |
| `VOICE_MAX_FILE_SIZE_MB` | `19` | Largest voice note to transcribe |
| `TRANSCRIBE_ENABLED` | `true` | `false` turns voice notes off |

## Setting up voice

<details>
<summary><strong>Transcription: Groq Whisper</strong></summary>

```bash
# .env
GROQ_API_KEY=your_groq_key
```

</details>
