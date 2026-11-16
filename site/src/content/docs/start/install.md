---
title: Install and run
description: Prerequisites, the setup wizard, the background service, and running from source.
sidebar:
  order: 2
---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| **Linux or macOS** | Windows isn't supported natively: the permission hook, restarts (systemd or a bash script) and process tracking (`/proc`) assume a Unix system. WSL 2 is Linux underneath, so it should work there as on Linux, but that is untested. |
| **Node.js 22+** | with npm. TeleCoder refuses to start on anything older. |
| **A C++ toolchain** (Linux) | `node-pty` is compiled during `npm install` on Linux, which needs `python3`, `make` and `g++`: `sudo apt install python3 make g++` (Debian, Ubuntu) or `sudo dnf install python3 make gcc-c++` (Fedora, RHEL). macOS uses a prebuilt binary. |
| **Claude Code CLI, logged in** | Install it with `curl -fsSL https://claude.ai/install.sh \| bash` (it goes in `~/.local/bin`; log in again if that isn't on your `PATH` yet) and run `claude` once and `/login`, as the user the bot will run as. For a machine you won't sign in on, `claude setup-token` makes a long-lived token to put in `CLAUDE_CODE_OAUTH_TOKEN`; an `ANTHROPIC_API_KEY` works too, billed per use. The bot warns at startup if it finds no login, and replies with how to log in if a message fails on it. |
| **Telegram bot token** | from [@BotFather](https://t.me/botfather) |
| **Your Telegram user ID** | the number, not your @username. `telecoder init` finds it when you message your bot; by hand, message [@userinfobot](https://t.me/userinfobot) |

## Install from npm

```bash
npm install -g telecoder
telecoder init     # or, without installing first: npx telecoder init
```

`telecoder init` checks Node and the `claude` CLI and its login, asks for the
bot token from @BotFather and checks it with Telegram, then has you send the
bot `/start` to learn your user id, so there's no @userinfobot step. It asks
for the folder your projects are in and whether to turn on voice
transcription, and writes `~/.telecoder/.env` (set
`TELECODER_HOME` to keep it somewhere else) with just those settings, readable
by you only. Every other setting stays at its default; `.env.example` lists
them all. Run it again to change an answer. For scripts, the flags
`--token-env VAR`, `--owner-id`, `--workspace` and `--yes`
skip the questions; [the CLI reference](../reference/cli.md#telecoder-init) lists them all.

```bash
telecoder start    # runs every bot in ~/.telecoder/instances.json instead, if there is one
telecoder doctor   # checks Node, the claude CLI and its login, and your config
```

Open your bot in Telegram → `/start`

`/update` installs the latest release; `/rebuildbot` is for source checkouts only.

## Run it in the background

`telecoder start` runs in your terminal and stops with it. To keep the bot running,
start it at boot, and let `/restartbot` restart it from chat (an npm install restarts
by exiting, for its service manager to start it again):

```bash
telecoder service install     # systemd user unit on Linux, LaunchAgent on macOS
telecoder service status      # is it running?
telecoder service logs        # follow its output (--no-follow: the last 100 lines)
telecoder service restart     # also brings it back after a config error stopped it
telecoder service uninstall   # stop it and remove the unit
```

- **Linux** writes `~/.config/systemd/user/telecoder.service` and enables it. The unit
  runs the `node` and `telecoder` it was installed with, from `~/.telecoder` (or
  `TELECODER_HOME`), with a `PATH` that finds `claude` and `git`. It holds no
  secrets — the bot reads its `.env`. It restarts on any exit except a configuration
  error (exit 78: fix the `.env`, then `telecoder service restart`), and
  `systemctl --user stop telecoder` stops it for good. It asks before turning on
  *lingering* (`loginctl enable-linger`), which keeps user services running after you
  log out and starts them at boot; `--yes` answers yes to everything, `--no-linger`
  skips it. Under `sudo -u` it finds the user's systemd manager by itself when one is
  running; when none is (no login and no lingering, as for a service account) it says
  to run `sudo loginctl enable-linger <user>` first. Without a usable `systemd --user`
  at all (a container, WSL without systemd) it prints the unit and other ways to run
  it instead.
- **macOS** writes `~/Library/LaunchAgents/dev.telecoder.telecoder.plist` and loads it;
  output goes to `~/Library/Logs/telecoder/telecoder.log`. A LaunchAgent runs while you
  are logged in. launchd can't exempt one exit code from `KeepAlive`, so under launchd a
  bot stopped by a configuration error exits 0 instead, which it leaves alone. While the
  bot runs it keeps the Mac from idle-sleeping (`caffeinate -i`); the display can still
  sleep, and closing a laptop's lid still sleeps it.

Run `telecoder service install` again after moving `node`, `claude` or your config:
it shows what changes and asks before replacing the unit. `--name <name>` installs a
second one side by side, and `--dry-run` prints the file without writing anything. An
`npx telecoder` isn't installed anywhere lasting, so install it with
`npm install -g telecoder` first. A source checkout is run with
[the bot control script](../reference/architecture.md#bot-control-script) or `npm start` as before;
`node dist/cli.js service install --from-checkout` installs a unit for it anyway.

## From source

```bash
git clone https://github.com/gitaarik/telecoder.git
cd telecoder
cp .env.example .env
```

Edit `.env` — a `.env` or `instances.json` next to `package.json` is used instead of `~/.telecoder`:

```bash
TELEGRAM_BOT_TOKEN=your_bot_token
ALLOWED_USER_IDS=your_user_id
```

```bash
npm install
npx tsx src/cli.ts doctor   # checks Node, the claude CLI and its login, and your config
npm run dev                 # dev mode with hot reload
```

Open your bot in Telegram → `/start`

## Run the tests

The test suite needs no bot token, Claude login or `.env`:

```bash
npm install
npm test
```
