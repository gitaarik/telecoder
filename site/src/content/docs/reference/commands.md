---
title: Commands
description: Every bot command TeleCoder registers.
sidebar:
  order: 1
---

Every command TeleCoder registers. `/commands` lists them in Telegram, and Telegram's own `/` menu shows the ones that apply to your setup (`/provider` and `/ccr` only with `CCR_ENABLED`, `/transcribe` only with voice turned on, `/tts` only with `TTS_ENABLED`, `/rebuildbot` only in a source checkout). *Admin-only* matters on a shared bot: see [Sharing a bot](../guides/sharing.md). With one user, you are the admin.

## Session
| Command | Description |
|---------|-------------|
| `/start` | Welcome message |
| `/project` | Set working directory (interactive picker) — admin-only |
| `/newproject <name>` | Create and switch to a new project — admin-only |
| `/newbot [project]` | Create a bot for a project (this chat's if none is given) without BotFather. Needs Bot Management Mode on the bot you send it to ([details](../guides/multiple-bots.md)) — admin-only |
| `/projectcommands` | List every slash command available here — project, built-in skills, plugins — and the ones TeleCoder shadows |
| `/clear` | Clear conversation history (project stays selected) |
| `/status` | Current session info |
| `/resume [words\|id]` | Pick, search or open any Claude Code session, like Claude Code's own `/resume` |
| `/recap [N]` | Re-read the last N exchanges of the current session (default 3), ending with the same status message as a normal turn |
| `/prompts [N]` | List just the last N prompts you sent, without the replies (default 15, max 25) |
| `/sync` | Resend the latest assistant reply from the session log if Telegram missed any of it |
| `/handoff` | Dump the conversation to markdown as a downloadable file |
| `/fork` | Fork the conversation — into a new thread on a bot with threads, otherwise a new branch on this bot or a hand-off to a sibling bot |
| `/spinoff <task>` | Split a task off into a new thread, with the context compacted around it and the task as its first prompt. As a reply, it forks from that message. Needs threads |
| `/deletethread [-y]` | Delete the thread it's sent in, with all its messages, and end its session; works mid-turn. The conversation stays in `/resume`. In a group, the bot needs the right to delete messages — admin-only |
| `/tree` | Draw the conversation's fork tree; tap a point to carry on that branch or branch from it, in this chat. A branch from another chat or bot carries on as a copy |
| `/accept` | Accept a pending fork from another bot |
| `/decline` | Discard a pending fork without loading it |
| `/schedule <when> <prompt>` | Schedule a recurring prompt in this thread: `every 5m`, `daily 9am`, `weekdays 9:30am`, `mon,fri 17:00` or raw cron, with `--max-runs N` (default 50) and `--label "..."`. At least a minute apart, 10 per thread |
| `/schedules` | List the scheduled prompts for this thread, including disabled ones |
| `/unschedule <id>` | Remove a scheduled task by id |
| `/teleport` | The `claude --resume` command to carry on this session in a terminal — admin-only |

## Agent controls
| Command | Description |
|---------|-------------|
| `/model` | Switch Sonnet / Opus / Haiku — this bot, or add `all` for every instance |
| `/effort` | Set reasoning effort (low / medium / high / xhigh / max / auto); `all` works here too |
| `/btw` | Ask a side question without interrupting the running task. It answers only, without changing files. In SDK mode it needs a running turn |
| `/steer <text>` | Stop the running turn and send the text in its place, as a correction; `⚡ Interrupt & send` on a queued message does the same |
| `/later [text]` | Set an idea aside without sending it; once Claude is done, the bot asks whether to send it, with Send and Drop. Alone, lists what's set aside |
| `/mode` | How much Claude asks before acting (manual / accept edits / plan / auto / bypass) — admin-only |
| `/autoapprove [duration]` | Answer the permission gate's prompts in advance in this chat for a while (default `30m`, at most `4h`; a restart ends it), posting each command it lets through; `off` ends it, `status` reads it back. The most destructive commands still ask — admins and approvers |
| `/method` | Switch Claude transport (SDK / PTY) — admin-only |
| `/provider` | Switch backend — Claude / CCR (shown when `CCR_ENABLED`) — admin-only |
| `/ccr` | Sticky toggle between Claude and CCR routing (shown when `CCR_ENABLED`) — admin-only |
| `/verbosity` | Pick verbosity tier (quiet / normal / verbose / debug) |
| `/terminalui` | Toggle terminal-style display |

## Files and output
| Command | Description |
|---------|-------------|
| `/file <path>` | Download a file. Guests get files from the chat's project only; admins from anywhere in `WORKSPACE_DIR`. Credential and bot-state paths (`.env`, `~/.ssh`, `~/.claude`, cloud CLI configs and the like) are refused for everyone |
| `/suggestions` | Turn predicted next-prompt buttons under each reply on or off, from the next session (PTY mode) |

## Voice and TTS
| Command | Description |
|---------|-------------|
| `/tts` | Toggle voice replies, pick voice |
| `/transcribe` | Transcribe audio to text |
| *Send voice note* | Auto-transcribed → processed by Claude |

## Utility
| Command | Description |
|---------|-------------|
| `/ping` | Health check |
| `/context` | Show Claude context / token usage |
| `/cost` | Show usage limits and cost as Claude Code reports them — session/weekly limits on a subscription, dollar totals on API billing — plus TeleCoder's own running tally for the conversation, which the CLI cannot keep (SDK mode only) |
| `/compact` | Compact the context window (SDK and PTY), reporting the token reduction |
| `/statusline` | Toggle the status line that closes every reply (project, effort, model, context %, cost). On by default (`STATUS_LINE_DEFAULT`), with the topic; your last prompts and a `claude --resume` command are sub-toggles |
| `/botname [name\|reset]` | Rename the bot in Telegram. The name is kept per bot and wins over `BOT_NAME`; `reset` goes back to it. Telegram throttles renames hard, so a refused one is reported and sent again when the cooldown ends. Alone, shows the name Telegram has and any pending cooldown — admin-only |
| `/topic` | Set or clear the conversation topic |
| `/tasks` | List active background tasks, with details per task; in PTY mode, a task's output so far, and Claude Code's own `/tasks` view with a button per row |
| `/shells` | List and kill OS-level background shells from the PTY session |
| `/permissions` | Show the permission-gate state, your role, and the patterns it enforces — admin-only |
| `/users` | Who can use this bot — admins, guests, and people seen but not let in — admin-only |
| `/allow` | Let someone in as a guest — reply to their message, or `/allow @user` — admin-only |
| `/deny` | Remove someone admitted with `/allow` — admin-only |
| `/botstatus` | Bot process status and the version it's running |
| `/version` | The running version and whether it's the latest, against the code in the checkout and the branch it tracks |
| `/restartbot` | Restart the bot — admin-only |
| `/rebuildbot` | Rebuild code and restart — this instance, all, or all once each is idle (`/rebuildbot idle`) — admin-only, source checkouts only |
| `/update` | Update the Claude Code CLI, or TeleCoder itself on an npm install — admin-only |
| `/cancel` | Stop the running turn and drop the messages and scheduled prompts waiting behind it; set-aside messages stay (alias: `/stop`) |
| `/commands [words]` | Show all commands, or search them by name and description: `/commands kill` finds `/shells`. Telegram's own `/` menu only matches the start of a name. A mistyped command (`/task`, `/shel`) that Claude Code doesn't know either gets the likely commands as buttons instead of going to Claude; a tap runs it with the arguments as typed |

## Group access
| Command | Description |
|---------|-------------|
| `/members` | Who may prompt the agent in this group, and the default for everyone else |
| `/allow` | In a group, let someone prompt the agent here; in a DM, admit them everywhere — admin only |
| `/deny` | In a group, make someone a spectator here; in a DM, remove them entirely — admin only |

Name a person by replying to one of their messages with the command; `@handle`
works once the bot has seen them post, and a numeric user id always works.
