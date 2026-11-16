---
title: Working while Claude works
description: Ask a side question, correct the turn, or set an idea aside, without waiting for Claude to finish.
sidebar:
  order: 3
---

Claude often works for minutes at a time. You don't have to wait for it.

## Ask on the side: `/btw`

```
/btw which file has the retry logic?
```

`/btw` answers a question alongside the running task, without interrupting it. It sees the
conversation so far but can't change files, so it only answers. It works whenever the
thread has a conversation, whether or not a turn is running.

## Correct the turn: `/steer`

```
/steer use the existing date helper instead
```

`/steer` stops the running turn and sends your text in its place. Claude keeps what it had
already done, so the text can be a correction to it. With nothing running, it's an ordinary
message.

## Set an idea aside: `/later`

```
/later also add a test for the empty case
```

`/later` keeps the idea without sending it. When Claude is done, the bot asks
*"You set this aside. Still want to send it?"* with **📤 Send** and **🗑 Drop**. Edit your
message first to change what goes out. `/later` on its own lists what's set aside.
Set-aside messages survive `/cancel` and restarts.

To send it before the question comes, use the buttons on its *🔔 Set aside* notice. While
a turn is running, **⚡ Interrupt & send** stops the turn and sends it now, as `/steer` does.
While nothing is running, **📤 Send now** just sends it. A message set aside with **🔔 Ask me
after** gets the same buttons.

## Messages that have to wait

A message you send while Claude is busy waits for the turn to end, and the bot says so:
*⏳ Queued behind the running turn.* Under that notice:

- **🗑 Take back**: withdraw it.
- **🔔 Ask me after**: set it aside, as `/later` does.
- **💬 Ask as /btw**: ask it on the side instead.
- **🍴 Ask in a fork**: ask it in a fork of the conversation as it was before this turn,
  in a new thread. ([Threads and forks](threads-and-forks.md))
- **⚡ Interrupt & send**: stop the turn and send it now, as `/steer` does.

Editing a waiting message changes what gets sent. To have every new message interrupt the
turn instead, set `CANCEL_ON_NEW_MESSAGE=true`.

## Stopping

`/cancel` (or `/stop`) stops the turn and drops the messages waiting behind it. Set-aside
messages stay. `/ping` answers straight away even mid-turn, so you can tell a busy bot from
a stuck one, and `/status` shows what's running.

## Smaller things

- **Long pastes**: Telegram splits a long message into parts. The bot glues them back into
  one prompt.
- **Suggested next prompts**: the prompt Claude Code predicts you'll send next
  can appear as a `💡` button under the reply. Turn it on with `/suggestions`.
- **Voice notes**: talk instead of typing. See [Voice](voice.md).
