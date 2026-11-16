---
title: Threads and forks
description: A Claude session per thread, forks to try another approach, and the tree that keeps track of the branches.
sidebar:
  order: 2
---

## A session per thread

Every thread is its own Claude session, with its own project, model and settings. Run
several tasks side by side and switch between them like chats; they don't wait for each
other. The main chat, outside any thread, is a session of its own too.

Two ways to get threads:

- **A private chat with Threaded Mode.** Turn it on for your bot in
  [@BotFather](https://t.me/BotFather)'s Mini App, then send `/restartbot`.
  ([Get started](../start/get-started.md#5-turn-on-threads) has the steps.)
- **A group with topics.** Each topic is a session. Handy for
  [sharing a bot](sharing.md).

A new thread starts a new conversation. On a bot with a home project (every bot made with
`/newbot`) it starts there; otherwise pick one with `/project` first.

### Thread names

In private chats the bot names each thread after what it's about, as
`project · topic`, and renames it as the topic changes (at most once a minute). A name you
type yourself is never overwritten. Group topics keep the names you give them.

The topic comes from a quick Haiku call on each message. Turn that off with
`AUTO_TOPIC_HAIKU=false`, or set the topic yourself with `/topic`.

## Forks

A fork copies the conversation up to some point into a new session. The original carries
on unchanged.

- **`🍴 Fork` under a reply** forks from that reply. Every reply ends with one, including
  a reply to a background task that reported back between your messages.
- **`/fork`** forks from where the conversation is now.

With threads on, the fork opens straight away in a new thread named `🍴 project · topic`,
starting with a banner that recaps where it picks up. Without threads, you choose between
a **new branch here** (your current conversation goes to `/resume`) or handing the fork
to one of your [other bots](multiple-bots.md), which gets an offer to accept it.

A message you send while Claude is busy gets a **`🍴 Ask in a fork`** button: it asks in
a fork of the conversation as it was before the running turn, so you don't have to wait.

## Spinoffs

```
/spinoff write the migration for the new settings table
```

`/spinoff` splits a task off into a new thread. The new thread compacts the conversation
around that task, then starts on it, while this thread carries on. Send it as a reply to
one of the bot's messages to spin off from that earlier point. Spinoffs need threads.

## The tree

`/tree` draws the conversation's branches:

```
🌳 webapp — 3 branches
A Add a dark mode toggle ·4
├ B Use CSS variables ·2 ▸
└ C Use a theme provider ·3
  └ D Persist the choice ·1 📍
```

Tap a letter to open that point, then:

- **▶️ Carry on this branch**, at a branch end. If the branch lives in another chat or
  bot, you carry on a copy and the original stays as it is.
- **🌱 New branch from here**, at any point.

These load in the current chat, replacing its conversation (which goes to `/resume`).
Only `🍴 Fork`, `/fork` and `/spinoff` open new threads.

## Getting back to earlier work

- **`/resume`** lists every Claude Code session for the project, including ones you
  started in a terminal. Add words to search, or `🌐 All projects` to look wider.
- **`/recap`** re-sends the last few exchanges in full.
- **`/prompts`** lists your prompts, and branches from any of them.
- **`/teleport`** gives you the `claude --resume` line to carry on in a terminal.
- **`/clear`** starts fresh in the same project. The old conversation stays in `/resume`.

## Deleting a thread

`/deletethread`, sent inside a thread, deletes it with all its messages and ends its
session, stopping a turn that's still running. The conversation stays on disk, so
`/resume` in any chat can still pick it up. `/deletethread -y` skips the confirmation.

Deleting a thread from Telegram's own menu works too, but Telegram doesn't tell the bot.
TeleCoder notices the first time it tries to send something into the thread, and ends the
session then. A thread deleted while idle sends nothing, so its `claude`
process is ended once it has been idle for an hour (`CLAUDE_PTY_IDLE_TIMEOUT_MS`), as is
any other idle session's. That costs the next message there a few seconds while the
conversation resumes, and nothing else. A session with a turn, a background task or a
background shell still running is left alone.
