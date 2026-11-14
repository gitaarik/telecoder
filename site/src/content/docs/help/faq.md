---
title: FAQ
description: Safety, cost, subscriptions and API keys, Windows, and how TeleCoder differs from Claude Code Channels.
sidebar:
  order: 2
---

## Is it safe?

TeleCoder runs Claude Code on your machine, as your user, so Claude can do whatever you
could do in a terminal there. What keeps that in check:

- **Only people you allow can use the bot.** Everyone else gets a refusal, and groups
  you haven't allowed get no reply at all.
- **Claude asks before acting**, as it does in the terminal. The questions arrive as
  buttons, and `/mode` sets how much it asks.
- **There's nothing to break into from outside.** The bot polls Telegram, so there's no
  open port, web server or tunnel.

The bot token is the key: whoever has it can pose as your bot, though they still can't
get past the allowed-users check. Keep it as private as a password. If you share a bot,
run it as its own Unix account; [Sharing a bot](../guides/sharing.md) explains how, and
[Security](../reference/security.md) covers the rest.

## Does Telegram see my code?

What goes through the chat does: your messages, and Claude's replies, including any
code in them. Chats with bots aren't end-to-end encrypted. Your repository itself stays
on your machine, and Claude reads it there. [Security](../reference/security.md#what-it-stores-and-sends)
lists exactly what goes where.

## What does it cost?

TeleCoder is free and open source (MIT). Claude's usage counts against your Claude plan
or API key, the same as when you use Claude Code in a terminal. `/cost` shows your
usage limits or spend, as Claude Code reports them.

## Subscription or API key?

Either. If you've logged in to Claude Code with `/login`, TeleCoder uses that login, so
a Pro or Max plan works. An `ANTHROPIC_API_KEY` works too, billed per use. With
[Claude Code Router](../guides/providers.md) you can also route to other model
providers, for example when your plan's limit runs out.

## SDK or PTY mode?

SDK mode, the default, talks to Claude through the Agent SDK. It's lighter and simpler.
PTY mode drives the real `claude` terminal app behind the scenes, so everything that
works in your terminal works in Telegram too: your `CLAUDE.md`, settings, skills,
plugins and slash commands. Switch with `/method`. [Providers](../guides/providers.md)
compares the two.

## Does it work on Windows?

Not natively: parts of it assume a Unix system. WSL 2 is Linux underneath, so it should
work there as on Linux, but that's untested. Linux and macOS are supported. Once it's
running, you can of course use it from Telegram on any device, Windows included.

## Why not Claude Code Channels?

Claude Code Channels, the official
Telegram and Discord plugin, pushes chat messages into a Claude Code session you
started in a terminal. It's a good fit for nudging one running session. TeleCoder
starts and keeps its own sessions, so you get as many as you have threads, plus forks,
resume, voice and the full set of commands.

**Remote Control** lets you look in on a terminal session from the Claude app. Use it
when you want the session you already have, on Anthropic's own UI.

## Can I use it from several devices?

Yes. It's an ordinary Telegram chat, so it's on every device you're signed in to
Telegram on, with drafts and history synced between them.

## Is it affiliated with Anthropic or Telegram?

No. TeleCoder is an independent project. It began as a fork of
[Claudegram](https://github.com/NachoSEO/claudegram) and has been developed separately
since April 2026.
