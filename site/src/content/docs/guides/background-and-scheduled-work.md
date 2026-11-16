---
title: Background and scheduled work
description: Follow background tasks and monitors from Telegram, and run prompts on a schedule.
sidebar:
  order: 8
---

## Background tasks

When Claude starts something in the background (a long build, a subagent, a monitor that
watches a log), you see it in the chat: one card, **📡 Background
activity**, that updates in place: what's running and for how long, and what just
happened. It moves to the bottom of the chat, so your phone notifies you, when a monitor
fires, something fails, or a long task finishes. In the turn's own log, a shell command Claude
sends to the background shows **Running in the background** where its output would be, the
line Claude Code's terminal shows under the call.

- **`/tasks`** lists the background tasks, with details per task. **📄 Output**
  on a task shows what it has printed so far, the way Enter on a task in Claude Code's own
  `/tasks` does, and **🔎 Ask claude** shows Claude Code's own list, with a button per row
  that opens that row's output. That list also covers work the bot never saw start, such
  as a shell Claude backgrounded on its own or anything from before the bot's last restart.
- **`/shells`** lists the background processes and stops them.

When a background task reports back, Claude can pick it up by itself, and its answer
arrives like any other reply.

## Scheduled prompts

```
/schedule daily 9am check the overnight CI runs and summarise failures
/schedule every 30m is the deploy finished? Tell me when it is
/schedule mon,fri 17:00 -- update the changelog --label "changelog"
```

When it fires, the prompt goes into the thread's current conversation, under a
**🔔 Scheduled** header, and the reply streams in as usual.

- **When**: `every <N>m` (or `s`, `h`, `d`), `daily`, `weekdays`, `weekends` or days like
  `mon,wed,fri` followed by a time, or a five-field cron expression. Times are the
  machine's local time.
- **Options**: `--max-runs N` (default 50, at most 500) and `--label "..."`.
- **Limits**: at least a minute apart, and 10 per thread. A schedule turns itself off
  after three failures in a row.
- **`/schedules`** lists them; **`/unschedule <id>`** removes one.

Schedules survive restarts, but fires missed while the bot was down aren't made up. A fire
that comes due while Claude is busy waits its turn.

Claude can schedule prompts too: ask it to *"check this every hour"*, and the
schedule shows up in `/schedules` like your own.

## Unattended jobs

A command that needs your approval still asks, even in a scheduled turn, and the turn waits
for your tap. For a job made of many guarded commands, `/autoapprove 2h` answers those
questions in advance for up to four hours. Destructive commands, such as wiping a disk or
dropping a database, ask regardless.
