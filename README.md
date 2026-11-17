<div align="center">

# TeleCoder

**Claude Code in Telegram.** The real agent runs on your machine; you drive it from Telegram's
native apps, with a thread per conversation, forks and the full CLI.

[![CI](https://github.com/gitaarik/telecoder/actions/workflows/ci.yml/badge.svg)](https://github.com/gitaarik/telecoder/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/telecoder?color=cc785c)](https://www.npmjs.com/package/telecoder)
[![Node](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

[Website](https://telecoder.dev) · [Quick start](#quick-start) · [Features](site/src/content/docs/guides/features.md) · [Commands](site/src/content/docs/reference/commands.md) · [Docs](#documentation) · [Changelog](CHANGELOG.md)

</div>

<!-- Demo GIF goes here: a thread, a fork into a new thread, a permission prompt, a voice note. -->

---

## Why TeleCoder

Claude Code is at its best when you can reach it from anywhere. Browser UIs get you there, but
they're web pages on a phone. Telegram already has fast, polished apps for Android, iOS, macOS,
Windows and Linux, with keyboard shortcuts, offline drafts, notifications and voice notes.
TeleCoder puts Claude Code inside them.

- **Native apps, not a web page.** Every device you own already runs a fast Telegram client.
  The bot polls Telegram, so there's no port to open, no tunnel and no web server.
- **A thread per conversation.** Each thread is its own Claude session, in groups and in
  private chats. Start a thread and you have a new session; run five tasks side by side and
  switch between them like chats.
- **Forks.** `/fork` copies the conversation into a new thread; `/spinoff` splits a task off
  with a compacted copy of the context; `/tree` draws the branches and lets you jump between
  them.
- **The full CLI, not a subset.** TeleCoder drives the real `claude` TUI, so a project's
  `CLAUDE.md`, settings, skills and slash commands work as they do in your terminal, and its
  permission dialogs arrive as buttons. `/model`, `/effort`, `/compact`, `/context`, `/cost`
  and `/resume` are there too.
- **Claude can reach you.** It can ask with buttons, send you files, ask for an API key
  (your message is deleted the moment it arrives), schedule prompts, and report background
  tasks as they finish.
- **Built for working away from your desk.** Send voice notes as prompts. `/btw` asks
  a side question without stopping the task, `/steer` corrects it mid-turn, and `/later` sets
  an idea aside for when Claude is done. Sessions carry on by themselves after a restart.
- **More than one bot.** Run a bot per project from one process, and make a new one from
  chat with `/newbot`, without a BotFather conversation.
- **Shareable, carefully.** Admins, guests and approvers, a permission gate on every
  tool call, a scope guard for paths, and a charter checked before a guest's message runs.

The full list is on the [Features](site/src/content/docs/guides/features.md) page.

## How it compares

- **Claude Code Channels** (the official Telegram and Discord plugin) pushes chat messages
  into a Claude Code session you started in a terminal. It's a good fit for nudging one running
  session. TeleCoder starts and keeps its own sessions, so you get as many as you have
  threads, plus forks, resume, voice and the commands above.
- **Remote Control** lets you look in on a terminal session from the Claude app. Use it when
  you want the session you already have, on Anthropic's own UI.
- **[claude-code-telegram](https://github.com/RichardAtCT/claude-code-telegram)** is the
  most popular community bot: Python, SDK-based, with cost caps and webhooks. TeleCoder
  drives the full CLI itself, and adds threads, forks and multiple bots.
- **Web UIs** such as [CloudCLI](https://github.com/siteboon/claudecodeui) give you a
  browser dashboard with file trees and diffs. TeleCoder gives up the dashboard for native
  apps, notifications and voice.

## Quick start

You need Linux or macOS, [Node.js 22+](https://nodejs.org/), the
[Claude Code CLI](https://platform.claude.com/docs/en/claude-code) installed and logged in, and
a bot token from [@BotFather](https://t.me/BotFather). On Linux, `npm install` compiles
`node-pty`, which needs `python3`, `make` and `g++`.

```bash
npm install -g telecoder
telecoder init              # bot token, your user ID, projects folder: about two minutes
telecoder service install   # keep it running, and start it at boot
```

`telecoder init` checks the token with Telegram, learns your user ID when you send the bot
`/start`, and writes `~/.telecoder/.env`, readable by you only. Then open your bot in Telegram,
pick a project with `/project` and start talking.

`telecoder doctor` checks your setup, `telecoder service logs` follows the output and `/update`
upgrades from chat. To run from a git checkout instead, see
[Install and run](site/src/content/docs/start/install.md#from-source).

## Documentation

- [Get started](site/src/content/docs/start/get-started.md): a first setup, step by step, from BotFather to threads
- [Install and run](site/src/content/docs/start/install.md): prerequisites, the wizard, the background service, running from source
- [Features](site/src/content/docs/guides/features.md): everything TeleCoder does
- [Commands](site/src/content/docs/reference/commands.md): every bot command
- [Multiple bots](site/src/content/docs/guides/multiple-bots.md): `instances.json`, `/newbot` and a home project per bot
- [Providers](site/src/content/docs/guides/providers.md): Claude Code Router for when Max throttles
- [Sharing a bot](site/src/content/docs/guides/sharing.md): admins, guests, group roles, the permission gate and a separate Unix account
- [Configuration](site/src/content/docs/reference/configuration.md): every `.env` setting
- [Security](site/src/content/docs/reference/security.md): what's protected, what's stored and where data goes
- [Architecture and development](site/src/content/docs/reference/architecture.md): how it's built, and how to work on it
- [Troubleshooting](site/src/content/docs/help/troubleshooting.md) and [FAQ](site/src/content/docs/help/faq.md)
- [Roadmap](ROADMAP.md), [changelog](CHANGELOG.md) and [contributing](CONTRIBUTING.md)

## Project status

In active development, and used every day for my own work, including building TeleCoder
itself. The latest release is 1.2.0, on [npm](https://www.npmjs.com/package/telecoder) and
tagged here; the [changelog](CHANGELOG.md) lists what's in each release. The code is about
51k lines of TypeScript, plus 33k lines of tests (189 test files, 2,437 tests), and CI runs
the type check, tests and build on every push.

TeleCoder is self-hosted: it runs on your machine with your own Claude account, and there is no
hosted version.

## Credits

TeleCoder began as a fork of [Claudegram](https://github.com/NachoSEO/claudegram) by
[@NachoSEO](https://github.com/NachoSEO), MIT-licensed, whose last commit was in March 2026.
Claudegram's copyright notice is kept in [LICENSE](LICENSE). Since April 2026 TeleCoder has
been developed independently by [@gitaarik](https://github.com/gitaarik): 550+ commits, adding
about 133k lines and removing 43k. The history since the fork is all in this repository, which
was created in July 2026 when the project was renamed, so its GitHub creation date is later than
its first commits.

TeleCoder is an independent project, not affiliated with or endorsed by Anthropic or Telegram.

## License

MIT
