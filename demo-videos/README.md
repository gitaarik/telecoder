# Demo videos

Scripted recordings of TeleCoder for telecoder.dev, so a video can be remade
after an update instead of recorded by hand. Not part of the npm package.

Read these in order before changing anything:

1. `RULES.md`: the look, the world, the process, the list of videos, and what
   is still open. Review notes from Rik go there first.
2. `scenes/<name>.md`: one storyboard per video, beside its script
   `scenes/<name>.mjs`. Change the storyboard before the script.
3. `NOTES.md`: what was learned the hard way about Telegram Web, BotFather,
   the test user and the recorder. Add to it when something costs you an hour.

## How it works

- Each pane is a Playwright Firefox page recorded on its own: Telegram Web
  (logged in as the demo account), a terminal (`lib/term-server.mjs`, xterm.js
  on a real shell of the demo user) and the demo app.
- A scene script drives them through `lib/stage.mjs` and logs when each step
  happened (`out/<scene>/log.json`), with marks and cuts.
- `compose.mjs` lays the panes out with ffmpeg, cuts the waiting and steadies
  Telegram Web's redraws. Result: `out/<scene>/video.mp4`.

| File | What it is |
|---|---|
| `lib/stage.mjs` | panes, marks, cuts, `show('terminal'\|'app')`, the demo user's shell |
| `lib/telegram.mjs` | `send`, `tapButton`, waits for replies, `onlyChats`, `hideHistory`, the CSS that hides clutter |
| `lib/botfather.mjs` | create, configure and delete bots through BotFather and its Mini App |
| `lib/cursor.mjs` | the drawn mouse cursor and its human-speed glide |
| `lib/browser.mjs` | local Firefox, or the temporary box's when `DEMO_BOX=1` |
| `lib/term-server.mjs` | the terminal pane |
| `box.mjs` | `up`, `status`, `down`: a temporary Hetzner box for the browsers |
| `measure.sh <video>` | counts redraw bursts left in a composed video |
| `login.mjs`, `check-login.mjs` | log the demo account in by QR, and verify it |
| `create-bot.mjs`, `new-token.mjs`, `bot-settings.mjs`, `set-botpic.mjs`, `start-bot.mjs` | one-off chores on the demo bot |
| `spike.mjs` | the first trial; kept as the smallest working example |

## What it needs on the machine

None of this is in the repo, and a fresh checkout cannot record without it.

- **The demo user**, Unix user `telecoder-test`, reached with passwordless
  `sudo -u telecoder-test`. It holds the demo project `~/mealplan` (port 4321,
  bare remote `~/git/mealplan.git`, tag `demo-start` to reset to), a TeleCoder
  install with its `~/.telecoder/.env`, and the `telecoder.service` user unit.
- **The demo Telegram account**, a separate account on its own SIM. Its
  logged-in browser profile is `.session/profile` (gitignored). `node
  check-login.mjs` verifies it; `node login.mjs` logs in again by QR, which
  needs Rik's phone.
- **The demo bot** @telecoder_demo_bot, owned by the demo account. Its token is
  only in `.session/bot-token` (0600) and in the demo user's `.env`.
- **For the box:** the `hcloud` CLI and a token in `~/.config/tools/hcloud.env`
  (or `HCLOUD_TOKEN`).
- `npm install` here. Playwright is pinned to 1.64.0 to match the installed
  Firefox build.

## Recording a scene

```sh
node check-login.mjs                       # the demo account is still logged in
node box.mjs up                            # optional: browsers on a temporary box
DEMO_BOX=1 node scenes/<name>.mjs          # or without DEMO_BOX, on this machine
./measure.sh out/<name>/video.mp4
node box.mjs down                          # always, the box bills while it exists
```

A take runs for several minutes: start it in the background, and never two at
once. A scene checks itself and fails rather than producing a wrong video.
Look at frames of the result before sending it (`ffmpeg -ss <t> -i video.mp4
-frames:v 1 f.png`), then send it to Rik and put it on the preview site (the
site's deploy script lives outside this repo and publishes `out/*/video.mp4`
under `/videos/`).

`node compose.mjs out/<name> --cut from-to` (ms) rebuilds a video from a take
without recording again.

### The setup scene

```sh
SETUP_BOT=telecoder_demo_bot TELECODER_PKG='~/telecoder-wip.tgz' node scenes/setup.mjs
```

- `SETUP_BOT` makes it a rehearsal: no `/newbot`, the standing demo bot is
  used. BotFather allows about five new bots a day, so only a final take runs
  without it. A final take shows the new bot's token, and deletes the bot.
- Before a rehearsal, remove the demo bot's picture (Bot API
  `removeMyProfilePhoto`), or the wizard does not ask the icon question.
- `TELECODER_PKG` makes the typed `npm install -g telecoder` install a package
  file from the demo user's home. Needed while the scene shows features that
  are not on npm yet. Build it from a copy of the repo, never in the working
  tree: copy `git ls-files` to a scratch folder, symlink `node_modules`,
  `npm run build && npm pack`, pipe the `.tgz` to the demo user. Start from a
  clean copy each time, or files deleted in the repo linger in the package.
- The scene parks the demo user's real config in `~/.telecoder.keep` and
  restores it at the end. After a run that died: `node scenes/setup.mjs --restore`.

## Never

- Never commit or print `.session/`. It holds the demo account's login and the
  bot token.
- Never show the standing demo bot's token, and never screenshot BotFather's
  chat or its Mini App bot page unredacted: both print tokens.
- Never screenshot the demo account's chat list without `onlyChats` and the
  clutter CSS applied. It can show real contacts.
- Never touch a Hetzner resource without the label `telecoder=demo-videos`.
  The project is shared with other things.
