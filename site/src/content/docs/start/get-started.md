---
title: Get started
description: From nothing to talking to Claude Code in Telegram, in about ten minutes.
sidebar:
  order: 1
---

This walks you through a first setup: a bot of your own, TeleCoder running on your
machine in the background, and a first conversation. It takes about ten minutes.
For every option along the way, see [Install and run](install.md).

## What you need

- **Linux or macOS.** WSL 2 should work like Linux, but it's untested.
- **Node.js 22 or newer**, with npm.
- **Claude Code**, installed and logged in on this machine:
  `curl -fsSL https://claude.ai/install.sh | bash`, then run `claude` once and `/login`.
  A Pro or Max subscription works, and so does an API key.
- **On Linux, a C++ toolchain**, because `npm install` compiles `node-pty`:
  `sudo apt install python3 make g++` (Debian, Ubuntu) or
  `sudo dnf install python3 make gcc-c++` (Fedora). macOS uses a prebuilt binary.
- **Telegram** on your phone or computer.

TeleCoder runs as you, with your Claude login, on your machine. There's no hosted version
and no server to expose: the bot polls Telegram, so it needs no open port or tunnel.

## 1. Make a bot with BotFather

<!-- screenshot: the BotFather /newbot exchange, ending with the token -->

1. Open [@BotFather](https://t.me/BotFather) in Telegram and send `/newbot`.
2. Give it a display name (anything, like *My TeleCoder*) and a username ending in `bot`.
3. BotFather replies with a token like `123456789:AAH...`. Keep it to hand for the next
   step, and keep it to yourself: whoever has it controls the bot.

## 2. Install and run the wizard

```bash
npm install -g telecoder
telecoder init
```

<!-- screenshot: telecoder init in a terminal, from the token to "written" -->

`telecoder init` checks Node and your Claude login first, then asks for:

- **The bot token.** It checks the token with Telegram straight away.
- **You.** It asks you to send your new bot `/start`, and learns your Telegram user ID
  from that. Only the IDs you allow can use the bot.
- **Your projects folder**, the folder your code lives in, such as `~/dev`.
  TeleCoder offers the folders in it as projects.
- **Voice**, optional.
- **A picture for the bot.** If your bot has no profile picture yet, the wizard offers
  to give it the TeleCoder icon, so it's easy to spot in your chat list.

It writes your answers to `~/.telecoder/.env`, readable by you only. Run it again to
change an answer, and run `telecoder doctor` whenever something seems off.

## 3. Keep it running

```bash
telecoder service install
```

This installs TeleCoder as a service that starts at boot and restarts if it stops: a
systemd user unit on Linux, a LaunchAgent on macOS.

On Linux it asks to turn on **lingering** (`loginctl enable-linger`). Say yes: without
it, systemd stops your user services when you log out, so the bot would go quiet the
moment you close your last SSH session or log out of your desktop.

```bash
telecoder service status   # is it running?
telecoder service logs     # follow what it's doing
```

Prefer to watch it in a terminal for now? `telecoder start` runs it in the foreground
instead, until you press Ctrl+C.

## 4. Your first conversation

<!-- screenshot: /project picker, then a first prompt and a reply with a tool call -->

1. Open your bot in Telegram and send `/project`. Tap the project you want to work on.
2. Type what you want, as you would in Claude Code: *"What does this project do? Then
   look for any failing tests."*
3. Claude works on your machine and streams its progress into the chat: what it reads,
   what it runs, and its answer.

When Claude wants to do something that needs your approval, such as running a command
or editing a file, you get the question with buttons. One tap answers it. `/mode`
sets how much it asks before acting.

A few things to try next:

- **A voice note.** Talk instead of typing, if you turned voice on.
- **`/btw` while Claude works**, to ask a side question without stopping it.
- **`/steer`**, to stop the turn and send a correction instead.
- **`/model` and `/effort`**, to switch model and reasoning effort.
- **`/commands`**, for everything else. [Commands](../reference/commands.md) has them all.

## 5. Turn on threads

With threads, every thread in the chat is its own Claude session. You can run several
tasks side by side and switch between them like chats, and `/fork` and `/spinoff` open
their branches in new threads. Without threads, the chat is one conversation at a time.

Telegram doesn't let a bot turn threads on for itself, so it's one switch for you:

1. Open [@BotFather](https://t.me/BotFather) and tap **Open** to start its Mini App.
2. Pick your bot.
3. Turn on **Threaded Mode**.

<!-- screenshot: Threaded Mode in BotFather's Mini App -->

Then send the bot `/restartbot` so it picks up the change. (Bots made with `/newbot`
notice by themselves within a minute.) From then on, start a new thread to start a new
session. Threads are named after what they're about.

**Or use a group with topics.** Make a group, turn on *Topics* in its settings, and add
your bot as an admin, so it sees every message and not just the ones that mention it.
Each topic is then a session. In `~/.telecoder/.env`, add the group's ID (a negative
number starting with `-100`; Telegram Web shows it in the address bar) to
`ALLOWED_GROUP_IDS`. In a group the bot only answers messages that @mention it, so
that people can talk among themselves. In a group that's just you, set
`GROUP_REQUIRE_MENTION=false` as well. Then restart with `telecoder service restart`.
A group is also how you share a bot with others: see
[Sharing a bot](../guides/sharing.md).

## Where next

- [Features](../guides/features.md): everything TeleCoder does.
- [Multiple bots](../guides/multiple-bots.md): a bot per project, from one process.
- [Configuration](../reference/configuration.md): every setting in `.env`.
- [Troubleshooting](../help/troubleshooting.md): when the bot doesn't answer.
