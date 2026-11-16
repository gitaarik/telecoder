---
title: Features
description: Everything TeleCoder does, from threads and forks to voice and background tasks.
sidebar:
  order: 1
---

Everything TeleCoder does, by area. Commands are listed in full in [Commands](../reference/commands.md).

## The agent

- The real Claude Code agent with its tools (Bash, Read, Write, Edit, Glob, Grep, web search
  and the rest), running on your machine as your user
- Two transports, switched with `/method`: the Claude Agent SDK (the default), or the real
  `claude` CLI driven in a pseudo-terminal (PTY), where a project's `CLAUDE.md`, settings,
  skills and slash commands work as in your terminal and its permission dialogs arrive as
  buttons
- Streaming replies: the answer shows while Claude writes it, on both transports
- Model and effort pickers (`/model`, `/effort`), and plan, explore and loop modes
- `/mode` sets how much Claude asks before acting, from manual to bypass
- `/compact`, `/context` and `/cost`, as in the CLI, and `/projectcommands` lists every slash
  command a project has
- `/commands <words>` searches the bot's commands by name and description, where Telegram's
  own `/` menu only matches the start of a name, and a mistyped command gets the likely ones
  as buttons instead of reaching Claude
- Marketplace plugins you name in `CLAUDE_PLUGINS` come along
- A provider router with one-tap failover to Claude Code Router when Max throttles
  ([Providers](providers.md))

## Threads and sessions

- Each thread is its own session: forum topics in groups, and threads in private chats on a
  bot with Threaded Mode. A new thread is a new session, named after what it's about
- Session resume across messages, and `/resume`, `/continue` and `/recap` to get back to
  earlier work, including sessions started in your terminal
- `/prompts` lists the prompts you sent, and branches from any of them
- `/teleport` continues a session in your terminal; `/handoff` exports it as markdown
- Chats carry on by themselves after a restart
- Project-based working directories, picked with `/project`
- [Threads and forks](threads-and-forks.md)

## Forks

- `/fork` copies the conversation into a new thread on a bot with threads, or a new branch on
  this one, or hands it to a sibling bot
- `/spinoff <task>` splits a task off into a new thread, with the context compacted around it
  and the task as its first prompt
- `/tree` draws the conversation's fork tree; tap a point to carry on that branch or branch
  from it
- `/deletethread` deletes a thread and ends its session. A thread deleted by hand is noticed
  the first time something is sent into it, and an idle PTY session's `claude` is ended after
  an hour either way
- [Threads and forks](threads-and-forks.md)

## Working while Claude works

- `/btw` asks a side question without interrupting the running task
- `/steer` stops the turn and sends a correction in its place; `⚡ Interrupt & send` on a
  queued message does the same
- `/later` sets an idea aside, and once Claude is done the bot asks whether to send it
- Messages that have to wait say so, and can be taken back or set aside
- Rapid split pastes are combined into one prompt
- Predicted next-prompt buttons under each reply (`/suggestions`)
- [Working while Claude works](working-while-claude-works.md)

## Background and scheduled work

- Background tasks and Monitor events relayed to Telegram as they happen
- `/tasks` and `/shells` to inspect and stop what's running, with a background task's output so far in PTY mode
- `/schedule` for recurring prompts (`every 5m`, `daily 9am`, or cron)
- [Background and scheduled work](background-and-scheduled-work.md)

## Claude can reach you

- MCP tools let Claude ask with buttons or polls, send files, and (in PTY mode) schedule prompts
- Several questions at once arrive as one form: step through them, go back to change an
  answer, and nothing reaches Claude until you tap Submit, as in Claude Code's own dialog
- Secrets stay out of the chat: you send a key, the bot deletes it and hands it to the
  command Claude named, and a Claude token can be made on the spot with `claude setup-token`
- Talk naturally: Claude picks the right tool without explicit commands

## Multiple bots

- Run several bots from one launcher, each with its own sessions and preferences
- Add, remove or change a bot in `instances.json` while the others keep running
- Create a bot for a project from Telegram with `/newbot`, no BotFather chat needed, with
  that project as its home and the TeleCoder icon as its picture
- Apply a setting everywhere with `/model sonnet all`
- [Setup](multiple-bots.md)

## Reliability

- An agent watchdog that detects silent or stuck tools, with `/cancel` working during hangs
- A memory guard: a message that would start a new `claude` on a machine short of memory
  ends the idle claudes first, and asks before starting when that isn't enough; `/status`
  shows the machine's available memory and the claudes running
- `/sync` resends a reply Telegram missed
- `/restartbot` and `/update` from chat; the background service brings the bot back
- `/rebuildbot idle` builds once and restarts each bot as soon as it has nothing left to
  finish: no turn running, no background task or shell command out, no reply still on its
  way, no thread name still to update. One message keeps the tally, with buttons to
  restart the rest now or call it off
- On an npm install, `/update` upgrades TeleCoder itself and `/version` checks for a newer
  release

## Sharing and permissions

- Admins, approvers and guests, and per-group contributors and spectators
- A permission gate on every transport, a scope guard for paths, and a plain-language charter
  read before a guest's message runs ([Sharing a bot](sharing.md))
- `/allow` and `/deny` let people in or out from chat, without a restart
- `/autoapprove` answers the gate in advance for a while, for jobs made of many guarded
  commands

## Voice and audio

- Send a voice note: it's transcribed with Groq Whisper and fed to Claude
- `/transcribe` for transcription on its own
- `/tts` speaks replies back as Telegram voice notes, through Groq Orpheus or OpenAI
- [Voice](voice.md)

## Rich output

- Formatting sent as Telegram entities: nothing to escape, and a long reply splits anywhere
  without breaking its bold, links or code blocks
- A status line closing every reply: topic, project, effort, model, context use and cost,
  on by default and sent silently; `/statusline` turns it off or adds your last prompts
  and a `claude --resume` command
- Terminal-style tool status (`/terminalui`) and four verbosity tiers (`/verbosity`)
- Claude Code's task list as a live card
- `/topic` sets the conversation topic shown in the status line and as the thread's name; `/botname` renames the bot in Telegram, without a trip to BotFather
- Optional Telegraph Instant View for long replies (opt-in with `TELEGRAPH_ENABLED=true`;
  pages are public)
- Inline keyboards for settings

## Files and uploads

- Send photos or image documents; they're saved under `.telecoder/uploads/` in the project, a
  folder that keeps itself out of git
- `/file` sends you a file from the project (credential files such as `.env` and `~/.ssh` are
  never sent)

## Setup

- `telecoder init`, a wizard that checks the bot token, learns your user ID and writes the
  config
- `telecoder service install` for a systemd user service on Linux or a LaunchAgent on macOS
- `telecoder doctor` checks Node, the `claude` CLI and its login, and the config
- [Install and run](../start/install.md) and [the CLI reference](../reference/cli.md)
