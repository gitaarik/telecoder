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
| `ADMIN_USER_IDS` | all allowed users | Who may approve permission prompts and run lifecycle/transport commands |
| `APPROVER_USER_IDS` | — | Guests who may answer someone else's prompt — never their own — and get no lifecycle commands. Needs `ADMIN_USER_IDS`; the ids must be allowed, from `.env` or `/allow` |
| `ALLOWED_GROUP_IDS` | — | Group/supergroup chat IDs the bot is shared in |
| `RESTRICT_TO_GROUPS` | `false` | Confine guests to those groups; admins can still DM the bot |
| `TELECODER_PERMISSION_PROMPTS` | on when guests exist | `1`/`0` to force the permission gate on or off |
| `PERMISSION_PROMPT_TIMEOUT_MINUTES` | `10` | How long a prompt or held message waits for an admin |
| `SCOPE_GUARD` | `auto` | Prompt on tool calls naming paths outside the shared projects |
| `SCOPE_ALLOWED_PATHS` | — | Extra in-bounds directories, comma-separated |
| `CHARTER_JUDGE` | `auto` | Read each guest message against a charter before it runs |
| `CHARTER_FILE` | `WORKSPACE_DIR/CHARTER.md` | The charter the judge reads |
| `CLAUDE_METHOD_DEFAULT` | `sdk` | Transport for chats that haven't run `/method`; the gate runs on both |

See [Sharing a bot](../guides/sharing.md) for how the pieces fit together.

## Core

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | — | API key (optional with Claude Max subscription) |
| `WORKSPACE_DIR` | `$HOME` | Root directory for project picker |
| `HOME_PROJECT` | — | The project this bot is for: new conversations start there, and its threads are named without it. Usually set per bot in `instances.json`, which `/newbot` does. Absolute, or relative to `WORKSPACE_DIR` |
| `CLAUDE_PLUGINS` | — | Marketplace plugins to bring into the agent, as `plugin@marketplace` ids, comma-separated. Neither transport reads `~/.claude/settings.json`, so a plugin enabled in your terminal is missing in Telegram until it's named here |
| `CLAUDE_EXECUTABLE_PATH` | `claude` | Path to Claude Code CLI |
| `BOT_NAME` | `TeleCoder` | Bot name in system prompt |
| `STREAMING_MODE` | `streaming` | `streaming` or `wait` |
| `TELEGRAPH_ENABLED` | `false` | Opt-in. Also publish long replies, `/handoff` notes and the full action log to telegra.ph as Instant View pages. **Pages are public** to anyone with the link and can't be deleted. Off, long replies arrive as chunked messages and `/handoff` as a file |
| `DANGEROUS_MODE` | `false` | Auto-approve all tool permissions |
| `CANCEL_ON_NEW_MESSAGE` | `false` | Auto-cancel running query on new message |
| `MESSAGE_BATCH_TIMEOUT_MS` | `1500` | How long to wait for the next part of a long paste that Telegram split (2000+ characters) before sending the parts as one prompt; `0` turns it off |
| `AUTO_TOPIC_HAIKU` | `true` | Name each conversation's topic with a quick Haiku call, for thread names, the bot name and the status line |
| `CLAUDE_PTY_IDLE_TIMEOUT_MS` | `3600000` | How long an idle PTY session keeps its `claude` process (a few hundred MB) before it's ended; the next message resumes the conversation in a new one. Never while a turn, background task or background shell is running. `0` keeps them until a restart |
| `PROMPT_SUGGESTIONS_DEFAULT` | `false` | Predicted next-prompt buttons for chats that haven't used `/suggestions` (PTY mode) |
| `STATUS_LINE_DEFAULT` | `true` | The status line that closes every reply, with its topic line, for chats that haven't used `/statusline`. Its last-prompts and `claude --resume` lines stay opt-in |
| `QUESTION_TIMEOUT_MINUTES` | `10` | How long a question from Claude (buttons, polls, relayed dialogs) waits before the turn carries on without an answer and the question closes |
| `CLAUDE_SDK_LOG_LEVEL` | `basic` | SDK log level: off, basic, verbose, trace |

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
| `CCR_AUTO_PROMPT_ON_THROTTLE` | `true` | Offer a one-tap CCR retry on Max throttle |
| `CCR_AUTOSTART` | `false` | Run `ccr start` when the proxy isn't reachable |
| `CCR_BINARY` | `ccr` | Path or name of the `ccr` binary for autostart |

## Voice and TTS

| Variable | Default | Description |
|----------|---------|-------------|
| `GROQ_API_KEY` | — | Groq API key, for Whisper transcription and Orpheus TTS |
| `OPENAI_API_KEY` | — | OpenAI API key for TTS |
| `TTS_ENABLED` | `true` | `false` turns spoken replies off for every chat, and hides `/tts` |
| `TTS_PROVIDER` | `groq` | `groq` (Orpheus) or `openai` |
| `TTS_VOICE` | `coral` | Default TTS voice. On Groq, a voice Groq doesn't have falls back to `troy` |
| `TTS_MODEL` | `gpt-4o-mini-tts` | TTS model (OpenAI; Groq's is fixed) |
| `TTS_SPEED` | `1.0` | Speaking speed, 0.25 to 4.0 (OpenAI) |
| `TTS_INSTRUCTIONS` | — | How to speak, for `gpt-4o-mini-tts` models (OpenAI) |
| `TTS_MAX_CHARS` | `4096` | Longer replies are cut at a sentence end before they're spoken |
| `VOICE_SHOW_TRANSCRIPT` | `true` | Show transcript text before agent response |
| `VOICE_LANGUAGE` | `en` | The language voice notes are transcribed in |
| `VOICE_MAX_FILE_SIZE_MB` | `19` | Largest voice note to transcribe |
| `TRANSCRIBE_ENABLED` | `true` | `false` turns off voice-note transcription and `/transcribe` |
| `TRANSCRIBE_FILE_THRESHOLD_CHARS` | `4000` | `/transcribe` sends longer transcripts as a file |

## Setting up voice

<details>
<summary><strong>Voice Transcription — Groq Whisper</strong></summary>

```bash
# .env
GROQ_API_KEY=your_groq_key
```

</details>

<details>
<summary><strong>Text-to-Speech — Groq Orpheus or OpenAI</strong></summary>

Groq is the default and uses `GROQ_API_KEY`. To use OpenAI instead:

```bash
# .env
TTS_PROVIDER=openai
OPENAI_API_KEY=your_openai_key
TTS_MODEL=gpt-4o-mini-tts
TTS_VOICE=coral
TTS_RESPONSE_FORMAT=opus
```

13 OpenAI voices available: `alloy`, `ash`, `ballad`, `cedar`, `coral`, `echo`, `fable`, `marin`, `nova`, `onyx`, `sage`, `shimmer`, `verse`

</details>
