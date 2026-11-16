# Rules for every demo video

These hold for all videos. A scene's own storyboard is in `scenes/<name>.md`, next
to its script `scenes/<name>.mjs`. Change the rule or the storyboard first, then the
script, so a rerun gives about the same video.

Claude's answers differ from run to run, so the wording on screen changes a little
each time. The beats, the look and the order do not.

## Look

- **Split screen.** Telegram on the left. On the right the terminal or the browser,
  never both at once.
- **No empty margin.** The picture is only as large as the two panes need.
- **Readable text.** Telegram's text is about as large as the terminal's.
- **No flicker.** A new message appears as one clean change. `compose.mjs` steadies
  Telegram Web's redraws; check the result with `measure.sh` and by eye.
- **A visible mouse cursor** that moves at a person's speed to whatever gets clicked.
- **Typing at a person's speed**, in Telegram and in the terminal.
- **No clutter.** No unread badges, no notification banners, no leftovers from earlier
  runs, no contacts section.
- **Threads sit in a column on the left** of the chat, not at the top or bottom.
  Telegram Web shows that from 926 px, so a video with threads uses the wide layout
  (`wide: true`: Telegram 940 px, right pane 920 px, picture 1920x1040).

## World

- **One project: Mealplan**, a recipe site with a shopping list. Its owner is Alex,
  and the terminal prompt reads `alex@home`.
- **The bot is called TeleCoder** and has the TeleCoder icon.
- **Nothing personal on screen.** No real names, handles, phone numbers or contacts.
- **Auto mode.** That is how most people work. Only "first task" shows an approval,
  once: the `git push` question, answered with one tap.
- **Tokens.** A token may be on screen only when its bot is deleted right after the
  take. The standing demo bot's token never is.

## Edit

- **One feature per video**, and as short as it can be while every step is readable.
- **Waiting is cut.** Installs, Claude thinking and page loads are shortened.
- **Time to read.** A question or an answer stays up long enough to read it.

## Process

- **One video at a time.** Rik reviews each before the next is started.
- **A scene checks itself.** If a step did not happen (no push, no reply, wizard
  stuck), the run fails instead of producing a wrong video.
- **The browsers can run on a temporary box.** This machine is short of memory.
  `node box.mjs up` rents a Hetzner box, `DEMO_BOX=1 node scenes/<name>.mjs` records
  with its browsers, `node box.mjs down` deletes it. Always delete it when a recording
  session ends: it bills for as long as it exists. The box is labelled
  `telecoder=demo-videos` and nothing without that label is touched.
- **Rehearse cheaply.** BotFather allows about five new bots a day, so `setup` is
  rehearsed with `SETUP_BOT=<existing bot>` and a real bot is made only for the final
  take.

## The videos

| # | Scene | Status |
|---|---|---|
| 1 | `setup`: from nothing to a first conversation | rehearsed, in review; real take open |
| 2 | `first-task`: a task, one approval, the result | recorded, approved for now |
| 3 | threads and forks, `/tree` | to do |
| 4 | `/spinoff` | to do |
| 5 | `/btw` and `/steer` | to do |
| 6 | voice note | to do |
| 7 | files: a photo in, a shopping list and screenshot out | to do |
| 8 | `/schedule`: the Sunday list | to do |
| 9 | a form of questions (`ask_user`) | to do |
| 10 | desk to phone, `/teleport` | to do |

## Where things stand (2026-11-16)

- **`setup`** is rehearsed with the standing demo bot and under review by Rik.
  The last rehearsal is on the preview site. Since that take the product
  changed: the wizard no longer asks SDK or PTY, nor about Telegraph, one line
  of its text was reworded, and Claude Code now starts when the project is
  chosen. Rehearse again, update `scenes/setup.md` to what the wizard now
  asks, then do the real take with a fresh bot (it shows `/newbot` and the
  token, and deletes the bot).
- **`first-task`** is approved "for now". Rik wants the real Claude Code screen
  beside Telegram in it; `telecoder watch` in the terminal pane can do that.
  Update `scenes/first-task.md` first. It is still in the narrow layout.
- **Videos 3 to 10** are not started. Each needs a storyboard first.

## Open questions

- Threads: Telegram Web's list column (what the videos show now), or the look
  of Telegram Desktop's narrow strip, which would mean recording Desktop.
- Is the 12 px terminal text at the end of `setup` readable enough?
- Keep recording on the temporary box, or on this machine?
- Should every video use the wide layout, so they all look the same?
- Captions.
