---
title: Multiple bots
description: Run a bot per project from one process with instances.json, /newbot and a home project per bot.
sidebar:
  order: 4
---

One launcher can run several bots, each in its own worker with its own sessions and
preferences. That lets you keep separate conversations going, and hand one from bot to bot
with `/fork`.

List the bots in an `instances.json` next to your `.env`: `~/.telecoder/instances.json`
for an npm install, or the checkout's root when running from source. Each bot gets its token
and any settings that differ from the shared `.env`; the annotated
[`instances.json.example`](https://github.com/telecoderbot/telecoder/blob/main/instances.json.example) (also in the npm package) shows the
format, including a list of tokens that becomes numbered bots.

```bash
# npm install
cp "$(npm root -g)/telecoder/instances.json.example" ~/.telecoder/instances.json
telecoder start            # runs every bot in instances.json when there is one
                           # (--single or --multi to choose); the service does the same

# source checkout
cp instances.json.example instances.json   # gitignored
npm run dev:multi                          # or, after a build: npm run start:multi
```

The launcher keeps watching `instances.json` while it runs. Add a token and that bot
starts; take one out and it stops; change a bot's token or settings and only that bot
restarts, picking its sessions back up. The rest carry on. A file that doesn't parse, or
lists no bots, is ignored until it's fixed, so a half-saved edit takes nothing down.

A bot can also create bots, so a new one for a project costs a tap rather than a
BotFather chat. Turn on Bot Management Mode for one bot in [@BotFather](https://t.me/BotFather)'s
Mini App, then send it `/newbot <project>`, or ask Claude for a bot for a project in
a private chat with it. It offers a button that opens Telegram's
create-a-bot screen with a name and username filled in; once you confirm, it fetches the
new bot's token, restricts the bot to you, gives it the TeleCoder icon as its profile
picture, and adds it to `instances.json` with
`HOME_PROJECT` set, which the launcher picks up. A bot with a `HOME_PROJECT` starts
conversations there without a `/project` first, and leaves that project out of its thread
names and its display name. Telegram has no API to turn on threads for a bot, so for a
bot with threads, turn on Threaded Mode for it in the same Mini App: the new bot sends
you the steps with your first message, and says so once they're on. `/newbot` rewrites
`instances.json`, so it refuses a file with `//` comments rather than lose them.

## A home project per bot

`HOME_PROJECT` ties a bot to one project, which suits a bot per project. Set it in that
bot's entry in `instances.json` (`/newbot` does), as an absolute path or one relative to
`WORKSPACE_DIR`. See [Configuration](../reference/configuration.md#core).
