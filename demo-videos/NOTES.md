# Notes: what was learned making these

Know-how that is not obvious from the code. Newest findings at the bottom of
each section.

## Telegram Web (K)

- Selectors: thread rows `.chatlist-chat[data-thread-id]`, input
  `.input-message-input`, inline buttons `.reply-markup-button`, bubbles
  `.bubble.is-in` / `.is-out`.
- Emoji are images: match text without them.
- A reply is done when the status-line message with the Fork button arrives.
  A chat's first status line can be short (`mealplan · Auto`, no model or
  cost); `statusLines` in `lib/telegram.mjs` accepts both.
- Typing in "All Messages" starts a new thread and the view moves into it.
- Typing can lose focus mid-sentence: `send` verifies the box before Enter.
- A deleted thread's row stays until the client is reopened.
- A never-started bot has a START button over the input.
- After moving chats the old chat's input stays in the DOM, hidden: filter on
  visible.
- A reload drops the `#@bot` hash, shows a white page (keep it at least 1.5 s
  inside a cut), and is the only way a bot's new picture shows. `onlyChats`
  must be applied again after every reload.
- A Threaded Mode bot opens on its list of threads; click "All Messages" to
  reach the chat. `goto #@bot` alone leaves the chat pane where it was. Getting
  back from BotFather's chat to the bot's is flaky: `offCamera` in the setup
  scene retries.
- The thread list shows as a column beside the chat only from 926 px width,
  hence the wide layout. Web K and Web A both show a list column, not Telegram
  Desktop's narrow icon strip. A CSS restyle to imitate the strip broke the
  layout.
- Telegram Web redraws the whole chat over several frames when a message
  arrives. `compose.mjs` overlays a still over each burst (`unsteady()`,
  `NO_STEADY=1` turns it off, `STEADY_MIN` sets the sensitivity). In the wide
  layout `measure.sh` is no clean pass or fail any more: check frame strips by
  eye too. The drawn cursor freezes briefly inside a steadied burst.
- The login works from localStorage alone. That is how it travels to the box
  (`telegramState()` in `lib/browser.mjs`); Playwright cannot open a
  persistent profile on a remote browser.
- Never set `layout.css.devPixelsPerPx` on the persistent profile: it is saved
  into the profile and every later video comes out zoomed.

## BotFather

- About five `/newbot` a day per account, then "try again in N seconds" for
  most of a day. Twenty bots per account in total.
- Threaded Mode and Bot Management Mode are only in the Mini App (the iframe
  at `webappinternal.telegram.org/botfather`, opened with the menu button and
  "Launch"). Switch rows are `.tm-row-toggle[data-field]`, on is
  `.tm-toggle-on`.
- The Mini App's bot page prints the token in its body text, and the chat
  keeps the creation message. Never dump or screenshot either unredacted.
- In Firefox the row under Threaded Mode (`.tr-expand`) gets a height of
  2000 px and blanks everything below. `configureOnCamera` caps it with CSS.
- The drawn cursor gets no mouse events over the Mini App iframe; `glide`
  places it directly.
- Hovering a link shows the browser's address pop-up in the recording.
  `lib/cursor.mjs` strips `href` on hover and every 300 ms, and navigates
  itself on a click inside the Mini App. Restoring `href` on mousedown broke
  navigation.
- A rehearsal turns the demo bot's two switches off first and on again at the
  end.
- A wizard-installed bot reads Threaded Mode only at start, hence the restart
  beat in the setup scene.

## The demo user and its bot

- Only `sudo -u telecoder-test` is passwordless. Use `-H bash -lc '...'`;
  `-i bash -c` expands `$vars` twice. Pipe files in with `tee`. Its user
  systemd needs `XDG_RUNTIME_DIR=/run/user/<its uid>`.
- For that user a connection to a closed localhost port times out instead of
  being refused: give every curl probe `-m 1`.
- The demo app must run as `node --watch server.js`, and `resetDemo` must kill
  every old one, or the app pane serves stale pages.
- The approval moment in "first task" comes from an `ask` rule for
  `Bash(git push:*)` in `~/mealplan/.claude/settings.json`. Mealplan's
  CLAUDE.md must say "when I ask you to push, just run git push".
- A fresh user must have run `claude` once interactively (theme, folder trust)
  before a chat works.
- The demo bot's `.env` sets `MEMORY_GUARD_MIN_AVAILABLE_MB=500`, or the
  memory guard asks a question mid-recording when the machine is busy.
- From a shell tool, never `pkill -f` a pattern that matches the shell's own
  command line.

## The recorder

- A pane's video starts when its page is created; panes are lined up from the
  logged start times.
- ffmpeg: a `-loop 1` still input never ends; use single-frame inputs.
- Remote videos need `video.saveAs` after the context closes, while the
  connection is still up (`closeAndSaveVideo`).
- The terminal page's resize message starts with `\x01size:`. A NUL marker was
  mangled on the way.
- `window.setFont(px)` in the terminal page changes the text size; the setup
  scene uses 12 px inside a cut so `telecoder watch` gets its 120 columns.
- This server is short of memory, which is why the box exists. One take from
  the box had about as many redraw bursts as local takes, so the box is a
  convenience, not a proven fix.
- **Check a video against the scene file before debugging the product.** A
  take records the script as it was when it started. The wizard's `y`/`n`
  answers once looked missing only because the take predated the code that
  typed them.

## Product findings from making the videos

Raised with Rik or still to raise; not all fixed.

- `/project` on a fresh install shows an empty "Project Favorites".
- The wizard's end says "Start it with telecoder start" after the service was
  already installed.
- After a restart a new thread says "No project set".
- The wizard shows the demo user's real paths (`/home/telecoder-test`).
- Screenshots arrive as file attachments, not inline photos.
- `telecoder watch` waits forever when no chat has a session; a clearer
  message is possible.
