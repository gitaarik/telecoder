---
title: Troubleshooting
description: What to check when the bot doesn't answer, Claude isn't logged in, the install fails or Telegram reports a conflict.
sidebar:
  order: 1
---

Start with `telecoder doctor`. It checks Node, the `claude` CLI and its login,
`node-pty`, your config and the bot token, and says what to do about anything that's
wrong. `telecoder service logs` shows what the bot itself is doing.

## The bot doesn't answer

Work down this list:

1. **Is it running?** `telecoder service status`, or look for the process if you
   started it another way. Send `/botstatus` (or `/ping`): a running bot answers straight
   away, even in the middle of a task.
2. **Does it know you?** If your ID isn't allowed, the bot replies *"You are not
   authorized"* with your Telegram ID. Add that ID to `ALLOWED_USER_IDS` in
   `~/.telecoder/.env` and restart. (`telecoder init` does this for you, using the
   account that sent `/start`.)
3. **In a group, did you address it?** In groups the bot ignores messages that don't
   @mention it, unless `GROUP_REQUIRE_MENTION=false`. A group that isn't in
   `ALLOWED_GROUP_IDS` gets no reply at all, on purpose.
4. **Is it busy?** A message sent while Claude is working waits until the turn is done.
   `/botstatus` shows whether Claude is working on a reply, `/btw` asks something without
   waiting, and `/cancel` stops the turn and drops what's queued behind it.
5. **What does the log say?** `telecoder service logs`. A login problem, a config error
   or a polling conflict each leave a clear line there; they're covered below.

## Claude isn't logged in

If Claude Code on the bot's machine isn't logged in, the bot replies with how to log
in instead of an answer. Log in **as the user the bot runs as**:

```bash
claude        # then /login, and finish the setup if it asks
```

For a machine you won't sign in on, `claude setup-token` makes a long-lived token. Put
it in `CLAUDE_CODE_OAUTH_TOKEN` in `~/.telecoder/.env`. An `ANTHROPIC_API_KEY` works
too, billed per use.

If `claude` works in your terminal but not for the service, the service may not find
the same `claude`. The unit records where `node` and `claude` were when you installed
it, so after moving or reinstalling either, run `telecoder service install` again. It
shows what changed before replacing anything.

## The bot stops when I log out (Linux)

systemd stops a user's services when their last session ends, unless *lingering* is
on. `telecoder service install` offers to turn it on; if you skipped that:

```bash
loginctl enable-linger "$USER"
```

Lingering also starts the bot at boot, before anyone logs in. On macOS the
LaunchAgent runs while you're logged in.

## The install fails building node-pty

On Linux, `npm install` compiles `node-pty`, which TeleCoder uses to drive the
`claude` terminal app. It needs `python3`, `make` and a C++ compiler:

```bash
sudo apt install python3 make g++        # Debian, Ubuntu
sudo dnf install python3 make gcc-c++    # Fedora, RHEL
```

Then install again with `npm install -g telecoder`. On macOS, run
`xcode-select --install` if the prebuilt binary doesn't load. `telecoder doctor`
says which tools are missing.

## "Conflict: terminated by other getUpdates request"

Telegram lets only one program poll a bot token at a time. When a second one does,
Telegram answers with a 409 conflict.

Right after a restart that's normal: the old process's connection takes a moment to
close, and TeleCoder waits and retries for about two minutes before giving up. If the
conflict lasts, something else really is polling the same token. Common causes:

- `telecoder start` running in a terminal while the service runs too.
- The same `.env` on another machine.
- Two entries in `instances.json` with the same token.
- Another bot framework you tried with this token earlier.

Stop the other one, or give each bot its own token.

## A config error stopped the service

If the `.env` has an error, the bot exits with a message saying what's wrong, and on
Linux the service doesn't restart in a loop. Fix the `.env`, then:

```bash
telecoder service restart
```

## Still stuck?

See [where to ask](index.md).
