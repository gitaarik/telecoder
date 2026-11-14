---
title: The telecoder CLI
description: Every telecoder command and flag, for setup, checks and the background service.
sidebar:
  order: 3
---

```bash
telecoder <command> [options]
```

`telecoder` with no command, `telecoder help` or `--help` lists the commands. `--help` after a
command shows its one-line summary. `telecoder --version` (or `-v`) prints the version.

## `telecoder init`

The setup wizard. It checks Node and your Claude login, then asks for the bot token (and
checks it with Telegram), your Telegram user ID (send the bot `/start`), your projects
folder, SDK or PTY, voice and Telegraph. It writes `~/.telecoder/.env`, readable by you only,
and offers to install the service.

Run it again to keep, edit or replace your setup; the old file is backed up first.

For scripts, these flags answer the questions. Secrets come from environment variables, never
from arguments, because arguments show up in `ps`:

- `--token-env VAR`: the bot token, from the variable `VAR`
- `--owner-id ID`: your Telegram user ID
- `--workspace DIR`: your projects folder
- `--transport sdk|pty`
- `--groq-key-env VAR`: a Groq key for voice
- `--telegraph`, `--no-telegraph`
- `--no-test-message`: don't send the hello message
- `--yes`, `-y`: accept the defaults, and replace an existing `.env` (after backing it up)

## `telecoder start`

Runs the bot in the foreground, until Ctrl+C. If `~/.telecoder/instances.json` exists, it
runs every bot in it ([Multiple bots](../guides/multiple-bots.md)).

- `--single`: just the bot in `.env`, even if `instances.json` exists
- `--multi`: the multi-bot launcher
- `--config <file>`: the launcher, with another instances file

## `telecoder doctor`

Checks Node, the TeleCoder install, the config (`.env` or `instances.json`, tokens, allowed
users), the `claude` CLI and its login, and whether `node-pty` loads, and says how to fix
what's wrong. It writes nothing. It exits 1 if something must be fixed first.

- `--live`: also check each bot token with Telegram

## `telecoder service`

Runs TeleCoder in the background: started at boot, restarted when it stops, and restarted
by `/restartbot` from chat.

```bash
telecoder service install     # install and start it
telecoder service status      # is it running?
telecoder service logs        # follow its output
telecoder service restart     # restart it, also after a config error stopped it
telecoder service uninstall   # stop it and remove it
```

- **Linux**: a systemd user unit, `~/.config/systemd/user/telecoder.service`. Install asks
  to turn on lingering, so the bot keeps running after you log out.
- **macOS**: a LaunchAgent, `~/Library/LaunchAgents/dev.telecoder.telecoder.plist`, logging
  to `~/Library/Logs/telecoder/telecoder.log`.

The service holds no secrets: the bot reads its `.env`. If you reinstall or move `node` or
`claude`, run `install` again; it shows what changed before replacing the unit.

Options:

- `--name <name>`: a service with another name, to run several side by side (default
  `telecoder`)
- `--yes`, `-y`: answer yes to the questions
- `--no-linger`: don't turn on lingering (Linux)
- `--dry-run`: show what install would write, and change nothing
- `--no-follow`: `logs` prints the last 100 lines and stops
- `--from-checkout`: install from a source checkout instead of an npm install

## Where the config lives

- **`~/.telecoder/`** holds `.env`, `instances.json` and the bot's state.
- **`TELECODER_HOME`** moves the config (not the state) elsewhere.
- **`TELECODER_ENV_PATH`** and **`TELECODER_INSTANCES_CONFIG`** point at one file each.
- In a source checkout, a `.env` next to `package.json` is used instead.

Every setting is in [Configuration](configuration.md).
