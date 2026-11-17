---
title: Why I built TeleCoder
description: Claude Code is best when you can reach it from anywhere, and Telegram already has the best apps for that.
draft: true
---

<!-- DRAFT by Claude, for Rik to rewrite in his own words. draft: true keeps it out of the
production build; it shows in `npm run dev`. Facts to check are marked TODO. -->

*14 November 2026 · Rik Wanders*

I use Claude Code all day. The work it does doesn't need me at my desk: it needs me now
and then, to answer a question, approve a command or point it somewhere else. So I wanted
to reach it from wherever I was.

## Browser UIs weren't it

I tried the web UIs for Claude Code first. They work, but on a phone they're web pages:
slow to load, quick to lose their state, with few keyboard shortcuts on the desktop. When
I tried them, none could fork a conversation. <!-- TODO: which ones, and when (CloudCLI, late 2025?) -->

Meanwhile I already had an app open all day that's fast on every device, keeps drafts in
sync, does notifications and voice notes properly, and has keyboard shortcuts for
everything: Telegram.

## So I put Claude Code in Telegram

In April 2026 I forked [Claudegram](https://github.com/NachoSEO/claudegram), a small bot by
Nacho Mascort that passed Telegram messages to Claude Code. Seven months and a few
hundred commits later, it's become its own thing:

- **A thread per task.** Each Telegram thread is its own Claude session, so I run several
  tasks side by side and switch between them like chats.
- **Forks.** When I want to try another approach, `/fork` copies the conversation into a
  new thread, and `/tree` shows the branches.
- **The official Claude Code.** TeleCoder can drive the real `claude` CLI, so my
  `CLAUDE.md`, skills and slash commands work as in my terminal, and it uses my Claude
  subscription.
- **Working while it works.** `/btw` asks a side question without stopping the task,
  `/steer` corrects it, and a voice note does when typing doesn't.

It runs on my own machine. There's no server: the bot polls Telegram, so nothing is open
to the internet.

## Try it

```bash
npm install -g telecoder
telecoder init
```

[Get started](../start/get-started.md) takes about ten minutes. It's MIT-licensed, and the
code is on [GitHub](https://github.com/telecoderbot/telecoder). I'd like to hear what you think:
<!-- TODO: the Telegram group link -->
