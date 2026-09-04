<div align="center">

# TeleCoder

**Claude Code from Telegram.** Your agent runs on your machine — you drive it from your phone.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Claude](https://img.shields.io/badge/Claude_Agent_SDK-Anthropic-cc785c?logo=anthropic&logoColor=white)](https://docs.anthropic.com/en/docs/claude-code)
[![Telegram](https://img.shields.io/badge/Telegram_Bot-Grammy-26a5e4?logo=telegram&logoColor=white)](https://grammy.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

<br />

```
  Telegram  ──▶  Grammy Bot  ──▶  Claude Agent SDK  ──▶  Your Machine
  voice/text     command router     agentic runtime       bash, files, code
```

</div>

---

> TeleCoder began in February 2026 as a fork of
> [Claudegram by @NachoSEO](https://github.com/NachoSEO/claudegram) and now runs as an
> independent project maintained by [@gitaarik](https://github.com/gitaarik) — 185+ commits
> and ~25k lines beyond the original, including a provider router, PTY transport,
> multi-instance launcher, background task lifecycle, and an agent watchdog.
> See [Credits](#credits) for full attribution.

---

## What is this?

TeleCoder bridges Telegram to a **full Claude Code agent** running locally on your machine. Send a message in Telegram — Claude reads your files, runs commands, writes code, transcribes voice notes, and speaks responses back. All from your phone.

This is not a simple API wrapper. It's the real Claude Code agent with tool access — Bash, file I/O, code editing, web browsing — packaged behind a Telegram interface with streaming responses, session memory, and rich output formatting.

---

## Features

<table>
<tr>
<td width="50%" valign="top">

### Agent Core
- Full Claude Code with tool access (Bash, Read, Write, Edit, Glob, Grep)
- Session resume across messages — Claude remembers everything
- Project-based working directories
- Streaming responses with live-updating messages
- Model picker: Sonnet · Opus · Haiku
- Plan mode, explore mode, loop mode
- Provider router — Claude Code (SDK or PTY) or CCR, with one-tap
  failover when Max throttles ([details](#providers))

### Reddit Integration
- `/reddit` — posts, subreddits, user profiles (needs a Reddit OAuth app)
- `/vreddit` — download & send Reddit-hosted videos
- Auto-compression for videos > 50 MB (CRF → two-pass)
- Original oversized videos archived locally
- Large threads auto-export to JSON

### Media Extraction
- `/extract` — YouTube, Instagram, TikTok video/audio/transcript
- Text, audio (MP3), video (MP4), or all modes
- Requires yt-dlp, ffmpeg (system binaries)

### Medium Integration
- `/medium` — fetch articles as readable text via Freedium
- Telegraph Instant View, save as Markdown, or both
- Pure TypeScript, no Python/Playwright needed

</td>
<td width="50%" valign="top">

### Voice & Audio
- Send a voice note → transcribed via Groq Whisper → fed to Claude
- `/transcribe` — standalone transcription (reply-to or prompt)
- `/tts` — agent responses spoken back as Telegram voice notes
- 13 voices via OpenAI TTS (`gpt-4o-mini-tts`)

### Rich Output
- MarkdownV2 formatting with automatic escaping
- Telegraph Instant View for long responses & tables
- Smart chunking that preserves code blocks
- ForceReply interactive prompts for multi-step commands
- `/teleport` — fork session to terminal for continued work
- Inline keyboards for settings (model, mode, TTS, clear)

### Terminal UI
- Terminal-style display with tool status spinners
- Shows what Claude is doing in real time
- Toggle with `/terminalui`

### MCP Tools (Intelligent Routing)
- Talk naturally — Claude auto-uses the right tools
- Reddit, Medium, YouTube, project management via MCP
- No explicit commands needed for common tasks

### Forum Topic Sessions
- Each forum topic runs as an independent session
- Work on multiple projects in parallel across topics

### Image Uploads
- Send photos or image docs in chat
- Saved to project under `.claudegram/uploads/`
- Claude is notified with path + caption

</td>
</tr>
</table>

---

## Providers

Claude Code is the backend. What varies is the model behind it: a provider router
sits in front of every message, so when Max throttles or you want a different model,
the bot keeps working instead of stopping.

| Provider | What it is | Enable |
|----------|------------|--------|
| `claude` | Claude Code itself, over one of two transports (`/method`): **SDK** (default, Claude Agent SDK) or **PTY** (drives the real `claude` CLI in a pseudo-terminal) | on by default |
| `ccr` | The same `claude` binary, routed through a local [Claude Code Router](https://github.com/musistudio/claude-code-router) proxy so non-Anthropic models can back it | `CCR_ENABLED=true` |

`/provider` opens a picker listing the enabled backends. `/ccr` is a one-tap toggle
between Claude and CCR for the common "I'm throttled, keep going" case. Both are
sticky — the choice holds until you switch back.

### Throttle failover

When a Max usage-limit throttle is detected mid-turn, the bot doesn't just surface
the error — it offers a **🔌 Switch to CCR & retry** button, with the reset time when
one can be parsed from the response. One tap moves the session to CCR and replays the
message you just sent. Set `CCR_AUTO_PROMPT_ON_THROTTLE=false` for a plain error instead.

If the CCR proxy isn't reachable, `CCR_AUTOSTART=true` runs `ccr start` in the background
rather than letting the request hang on a refused connection.

### Switching mid-conversation

Sessions can't cross backends — one model can't replay another's thinking blocks, and
attempting it fails with a signature error. So a switch that would abandon a live session
asks for confirmation first, then **forks**: a fresh session starts on the new backend,
carrying a plain-text summary of the conversation so far. The model preference is cleared
at the same time, since `opus`/`sonnet`/`haiku` don't map 1:1 once CCR's router decides
the real backend per request.

### What stays behind on CCR

CCR runs the same agent, so nearly everything carries over. The exception:

- **PTY transport** — `ccr` always takes the SDK path, along with the PTY-only
  features layered on it

```bash
# .env
CCR_ENABLED=true
CCR_BASE_URL=http://localhost:3456
CCR_AUTH_TOKEN=your_ccr_token
CCR_AUTO_PROMPT_ON_THROTTLE=true
CCR_AUTOSTART=false
```

---

## Sharing a bot

TeleCoder's original access model is one flat list: everyone in
`ALLOWED_USER_IDS` can do everything. That is right for a bot with one user, and
it stops being right the moment you add a second — an approval prompt the person
who triggered it can tap themselves is not an approval.

So an instance can split its users into **admins** and **guests**. Guests use the
agent normally; admins own the parts that reach past their own session.

```bash
# .env — a bot shared with friends in one group
ALLOWED_USER_IDS=111,222,333     # you and two friends
ADMIN_USER_IDS=111               # just you
ALLOWED_GROUP_IDS=-1001234567890 # the group you share
RESTRICT_TO_GROUPS=true          # guests can't take it into a DM
CLAUDE_METHOD_DEFAULT=pty        # the transport the gate runs on
WORKSPACE_DIR=/srv/shared        # the only projects the picker offers
```

Three layers decide what needs a human, from cheapest to smartest:

| Layer | Catches | Costs |
|-------|---------|-------|
| **Permission gate** | destructive commands — `rm -rf`, `sudo`, force-push, `DROP TABLE` | a regex |
| **Scope guard** | a tool call naming a path outside the projects, or any credential path | a path check |
| **Charter judge** | what neither of those can see — "open a tunnel to this box", "email me the projects folder" | a Haiku call, ~5s per guest message |

The first two stop a tool call mid-turn. The third runs *before* the message
reaches Claude, so a held request is still a sentence a person can read rather
than a diff to review afterwards.

What that buys you:

- **Approval prompts are admin-only.** A guarded command pauses, and the prompt
  names its admins with a real Telegram mention — so it notifies you even in a
  muted group, and even if you have no @username. Guests tapping it get told who
  they're waiting on. Unanswered, it denies after
  `PERMISSION_PROMPT_TIMEOUT_MINUTES`.
- **The gate turns itself on.** With guests present you get prompts without
  setting a second variable; `TELECODER_PERMISSION_PROMPTS=0` opts out.
- **Lifecycle and transport are yours.** `/update`, `/restartbot`,
  `/rebuildbot`, `/method`, `/provider` and `/ccr` refuse a guest — `/method`
  most of all, since the gate is a hook on the `claude` CLI and only exists on
  the PTY transport.
- **Out-of-scope paths prompt too.** `cat ~/.ssh/id_rsa`, an edit to a project
  nobody was invited to, a read of this bot's own `.env` — all held. System
  paths and language toolchains stay readable without prompting, because a
  guardrail that fires on `cat /etc/os-release` is one people learn to tap
  through.
- **A charter in plain language.** Drop a `CHARTER.md` in your workspace root
  (or point `CHARTER_FILE` at one) and every guest message is read against it
  first. No charter, no problem — a default is generated from the allowed
  roots. The judge only ever *asks*; it never refuses on its own, and it fails
  open, with the scope guard underneath as the deterministic backstop.
- **`/permissions` reports the truth.** Gate state, scope roots, which charter
  is in force, your role, the guarded patterns, and a warning if the current
  chat is on a transport where the gate can't fire.
- **Letting someone in takes one tap.** A stranger who posts in the shared group
  gets a refusal *and* an approve card naming them, mentioning the admins so it
  notifies you in a muted group. Tap Allow and they're a guest immediately — no
  `.env` edit, no restart. Someone added to the group is asked about the moment
  they join, before they've said anything.

Write the house rules in `CHARTER.md` at your workspace root — see
[`docs/CHARTER.example.md`](docs/CHARTER.example.md) for a starting point.

### Admitting people from chat

`ALLOWED_USER_IDS` is read once at startup, so every new person there costs an
edit and a restart. `/allow` is the runtime half of the same list:

| Command | What it does |
|---------|--------------|
| `/users` | Who can use this bot: admins, `.env` guests, guests admitted from chat, and people seen in the group but not let in |
| `/allow` | Admit someone as a **guest** — reply to their message, or `/allow @user` / `/allow 12345` |
| `/deny` | Remove someone `/allow` admitted |

All three are admin-only, and take effect immediately.

**Reply to their message rather than typing a handle.** Telegram gives bots no
way to resolve a `@username` — there is no such API call, `getChatAdministrators`
covers only a group's admins, and nothing enumerates ordinary members. So the
only handles this bot can match are the ones it has watched go by, and a reply
is both exact and the one form that works for the many people who have no
username at all. A handle it hasn't seen gets told so, rather than failing
mysteriously.

Ids are the identity throughout. A Telegram username can be dropped and claimed
by someone else, so it's re-resolved on every use and never stored as the thing
being allowed.

Admitting someone makes them a guest, which switches on the permission gate, the
scope guard and the charter judge if they weren't already on. `/deny` on an id
that came from `ALLOWED_USER_IDS` reports where it actually lives instead of
appearing to work until the next restart.

> [!IMPORTANT]
> All of the above is supervision, not isolation. Claude still runs as your Unix
> user, so a guest's session can reach anything that user can — auto mode asks
> before the riskier steps, but it is Claude's judgement, not a boundary.
> `WORKSPACE_DIR` scopes the project picker, not the filesystem. For a real
> boundary, run the shared instance as its own Unix account — below.

### A real boundary: its own Unix account

Supervision decides what needs your attention. Unix decides what is reachable at
all. If the people you're sharing with shouldn't be able to read your other
projects even in principle, the shared bot needs an account that owns nothing but
the shared projects:

```bash
sudo ./scripts/setup-shared-bot-user.sh --operator "$USER"
```

That script locks down your home directory, creates a `telefriends` account with
no sudo and no docker (the docker group is root-equivalent), gives it a projects
directory and its own TeleCoder checkout, writes a starter `.env` with the
sharing settings already filled in, and installs a lingering `systemd --user`
service so it survives a reboot. Authenticating Claude and pasting the bot token
stay yours — both are interactive, and neither belongs in a script's arguments.

It ends by verifying its own work, which you can re-run at any time:

```bash
sudo ./scripts/setup-shared-bot-user.sh --verify
```

The check doesn't reason about modes; it becomes the account and *tries* to read
your secrets, which is the only form of that answer worth trusting.

> [!WARNING]
> Check this before adding any account: a home directory at mode `0751` lets
> other accounts traverse into it, so every world-readable file inside is
> reachable by absolute path — and a `.env` written at the default `0664` is one
> of them. `--verify` reports it; the setup script fixes it.

---

## Quick Start

### Prerequisites

| Requirement | Notes |
|-------------|-------|
| **Node.js 18+** | with npm |
| **Claude Code CLI** | installed and authenticated — `claude` in your PATH |
| **Telegram bot token** | from [@BotFather](https://t.me/botfather) |
| **Your Telegram user ID** | from [@userinfobot](https://t.me/userinfobot) |

### Setup

```bash
git clone https://github.com/gitaarik/telecoder.git
cd telecoder
cp .env.example .env
```

Edit `.env`:

```bash
TELEGRAM_BOT_TOKEN=your_bot_token
ALLOWED_USER_IDS=your_user_id
```

### Run

```bash
npm install
npm run dev        # dev mode with hot reload
```

Open your bot in Telegram → `/start`

---

## Commands

### Session
| Command | Description |
|---------|-------------|
| `/start` | Welcome message |
| `/project` | Set working directory (interactive picker) |
| `/newproject <name>` | Create and switch to a new project |
| `/projectcommands` | List every slash command available here — project, built-in skills, plugins — and the ones TeleCoder shadows |
| `/clear` | Clear conversation history (project stays selected) |
| `/status` | Current session info |
| `/sessions` | List saved sessions |
| `/resume` | Pick from recent sessions |
| `/continue` | Resume most recent session |
| `/recap [N]` | Re-read the last N exchanges of the current session (default 3) |
| `/prompts [N]` | List just the last N prompts you sent, without the replies (default 5, max 20) |
| `/sync` | Resend the latest assistant reply from the session log if Telegram missed any of it |
| `/handoff` | Dump the conversation to markdown — Telegraph link plus downloadable file |
| `/fork` | Fork the conversation — new branch on this bot, or hand off to a sibling bot |
| `/accept` | Accept a pending fork from another bot |
| `/decline` | Discard a pending fork without loading it |
| `/schedule <when> <prompt>` | Schedule a recurring prompt (`every 5m`, `daily 9am`, or raw cron) |
| `/schedules` | List active scheduled tasks for this chat |
| `/unschedule <id>` | Remove a scheduled task by id |
| `/teleport` | Move session to terminal (forked) |

### Agent Modes
| Command | Description |
|---------|-------------|
| `/plan` | Plan mode for complex tasks |
| `/explore` | Explore codebase to answer questions |
| `/loop` | Run iteratively until task complete |
| `/model` | Switch Sonnet / Opus / Haiku — this bot, or add `all` for every instance |
| `/effort` | Set reasoning effort (low / medium / high / xhigh / max / auto); `all` works here too |
| `/btw` | Ask a side question without interrupting the running task |
| `/mode` | How much Claude asks before acting (manual / accept edits / plan / auto / bypass) — admin-only |
| `/streaming` | Toggle streaming / wait replies |
| `/method` | Switch Claude transport (SDK / PTY) — admin-only |
| `/provider` | Switch backend — Claude / CCR (shown when `CCR_ENABLED`) — admin-only |
| `/ccr` | Sticky toggle between Claude and CCR routing (shown when `CCR_ENABLED`) — admin-only |
| `/verbosity` | Pick verbosity tier (quiet / normal / verbose / debug) |
| `/terminalui` | Toggle terminal-style display |

### Content
| Command | Description |
|---------|-------------|
| `/reddit` | Fetch Reddit posts, subreddits, profiles |
| `/vreddit` | Download Reddit-hosted videos |
| `/medium` | Fetch Medium articles via Freedium |
| `/file` | Download a project file |
| `/telegraph` | Toggle Instant View for long responses |
| `/suggestions` | Toggle predicted next-prompt buttons under each response |
| `/extract <url>` | Download media from YouTube, TikTok, Instagram |

### Voice & TTS
| Command | Description |
|---------|-------------|
| `/tts` | Toggle voice replies, pick voice |
| `/transcribe` | Transcribe audio to text |
| *Send voice note* | Auto-transcribed → processed by Claude |

### Utility
| Command | Description |
|---------|-------------|
| `/ping` | Health check |
| `/context` | Show Claude context / token usage |
| `/cost` | Show usage limits and cost as Claude Code reports them — session/weekly limits on a subscription, dollar totals on API billing — plus TeleCoder's own running tally for the conversation, which the CLI cannot keep (SDK mode only) |
| `/compact` | Compact the context window (SDK and PTY), reporting the token reduction |
| `/statusline` | Toggle per-turn status line (effort, model, context %, cost) |
| `/botname` | Toggle dynamic bot name (shows the active project) |
| `/topic` | Set or clear the conversation topic |
| `/tasks` | List active background tasks |
| `/shells` | List and kill OS-level background shells from the PTY session |
| `/permissions` | Show the permission-gate state, your role, and the patterns it enforces |
| `/users` | Who can use this bot — admins, guests, and people seen but not let in — admin-only |
| `/allow` | Let someone in as a guest — reply to their message, or `/allow @user` — admin-only |
| `/deny` | Remove someone admitted with `/allow` — admin-only |
| `/botstatus` | Bot process status |
| `/restartbot` | Restart the bot — admin-only |
| `/rebuildbot` | Rebuild code and restart — admin-only |
| `/update` | Update the Claude Code CLI — admin-only |
| `/cancel` | Cancel current request (alias: `/stop`) |
| `/commands` | Show all commands |

---

## Optional Integrations

<details>
<summary><strong>Reddit — <code>/reddit</code> & <code>/vreddit</code></strong></summary>

`/reddit` is a pure TypeScript module using Reddit's OAuth2 API directly — no external Python dependency.

```bash
# .env
REDDIT_CLIENT_ID=your_client_id
REDDIT_CLIENT_SECRET=your_client_secret
REDDIT_USERNAME=bot_account
REDDIT_PASSWORD=bot_password
```

Create a "script" app at https://www.reddit.com/prefs/apps/. Use a dedicated bot account — NOT your personal credentials.

`/reddit` turns itself on once all four credentials are present, and stays hidden otherwise, so it never shows up in the command menu as something that can only fail. Set `REDDIT_ENABLED` explicitly to override that either way.

`/vreddit` is separate — it reads Reddit's public JSON and needs no credentials, only `ffmpeg` and `ffprobe` on your PATH.

</details>

<details>
<summary><strong>Medium — <code>/medium</code></strong></summary>

Pure TypeScript via Freedium mirror — no extra dependencies.

```bash
# .env (optional tuning)
FREEDIUM_HOST=freedium-mirror.cfd
MEDIUM_TIMEOUT_MS=15000
```

</details>

<details>
<summary><strong>Voice Transcription — Groq Whisper</strong></summary>

```bash
# .env
GROQ_API_KEY=your_groq_key
GROQ_TRANSCRIBE_PATH=/absolute/path/to/groq_transcribe.py
```

</details>

<details>
<summary><strong>Text-to-Speech — OpenAI TTS</strong></summary>

```bash
# .env
OPENAI_API_KEY=your_openai_key
TTS_MODEL=gpt-4o-mini-tts
TTS_VOICE=coral
TTS_RESPONSE_FORMAT=opus
```

13 voices available: `alloy`, `ash`, `ballad`, `cedar`, `coral`, `echo`, `fable`, `marin`, `nova`, `onyx`, `sage`, `shimmer`, `verse`

</details>

---

## Configuration Reference

All config lives in `.env`. See [`.env.example`](.env.example) for the full annotated reference.

### Required

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `ALLOWED_USER_IDS` | Comma-separated Telegram user IDs |

### Sharing (admins & guests)

Only needed for a bot other people use. Unset, every allowed user is an admin
and nothing below changes anything.

| Variable | Default | Description |
|----------|---------|-------------|
| `ADMIN_USER_IDS` | all allowed users | Who may approve permission prompts and run lifecycle/transport commands |
| `ALLOWED_GROUP_IDS` | — | Group/supergroup chat IDs the bot is shared in |
| `RESTRICT_TO_GROUPS` | `false` | Confine guests to those groups; admins can still DM the bot |
| `TELECODER_PERMISSION_PROMPTS` | on when guests exist | `1`/`0` to force the permission gate on or off |
| `PERMISSION_PROMPT_TIMEOUT_MINUTES` | `10` | How long a prompt or held message waits for an admin |
| `SCOPE_GUARD` | `auto` | Prompt on tool calls naming paths outside the shared projects |
| `SCOPE_ALLOWED_PATHS` | — | Extra in-bounds directories, comma-separated |
| `CHARTER_JUDGE` | `auto` | Read each guest message against a charter before it runs |
| `CHARTER_FILE` | `WORKSPACE_DIR/CHARTER.md` | The charter the judge reads |
| `CLAUDE_METHOD_DEFAULT` | `sdk` | Transport for chats that haven't run `/method`; the gate only runs on `pty` |

See [Sharing a bot](#sharing-a-bot) for how the pieces fit together.

### Core

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | — | API key (optional with Claude Max subscription) |
| `WORKSPACE_DIR` | `$HOME` | Root directory for project picker |
| `CLAUDE_EXECUTABLE_PATH` | `claude` | Path to Claude Code CLI |
| `CLAUDE_PLUGINS` | — | Marketplace plugins to enable in the agent, as `plugin@marketplace` ids, comma-separated |
| `BOT_NAME` | `TeleCoder` | Bot name in system prompt |
| `STREAMING_MODE` | `streaming` | `streaming` or `wait` |
| `DANGEROUS_MODE` | `false` | Auto-approve all tool permissions |
| `CANCEL_ON_NEW_MESSAGE` | `false` | Auto-cancel running query on new message |
| `CLAUDE_SDK_LOG_LEVEL` | `off` | SDK log level: off, basic, verbose, trace |

### Providers

| Variable | Default | Description |
|----------|---------|-------------|
| `CCR_ENABLED` | `false` | Enable `/ccr` and CCR in `/provider` |
| `CCR_BASE_URL` | `http://localhost:3456` | Where CCR's local proxy listens |
| `CCR_AUTH_TOKEN` | — | CCR's local auth token |
| `CCR_AUTO_PROMPT_ON_THROTTLE` | `true` | Offer a one-tap CCR retry on Max throttle |
| `CCR_AUTOSTART` | `false` | Run `ccr start` when the proxy isn't reachable |
| `CCR_BINARY` | `ccr` | Path or name of the `ccr` binary for autostart |

### Reddit

| Variable | Default | Description |
|----------|---------|-------------|
| `REDDIT_ENABLED` | on when all four credentials are set | Force `/reddit` on or off |
| `REDDIT_CLIENT_ID` | — | Reddit OAuth2 client ID |
| `REDDIT_CLIENT_SECRET` | — | Reddit OAuth2 client secret |
| `REDDIT_USERNAME` | — | Reddit bot account username |
| `REDDIT_PASSWORD` | — | Reddit bot account password |
| `REDDIT_VIDEO_MAX_SIZE_MB` | `50` | Max video size before compression |
| `REDDITFETCH_TIMEOUT_MS` | `30000` | Execution timeout |
| `REDDITFETCH_JSON_THRESHOLD_CHARS` | `8000` | Auto-switch to JSON output |

### Medium / Freedium

| Variable | Default | Description |
|----------|---------|-------------|
| `FREEDIUM_HOST` | `freedium-mirror.cfd` | Freedium mirror host |
| `MEDIUM_TIMEOUT_MS` | `15000` | Fetch timeout |
| `MEDIUM_FILE_THRESHOLD_CHARS` | `8000` | File save threshold |

### Media Extraction

| Variable | Default | Description |
|----------|---------|-------------|
| `EXTRACT_ENABLED` | `true` | Enable /extract command |
| `YTDLP_COOKIES_PATH` | — | Netscape cookies.txt for yt-dlp |

### Voice & TTS

| Variable | Default | Description |
|----------|---------|-------------|
| `GROQ_API_KEY` | — | Groq API key for Whisper |
| `GROQ_TRANSCRIBE_PATH` | — | Path to `groq_transcribe.py` |
| `OPENAI_API_KEY` | — | OpenAI API key for TTS |
| `TTS_VOICE` | `coral` | Default TTS voice |
| `TTS_MODEL` | `gpt-4o-mini-tts` | TTS model |
| `VOICE_SHOW_TRANSCRIPT` | `true` | Show transcript text before agent response |

---

## Architecture

```
src/
├── bot/
│   ├── bot.ts                     # Bot setup, handler registration
│   ├── handlers/
│   │   ├── command.handler.ts     # All slash commands + inline keyboards
│   │   ├── message.handler.ts     # Text routing, ForceReply dispatch
│   │   ├── voice.handler.ts       # Voice download, transcription, agent relay
│   │   └── photo.handler.ts       # Image save + agent notification
│   └── middleware/
│       ├── auth.middleware.ts      # User whitelist + group chat auth
│       └── stale-filter.ts        # Ignore stale messages on restart
├── claude/
│   ├── agent.ts                   # Claude Agent SDK, session resume, system prompt
│   ├── mcp-tools.ts              # MCP server: Reddit, Medium, Extract, Telegraph tools
│   ├── session-manager.ts         # Per-chat session state
│   ├── session-history.ts         # Session persistence and history
│   ├── request-queue.ts           # Sequential request queue
│   ├── command-parser.ts          # Help text + command descriptions
│   └── agent-watchdog.ts          # Watchdog for long-running agent tasks
├── reddit/
│   ├── redditfetch.ts             # Native TypeScript Reddit client (OAuth2)
│   └── vreddit.ts                 # Reddit video download + compression pipeline
├── medium/
│   └── freedium.ts                # Freedium article fetcher
├── media/
│   └── extract.ts                 # YouTube/TikTok/Instagram extraction (yt-dlp)
├── telegram/
│   ├── message-sender.ts          # Streaming, chunking, Telegraph routing
│   ├── markdown.ts                # MarkdownV2 escaping
│   ├── telegraph.ts               # Telegraph Instant View client
│   ├── telegraph-settings.ts      # Per-chat Telegraph toggle
│   ├── terminal-renderer.ts       # Terminal-style UI renderer
│   ├── terminal-settings.ts       # Per-chat terminal UI toggle
│   └── deduplication.ts           # Message dedup
├── tts/
│   ├── tts.ts                     # TTS provider routing (Groq Orpheus / OpenAI)
│   ├── tts-settings.ts            # Per-chat voice settings
│   └── voice-reply.ts             # TTS hook for agent responses
├── audio/
│   └── transcribe.ts              # Shared transcription utilities
├── utils/
│   ├── download.ts                # URL download with SSRF protection
│   ├── sanitize.ts                # Path and error sanitization
│   ├── workspace-guard.ts         # Workspace boundary enforcement
│   ├── url-guard.ts               # URL validation (protocol, SSRF)
│   ├── file-type.ts               # File content validation
│   ├── caffeinate.ts              # macOS sleep prevention
│   ├── session-key.ts             # Session key generation (DM + forum topics)
│   ├── agent-timer.ts             # Agent execution timing
│   └── debug-agent.ts             # Debug utilities
├── config.ts                      # Zod-validated environment config
└── index.ts                       # Entry point
```

---

## Development

```bash
npm run dev          # Dev mode with hot reload (tsx watch)
npm run typecheck    # Type check only
npm run build        # Compile to dist/
npm start            # Run compiled build
```

### Bot Control Script

```bash
./scripts/telecoder-botctl.sh dev start       # Start dev mode
./scripts/telecoder-botctl.sh dev restart     # Restart dev
./scripts/telecoder-botctl.sh prod start      # Start production
./scripts/telecoder-botctl.sh dev log         # Tail logs
./scripts/telecoder-botctl.sh dev status      # Check if running
```

### Self-Editing Workflow

If TeleCoder is editing its own codebase, use **prod mode** to avoid hot-reload restarts:

```bash
./scripts/telecoder-botctl.sh prod start      # No hot reload
# ... let Claude edit files ...
./scripts/telecoder-botctl.sh prod restart    # Apply changes
```

Then `/continue` or `/resume` in Telegram to restore your session.

---

## Security

- **User whitelist** — only approved Telegram IDs can interact
- **Admins & guests** — a shared bot can reserve approvals, lifecycle and
  transport for `ADMIN_USER_IDS`; see [Sharing a bot](#sharing-a-bot)
- **Group confinement** — `RESTRICT_TO_GROUPS` keeps guests out of private chats
- **Permission gate** — dangerous Bash patterns pause for an admin's approval
- **Scope guard** — tool calls reaching outside the shared projects, or at any
  credential path, pause too
- **Charter judge** — guest messages are read against a charter before they run
- **Project sandbox** — the project picker is scoped to `WORKSPACE_DIR`
- **Permission mode** — uses `acceptEdits` by default
- **Dangerous mode** — opt-in auto-approve for all tool permissions
- **Secrets** — loaded from `.env` (gitignored), never committed

---

## Credits

TeleCoder is a derivative of [Claudegram](https://github.com/NachoSEO/claudegram), created by
[@NachoSEO](https://github.com/NachoSEO) and MIT-licensed. That project is the foundation this
one is built on, and its copyright notice is retained in [LICENSE](LICENSE).

TeleCoder is maintained independently by [@gitaarik](https://github.com/gitaarik) and adds:

- **Auto-topic & dynamic bot name** — bot display name reflects current
  work topic, derived via parallel Haiku side-call; per-chat /topic and
  /botname controls
- **Multi-instance launcher** — run multiple bots from one process with
  per-bot session scoping, per-bot model/effort preferences, and an opt-in
  fan-out (`/model sonnet all`) that relays a setting to every instance
- **Background task lifecycle** — surface SDK task lifecycle (started,
  progress, notifications) in the streaming UI; /tasks command to inspect
- **Monitor events** — separate Telegram messages for streaming Monitor
  tool output
- **Reasoning effort control** — /effort command (low/medium/high/xhigh/
  max) with icon prefix in bot name; /btw side-question command
- **Plan mode surfacing** — extract plan content from spontaneous plan
  mode and inject into chat
- **Skills + TodoWrite** — full SDK skill discovery; live-updating
  per-turn checklist for TodoWrite calls
- **send_file MCP tool** — Claude can deliver files directly via Telegram
- **Session resilience** — auto-restore on restart (/rebuildbot), persistent
  topic + preview across restarts, last-response display on resume
- **Agent watchdog** — silence/stuck-tool detection, force-abort on stuck
  queries, /cancel works during hangs
- **Message batching middleware** — combines rapid split pastes into one
  prompt
- **SDK isolation** — bot runs in a clean SDK env to avoid user-level
  plugin tool-deferral interfering with proactive MCP calls

## License

MIT
