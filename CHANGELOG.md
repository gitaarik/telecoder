# Changelog

Notable changes per release. Each entry links the commit that carries the full
reasoning — the commit bodies are the long form, this is the index.

## Unreleased

### Sessions

- **The status line names the project** — a bot moves between projects and its
  display name only says where it is now, so scrolling back left you guessing
  which project an older answer belonged to. `📁 telecoder` now leads the stats
  under each answer. After a switch it already names the new project, where your
  next message goes.

- **A turn ends in one message** — with the status line on under `/verbosity
  verbose`, a turn closed with two messages that both gave the context and the
  cost, and each one notified you. The context bar now sits at the bottom of the
  status line, whose own 📊 and 💰 make way for it. With the status line off, the
  bar still comes on its own.

- **`/recap` ends like a turn** — after a long reply, `/recap` left you on the
  tail of an answer with the prompt it answers scrolled away, and it said
  nothing about the context, which is what has changed when you've just gone
  back to a fork or an earlier point. It now closes with the same status message
  as a normal turn: your last prompts, then the figure for the point the chat is
  at. In PTY mode that figure comes from the session log when no turn has cached
  one, so `/status` now shows its context line straight after
  a jump or a restart too, and `/context` answers from the log at those moments
  instead of starting a separate `claude` to ask.

- **A restart carries on instead of asking** — a chat quiet for between an hour
  and a week came back from a restart with "Continue where you left off, or
  start fresh?", and a `/rebuildbot all` left that choice waiting in every bot
  you hadn't used in the last hour. Every chat used in the past week now
  carries straight on in its conversation, as it would have with no restart at
  all; `/clear` is there when you'd rather start fresh. A project you'd picked
  but not talked in yet comes back with your next message too, where an hour
  on it used to answer "No project set". A "Start fresh" still standing on an
  old prompt now runs `/clear`.

- **A fork stands out where it starts** — loading a fork left one plain line,
  "✅ Fork loaded from …" or "✅ Branched into a new conversation", between two
  conversations that otherwise read as one thread when you scroll back. A
  branch taken in the same chat was the worst of it: the messages just above
  carry on past the point the branch starts from. The confirmation is now a
  banner — 🍴 Forked from … or 🌱 New branch, between heavy rules — that says
  outright a new conversation starts there and says the conversation above is
  in `/resume`. It shows the exchange the fork picks up after: your prompt on
  one line, and the reply whole in a collapsed quote that opens on a tap — so
  a fork to another bot doesn't leave that reply behind in the other chat, and
  the last reply above your next message is one the fork actually has. No
  summary: that would be a model call, and a retelling of the one thing you
  need verbatim. A reply too long to fit is cut at a word, pointing to
  `/recap` for the rest. The "✅ Forked to …" message in the sending chat now
  says that conversation carries on unchanged.

- **A fork can be forked again from either chat** — both messages confirming a
  fork now carry a 🍴 Fork button of their own: "✅ Fork loaded" or
  "✅ Branched" where the branch continues (after Accept, `/accept` or 🌱 New
  branch here), and "✅ Forked to …" in the chat it was sent from. Forking the
  same point a second time — to a third bot, or into another branch — used to
  mean scrolling back through the source bot's history to the message the fork
  was first taken from. Each button forks that same point, whatever either
  conversation has done since, so it hands over exactly what that message's
  own button would.

- **A fork offer previews the reply it was taken from** — the "Fork received"
  message quoted the source chat's latest reply as the last assistant message,
  so a fork taken from any earlier point arrived introduced by text it doesn't
  contain. The preview is now read out of the cut transcript itself.

- **`/resume` says which session each button is** — a session is named
  `project · topic`, which is routinely wider than the single line Telegram
  renders a button on, and the client ellipsises the rest away with no way to
  expand it. Two conversations in the same project therefore arrived as the
  same half-line and you picked between them blind. The picker now writes every
  session out in the message body keyed A/B/C — name and age — and the same
  letter keys its button, the rule `claudegram_ask_user` has followed since
  options moved into the body. Short names still ride on their own buttons
  (`A · telecoder`); the moment one is too wide the whole keyboard drops to
  bare letters, packed four to a row. Both features build that keyboard through
  one function now, so a question and a session list clip at the same place
  instead of each keeping its own threshold.

- **The other two pickers that hid text on a button** — the same rule now
  covers the "back to previous" button under `/clear` and `/project`, and the
  `/fork` target list. The back button named its session inside its own label
  and trimmed it at 45 characters, well past what a button renders, so the
  moment a session had a topic you were offered "back to" something you could
  not read. It keeps the name on the button while it fits — `↩️ Back to
  telecoder (2h ago)`, the common case, adding nothing to the chat — and past
  that width puts the name in the message and a fixed label on the button. The
  fork picker listed sibling bots by name only on their buttons, so two bots
  sharing a prefix arrived as the same clipped line; targets are now written
  out A/B/C in the picker message. "New branch here" moved the bot's own name
  off its label, which was single-handedly costing that keyboard its labels.
  Six commands offered the back button with four lines of identical
  keyboard-spreading each; that is one call now.

- **`/prompts` reaches further back** — it lists the last 15 prompts by
  default instead of 5, and `/prompts N` goes up to 25 instead of 20. Most
  prompts are a short line, so five used a fraction of the room one message
  has. Across 40 recent sessions, 15 always fit in one message, at
  about two phone screens. 25 fit in all but 5 of them, and in those the
  oldest are dropped to fit, as before, and the header says how many.

- **The status line shows your last five prompts** — with "Show last prompt"
  on in `/statusline`, the line after each answer showed only the prompt that
  turn answered, and a turn often starts from an "ok" or a "yeah" that says
  nothing on its own. It now lists the last five, oldest first. They are read
  from the session log, so they reach back past a restart. A `/compact` and
  the notes Claude Code writes in your place, like "[Request interrupted by
  user]", don't take one of the five; a paste shows its text and an upload its
  caption, the way `/tree` labels a branch.

- **The live action log says what the turn is for** — in verbose mode the
  action log grows below your prompt until it pushes it off screen, so
  remembering what a long turn was working on meant scrolling back up to
  find it. The log now ends with that prompt, under the status line, as the
  same italic ▸ line the status line uses. A paste shows its text and an
  upload its caption; a skill run with a slash command shows as typed. It
  goes when the turn ends, with the answer posted below the log by then.

- **A prompt shows whole, and a long one its start and its end** — the
  status line and the bottom of the live action log cut every prompt at 100
  characters. Across 100 recent sessions that caught a third of the prompts
  written as one paragraph, and a cut that keeps only the start drops what a
  long prompt usually ends on: the question. A prompt now shows whole up to
  300 characters, enough for 93% of those; past that it shows its start and
  its end with … between, cut between words. Five prompts under an answer
  take a median of 15 rows on a phone instead of 11. `/prompts` and
  `/recap` cut the same way, at the 300 and 500 characters they already
  allowed.

- **`/tree` shows each point's prompt, not its first few words** — a line of
  the tree had room for about 23 characters of the prompt a point starts
  from, so on the forked conversations on disk 38 of 44 points showed cut,
  most of them to a few words. The prompt now wraps onto lines of its own
  inside the drawing, with the branches carried on down beside it, and shows
  whole up to 300 characters; past that, its start and its end, the way
  `/prompts` shows one. Those trees take a median of 17 lines now, at most
  47, where they took a line per point. A tree too big for one message gives
  every prompt the same shorter cut, so the longest give way first. Opening a
  point shows the prompt it ends on the same way, up to 300 characters
  instead of 160, and the list of forked conversations its prompts up to 300
  instead of 80.

- **A fork's banner shows your prompt the way `/tree` does** — the banner
  where a fork or a branch starts showed the prompt it picks up after cut at
  120 characters, keeping only its start, and as the session log has it: a
  paste in its `<pasted_content>` tags, an upload as the note it reached
  Claude in, a reply under the quote it answers. It now shows whole up to
  300 characters, past that by its start and its end, a paste by its text,
  an upload by its caption and a reply by the words written under the quote,
  the same as the point's view in `/tree`. With the longest reply a banner
  holds, it still fits in one message.

- **`/prompts` goes back to any prompt** — the list was something to read and
  nothing more: going back to an earlier point meant scrolling up past every
  reply since to that one's 🍴 Fork button. Each prompt is now keyed A/B/C
  the way `/tree` keys its points, with a button per letter. A letter opens
  the prompt — its reply in a collapsed quote — with 🌱 New branch from
  here, which carries on just after that reply in a new conversation and
  leaves this one in `/resume`: the same banner and the same branch the
  reply's own 🍴 makes. Anything sent after that reply stays out of the
  branch, a `/compact` included. A prompt where a branch already splits off
  is marked 🌿, and 🌳 shows the tree, where that branch can be carried on.
  Prompts read the way `/tree` and the status line show them, a reply under
  a quote by the words written under it. `/prompts` also answers while a
  turn runs, where it used to wait for the turn to finish, and after a
  restart lists where the chat left off, as `/tree` does. Built from the
  transcripts on disk, 180 lists and 494 prompt views fit in a message, the
  longest at 3,325 characters.

- **`/prompts` gives the prompt after a `/compact` its own line** — a
  `/compact` leaves three records in the session log: the command, Claude
  Code's record of it, and what it printed. `/prompts` read them as part of
  the next prompt, so that prompt's line opened with some 200 characters of
  `<command-name>…</local-command-stdout>`, terminal escape codes included,
  and only about 85 of its 300 were yours. Each prompt now gets a line of
  its own. Commands and the notes Claude Code writes in your place, like
  "[Request interrupted by user]", are left out and don't count toward N. A
  prompt interrupted before any reply was folded into the next one; it now
  gets its own line, marked ⏳. A paste shows without the `<pasted_content>`
  tags around it, in `/recap` too.

- **`/recap` and `/handoff` show only what you sent** — the exchange after a
  `/compact` opened with the command's three records, terminal escape codes
  and all, and an interrupted prompt carried "[Request interrupted by user]"
  into the next one. Both are left out now, there and wherever else
  exchanges are read off the log: a fork's banner, a `/tree` point, and the
  conversation carried over when you switch providers. A command that got a
  reply, like a skill run with a slash command, keeps its exchange.
  `/handoff` also writes a paste without the `<pasted_content>` tags around
  it. Across 312 recent sessions, 26 of 1,430 exchanges had such records in
  the prompt; the replies are unchanged.

### Sharing a bot

- **Auto-approve windows** — `/autoapprove 30m` lets the permission gate approve
  instead of asking, for a stated length of time on one chat. A job made of
  guarded commands cost a tap each, and a guardrail people tap without reading
  has stopped being one. Admins and approvers can open a window; it posts every
  command it waves through rather than going quiet, announces itself when it
  lapses, and lives only in memory so a restart closes it. `mkfs`, `dd of=/dev/`,
  `DROP DATABASE`, `terraform destroy` and credential reads keep their prompt —
  the line is whether a wrong call can be walked back, not whether it is
  dangerous. `/autoapprove off` and `/autoapprove status` do what they say.

- **An approver tier** — `APPROVER_USER_IDS` names guests who may answer someone
  else's permission prompt without owning the bot. Being able to tap "Allow once"
  and being able to run `/restartbot` or `/method` were one flag, which forced a
  choice between one admin being the bottleneck for every prompt and handing
  guests the switch that turns the gate off. An approver stays a guest in every
  other respect — the charter judge still reads their messages, the gate still
  stops their tool calls — and cannot approve their own request, so the prompt
  still means something. `/users` lists them as their own tier, `/deny` names both
  lists so removing one doesn't strand an id the orphan check refuses to start on,
  and the toast tells an approver why their own request is the one they can't
  answer.

- **Admitting people from chat** — `/allow`, `/deny` and `/users`. A stranger who
  posts in the shared group gets an approve card naming them, and someone added
  to the group is asked about the moment they join; one tap makes them a guest,
  with no `.env` edit and no restart. Telegram has no API that resolves a
  `@username`, so the bot matches only handles it has seen go by and `/allow` as
  a reply is the exact form. Ids admitted this way persist in
  `~/.claudegram/user-roster.json`; ids from `ALLOWED_USER_IDS` stay the
  operator's, and `/deny` says so rather than appearing to remove one.
  `hasGuestUsers()` now reads the effective list, so admitting the first guest
  switches on the permission gate, the scope guard and the charter judge.

### Sharing a bot (continued)

- **Contributors and spectators in a group** — a group can now hold people who
  read along without being able to prompt the agent, which is the difference
  between a seat in the room and a shell on the host. `GROUP_MEMBERS_DEFAULT`
  decides what membership alone is worth, `/allow` and `/deny` move individuals,
  and `/members` reads back one group the way `/users` reads back the bot.
  `GROUP_REQUIRE_MENTION` keeps human conversation in the group from becoming
  prompts.

  This landed as a merge of two access models that had been built in parallel,
  and the reconciliation is the substance of it. The roster stayed the door —
  who may use the bot at all — and the group roles became a second gate behind
  it, so admitting someone in a DM makes them a contributor everywhere while a
  grant in a group stays in that group. `/allow` therefore means the nearer
  layer: the room when typed in the room, the bot when typed in a DM.

  Three things were dropped rather than merged. The branch's `OWNER_USER_IDS`
  computed exactly what `isAdmin()` already did, so it went and `owner` became
  `admin` throughout. Its owner-only command list duplicated the `adminOnly`
  wrapper the handlers already carry — but its judgement was better than main's
  coverage, so `/project`, `/newproject`, `/permissions` and `/teleport` are now
  wrapped too. And its username→id cache was a second answer to a question the
  roster already answers, free to drift from the first.

  `GROUP_MEMBERS_DEFAULT` ships as `spectator`, not the `contributor` the branch
  defaulted to. That default was right when Telegram membership was the whole
  gate; layered on top of the roster it would have widened who can prompt the
  agent, so the merged default matches what the roster already enforced.

### Reliability

- **`/version` says whether you're on the latest** — the version a restart names
  tells you what came back, but not whether anything newer has landed since. A
  fix you'd committed and never built looked just like one that was live.
  `/version` names the running build, compares it with the code in the checkout
  and the branch it tracks, and says what catches it up: `/restartbot` for a build
  that's done but not loaded, `/rebuildbot` for code changed since, `git pull` for
  commits that aren't here yet. It compares the contents of what a build compiles
  rather than commits, so a docs commit, committing what was already built, or a
  history rewrite doesn't count as falling behind. A check that couldn't run says
  so instead of passing, and it answers during a running turn.

- **A message you sent too soon can be taken back** — a message sent while the
  bot was busy got no answer at all, so a bot that was only still working looked
  idle, and you found out when the reply to the last message landed. Deleting it
  didn't help, because Telegram doesn't tell a bot about a delete: Claude got it
  anyway. A message that has to wait now says so within half a second, as
  `⏳ Queued behind the running turn`, with a **Take back** button that drops it
  before it reaches Claude and leaves the turn running. Text, voice notes, photos
  and files are all covered, and a bot command gets the same notice while it
  waits. That includes the turn you can't see, one Claude started itself on a
  background task's result: your message waits for it without a "thinking" bubble
  going up, and that turn's reply still arrives whole. `/cancel` and `/stop` now
  clear the queue. They used to stop the running turn and thereby start the
  message waiting behind it, and now they also reach a turn Claude started
  itself. `CANCEL_ON_NEW_MESSAGE`, which never took effect behind a normal turn,
  now does what `.env.example` says.

- **A cancelled message stays cancelled** — a message you stopped with `/cancel`
  before Claude had written anything came back. Claude Code put it back in its
  input box, and it went out stuck to the front of your next message as one
  prompt, while a `/cost` or `/tasks` would have submitted it by itself. The box
  is now emptied before anything else is typed into it, and a `/cancel` that lands
  while a message is still being typed in stops it from being submitted at all.

- **A restart says which version came back** — `/rebuildbot` reported a build
  and a restart but never what the bot came back on, so there was no telling
  from the chat whether a fix had gone live. The message a restart ends with now
  names it, as "Version: 63dcf45 feat: end /recap the way a turn ends (built 2m
  ago)", with "plus uncommitted changes" when `src/` had some at build time, and
  `/botstatus` says the same whenever you ask. It comes from a stamp
  `npm run build` leaves in `dist/` rather than from what's checked out, so a
  commit you haven't built yet isn't claimed as running. With
  `AUTO_RESTORE_SESSION` off a restart posts nothing afterwards, so `/botstatus`
  is the place to look there.

- **The bypass warning stays accepted** — since Claude Code 2.1.314, every new
  session (after `/clear`, `/model`, a project switch or a restart) opened with
  "WARNING: Claude Code running in Bypass Permissions mode", even though you had
  accepted it, and "Yes, I accept" didn't last past that session. The bot's
  launch leaves your user settings out, which is where that answer is kept, and
  that version stopped reading it there. The bot now passes the answer along
  when your settings already have it. An account that hasn't accepted still
  gets asked, once.

- **`/rebuildbot` can wait for each bot to finish** — rebuilding while bots
  were busy on other projects meant waiting for a moment when none of them
  was, or cutting a turn off halfway. The `/rebuildbot` menu now has "All
  instances, each once it is idle" (`/rebuildbot idle` for short): it builds
  once, then restarts each bot the moment it has nothing left to finish — no
  turn running or queued, no message still being handled, no background task
  still going, and no reply still on its way — instead of waiting for the
  busiest. One message in the chat you asked from keeps the tally, saying what
  each bot still waiting is busy with, with buttons to restart the rest now or
  call it off. The launcher has to be running this build before it can take
  the request; until then the message says so and nothing restarts.

- **Claude's answer after a background task arrives whole** — when a
  background task finished between your messages, what Claude wrote about it
  went onto the background activity card, under a "📡 Monitor" line, cut at
  1,200 characters, and the rest was only in `/recap`. That answer is often
  what the background work was for, and in two weeks of session logs 50 of
  the 119 Claude wrote ran past the cut. It now comes as a reply of its own
  once Claude finishes, sent the way any reply is: whole, split over messages
  only where Telegram needs it, and with a phone notification. The card keeps
  the tasks — what's running, what finished. A monitor firing still lands on
  the card at once, and what Claude says about it follows as a reply. If a
  question or a file comes in the middle, what Claude wrote before it goes
  out first, above it.

- **A restart stops its Claude Code sessions before the new bot takes over**
  — a restarted bot left every Claude Code session it had open to carry on
  until that session noticed. On 10-27 one wrote another reply into its
  conversation's log a second after the new bot had already resumed that
  conversation in a session of its own, so two processes had one log open.
  Shutting down now hangs each session up and waits for it to exit, which
  takes under a second when it's idle, and kills one still running after
  four seconds. A reply the restart cuts short isn't reported as an error on
  the way out, and a message that arrives mid-shutdown is told to come again.

- **A question asked after a background task reports back reaches you** —
  when a background task finished between your messages, Claude Code started
  a turn of its own to deal with it, and TeleCoder had no turn on record to
  run its tools in. A question it asked with buttons failed within a second
  with "MCP error -32602: Invalid tools/call result" and a schema dump, and
  never reached the chat; sending a file, a poll or a schedule failed the
  same way. The two weeks of logs on hand hold seven such calls across two
  bots. Those tools now reach the chat the session belongs to. A question or
  a file posted there seals the background card above it first, so what
  Claude writes after your answer lands below it. A tool with no chat to
  reach now says so in words.

- **A question keeps its turn while it waits** — Claude Code 2.1.311 moves
  an MCP call that is still running after two minutes to the background, and
  the turn carries on without it. A question you took longer than that to
  answer ended its turn, and your answer came back later as a background
  task instead of in the reply. TeleCoder's Claude Code sessions now let a
  call run until it would time out, which is past the question's own ten
  minutes.

- **The context reading after a `/compact` shows what it left** — under
  "🗜️ Context compacted — 536.4k → 13.7k tokens" the usage footer still read
  54%, the context from before, and only the next reply brought it down. A
  compaction writes no usage of its own, so the newest figure in the session
  log was the one for the conversation it had just replaced. The reading now
  drops to what the compaction left, 1% there, in the footer, the status line
  and `/context` alike. That figure counts the conversation only, so the next
  reply, which adds the system prompt and tools back, reads a few percent
  higher.

- **`/status` reads the context the footer does** — its 📐 Context line added
  up the reply and the input sent fresh, and left out what came from the
  prompt cache, which once a conversation is under way is nearly all of it:
  0% (322/1.0M) where the footer read 54%. It now counts cache reads too, the
  same sum as the footer.

- **Claude Code stays on the screen layout TeleCoder can read** — Claude Code
  2.1.310 can start in its new fullscreen layout without being asked: a trial,
  a fresh install or a remote feature switch turns it on. Everything TeleCoder
  reads off the screen — the input box, the spinner, the dialogs — is built for
  the classic layout, and in a test run that came up fullscreen, `/mcp`'s tool
  list offered "Enter — select" on a list whose cursor it couldn't see.
  TeleCoder's Claude Code now always starts in the classic layout.

- **Closing a menu no longer sends your last answer again** — `/mcp` and the
  other Claude Code menus write no reply of their own. When one closed,
  TeleCoder went looking for the latest reply in the session log, found the one
  before the command, and posted it again as the menu's answer. The chat now
  gets what the command printed — "Reconnected to sjs-dev.", "MCP dialog
  dismissed" — or ✅ Done when it printed nothing.

- **Claude Code's menus can be walked from the chat** — picking a server in
  `/mcp` opens that server's own screen, but TeleCoder expected every tap to
  close the dialog it answered. The tap went in, the menu stayed open on the
  server's screen, and the turn ended calling the dialog "still open": the menu
  could be opened from the chat but never used. Each screen a tap leads to now
  comes to the chat in turn — a server's actions, its tool list, the list Esc
  steps back to — until Claude Code is back at its input box. A list too long
  for the screen, like a server's 111 tools, offers every row it shows instead
  of its first seven, with buttons to scroll it, and the `↓ 92 more` under it
  and the group headings between `/mcp`'s servers are no longer offered as
  rows.

- **A message that starts with a long link gets through** — Claude Code wraps
  its input box at word boundaries. In a message like "I'm about to submit
  https://…long link…", the link moved down a row, which split the opening
  words TeleCoder looks for to confirm a message landed. Every attempt was
  reported as "didn't take your message", however often you resent it. Worse,
  clearing the box between attempts removed only the bottom row. Copies of the
  opening words piled up three per attempt, and they were sent along with your
  next message. TeleCoder now finds the opening words across a row break, and
  clears every row it filled.

- **A command moved to the background is counted while it runs** — Claude
  Code doesn't kill a Bash command that runs into its 10-minute limit: it
  moves it to the background and carries on. TeleCoder only counted commands
  started in the background, so one moved there was missing from the
  "🔄 N tasks running in background" footer, `/tasks` and the background card
  for as long as it ran. It now counts from the moment it moves, and its
  running time starts from when the command did.

- **A crashed Claude Code no longer leaves its background tasks counted as
  running** — when Claude Code exits on its own, killed for running out of
  memory say, the tasks it ran in the background end with it. TeleCoder only
  cleared them when it shut Claude Code down itself, so after a crash they
  stayed in the count indefinitely. They're now cleared however Claude Code
  exits.

- **A background task that finished mid-turn no longer counts as running** —
  if a background task finished while Claude was in the middle of a turn, the
  "🔄 N tasks running in background" footer, `/tasks` and the background card
  went on counting it as running until the session ended. TeleCoder 4 showed
  two tasks running with nothing running at all. Claude Code folds a
  completion like that into the turn in progress instead of logging it as a
  message of its own, and TeleCoder only looked for the message. It now reads
  the folded-in completion too.

- **A running turn no longer keeps "typing…" up** — every turn renewed
  Telegram's "typing…" indicator every four seconds until it ended, and
  Telegram Desktop draws that animation on the CPU for as long as it shows, so
  a long turn kept the client busy the whole time. A turn with the live status
  line (`/terminalui`, on by default) no longer sends it: the status line
  already shows the turn is alive. With the terminal UI off, "typing…" stays,
  since nothing else would. In verbose mode the status line now sits at the
  bottom of the action log, because the log is posted below the status bubble
  and is usually tall enough to push it off screen. That left "typing…" as the
  only live sign you could see. The bubble points down at the log, and the
  log's header starts with ⏳ while the turn runs, so the chat list shows it's
  still going. The waiting-for-your-answer line now points down at the
  question too; it said "above", but the question is posted below it.

- **The live action log catches up** — the log was edited at most every ten
  seconds, and an action that arrived sooner was left off until another one
  came in. After a burst of quick reads followed by a long build, the log
  stayed a couple of actions behind for the whole build. It now draws the
  waiting actions once the ten seconds are up, and after a Telegram rate limit
  it draws again instead of dropping the change. Commands and output go out
  as entities rather than MarkdownV2, so they show verbatim and nothing in
  them can break an edit.

- **A running command reads as code in the status bubble** — while a Bash
  command ran, the status bubble showed it as plain text under the timer, so
  a long one-liner, such as a loop polling `gh pr checks`, sat there as a raw
  run of pipes, quotes and `$(...)` for as long as it ran. The command is now
  in a `bash` code block, the way the permission prompt shows one, and the
  block's copy button hands back just the command. It goes out as Telegram
  entities rather than MarkdownV2, so nothing in the command can break the
  update.

- **A message of several lines is acted on, not held for a confirmation
  tap** — Claude Code now wraps a long paste in `<pasted_content>` tags, and
  its system prompt has the model act on instructions inside one only where
  your own words outside the tags ask it to. TeleCoder delivers every message
  as a paste, so anything over two lines or 800 characters arrived as one
  tagged block with nothing outside it: the model took your request for text
  copied from somewhere else and asked for a button tap before doing what it
  said. The system prompt a PTY session starts with now says what the tags
  mean here — how the message was delivered, not where it came from. Text you
  quote or forward, and pages TeleCoder fetches for you, are still read as
  someone else's. SDK mode never pasted, so it was never affected.

- **Claude Code's dialogs arrive laid out for a phone** — a dialog relayed to
  the chat, most often a permission prompt (Claude Code raises some even in
  auto mode, such as a heredoc whose braces and quotes trip its "expansion
  obfuscation" check), came through as its raw terminal render. It was
  hard-wrapped at 120 columns and then rewrapped by the phone, the command sat
  in a `│` gutter, an edit's diff sat between two screen-wide rows of dashes,
  and the rows repeated the buttons behind a `❯` cursor. Blank lines were
  dropped, so title, command, reason and question ran together. Now the title
  and the question are bold, the command or diff is in a code block, prose
  Claude Code wrapped is rejoined, and each choice is written out once in full
  under its button's number, since the button clips it. The last line says
  what a tap does, and a dialog that opens mid-turn no longer promises to
  "deliver your message". Answering the dialog, or letting it time out, keeps
  the formatting. The answered edit also used to strip formatting from the
  bot's own permission prompts; it keeps it now too.

- **A relayed permission prompt no longer offers "Tab — amend"** — the
  button pressed Tab, which doesn't answer the prompt: it turns the
  highlighted row into a text field ("Yes, and tell Claude what to do next")
  for a note a button can't type. The dialog stayed open, so the turn failed
  with "Claude Code hasn't returned to its input box". Tab is left out of the
  buttons now, along with the other keys that change a dialog without
  answering it.

- **Claude Code asking to fetch a page reaches the chat** — WebFetch's
  permission prompt was never relayed. The dialog reader found a dialog by
  its footer, the "Esc to cancel · …" line under the choices, and this prompt
  has none: it ends on its last choice, with the one key it names written
  into that choice ("No, and tell Claude what to do differently (esc)"). A
  turn that wanted to fetch a page in a mode that asks first sat on the
  dialog, with nobody asked, until the turn's hard ceiling. A numbered list
  with the cursor on it, under the dialog's top rule and reaching the bottom
  of the screen, now counts as the end of a dialog. It gets its choices as
  buttons, and no key buttons, since it names none.

- **A dialog left open mid-turn no longer says your message wasn't
  delivered** — when a dialog that opened partway through a turn went
  unanswered, or couldn't be answered from the chat, the turn ended with
  "your message wasn't delivered. Send it again". It had been delivered: the
  dialog came from the work it started, and resending it only queued a
  duplicate. Mid-turn it now says the bot stopped waiting on the turn, that
  Claude Code is still paused on the dialog, and that your next message
  brings its buttons back. Before a message goes in, the wording is unchanged,
  since there the message really wasn't typed in.

- **The last message of a long reply lost its formatting** — when a reply was
  split across messages at a point inside a code block, the splitter closed
  the block at the end of one part and reopened it at the top of the next, but
  then counted that reopening fence as a closer as well. The next part ended
  with a stray fence Telegram couldn't match ("Can't find end of Pre entity"),
  so it was rejected and re-sent as plain text, with its bold and code showing
  as raw `*` and backtick markers. Past two parts, every fence after the first
  cut was counted the wrong way round. Each part now starts outside a code
  block, with the reopened fence as part of its own text. The first line of a
  reopened block also keeps its indentation, which used to be trimmed off.

- **A quote under a list item no longer costs the message its formatting** —
  a `>` quote on the line right under a list item came out indented, as that
  item's continuation. Telegram only reads `>` as a quote at the very start of
  a line; anywhere else it is a reserved character, so the message was
  rejected and re-sent as plain text. The same went for a collapsible
  `<expandable>` quote written on an item's line. Quotes now always start
  their line, which is the only way Telegram draws them anyway. A `$` in a
  collapsible quote also stays as written; `$$` used to collapse to `$`.

- **Long replies stopped being replaced by a 200-character stub** — with
  Instant View on, any reply past 2500 characters — or one merely containing a
  markdown table — was swapped in chat for `text.substring(0, 200) + '...'` and
  a telegra.ph link. The answer never arrived, the stub was cut at a raw
  character offset mid-word with its markdown stripped out, and the only way
  back to what the model wrote was `/recap`. Telegraph is additive now: the
  reply goes out in full, chunked as usual, and the page URL hangs under the
  last chunk — or takes a chunk of its own when appending would overflow it. A
  telegra.ph outage costs the link, never the text. The table trigger is gone
  outright; `convertToTelegramMarkdown` has rewritten pipe tables into bullet
  lists for a long time, so there was nothing left to compensate for.

- **Turns started from a voice note, a photo, a text file, a Reddit summary,
  `/plan` or `/explore` had no catch-up** — `relayCatchUpIfMissed` is the
  safety net that compares what was relayed against the canonical assistant
  text in the session log and posts whatever is missing. Text messages,
  force-reply prompts and scheduled runs called it; these turns never did, in
  streaming or wait mode, so they also never updated the relayed tracker —
  leaving `/sync` comparing a fresh log against a stale baseline and offering
  to re-post an earlier turn's reply. The `/loop` command is deliberately still
  out: it concatenates several turns, and the single-turn comparison would
  either no-op or duplicate the last iteration.

### Reliability

- **`/restartbot` no longer kills a systemd-managed bot for good** — the restart
  ran `botctl recover` as a detached child, but `detached: true` escapes the
  process group and not the cgroup. Under systemd the helper was reaped along
  with the bot the moment it exited, before it reached the start half of its
  job, and the clean exit told `Restart=on-failure` there was nothing to fix.
  The bot now recognises that systemd is holding it up and exits `75` for
  systemd to bring it back, instead of trying to start its own successor. It
  checks the unit's `Restart=` first and refuses — while still running — rather
  than announcing a restart it cannot come back from. The shipped unit moves to
  `Restart=always`.

### Reliability

- **A lost hook could outrank the Stop signal and hang a finished turn** — the
  end-of-turn check refuses to finish while the hooks say a tool is still open,
  which is right: `claudegram_ask_user` long-polls for a button tap and the pty
  is silent for as long as it waits. But that count was checked *before* the
  Stop hook, on the reasoning that Stop only fires once every tool is done.

  It does — which is exactly why a count that survives Stop cannot be a live
  tool. The hooks are `curl` calls into a loopback server, fired and forgotten
  (`>/dev/null 2>&1; exit 0`); a POST that fails takes its decrement with it,
  nothing retries, and nothing else ever brings the count down. One dropped
  request then outranked the only authoritative end-of-turn signal there is,
  and the turn ran to the two-hour ceiling with claude sitting idle at its
  prompt and its finished answer already written to the session log. A chat
  waited an hour and seven minutes past "Done" for a reply that never came.

  Stop now wins, the stale count is logged and cleared rather than silently
  believed, and the count keeps guarding the path where it earns its keep.

- **Answering a dialog could end the turn and strand the session** — the
  end-of-turn check infers "claude is finished" from a quiet pty, the input box
  being back, no spinner, and the session log having moved. Every one of those
  is true in the moment after a relayed dialog is answered, and none of them
  mean what they usually do: the box is back because the dialog went away, and
  the spinner is missing because claude has not resumed yet.

  A turn resolved in that gap does not just finish early, it takes the session
  down with it. The bot hands back an answer and forgets the turn, while claude
  carries on working with nobody listening — hooks arriving with no active turn
  to attach to and being dropped, output going nowhere, and every later message
  held against a screen that now does say "generating" until the ceiling
  rejects it. One live session spent 37 minutes unreachable that way, and
  `/stop` only reaches it while a message happens to be in flight.

  The turn now waits for claude to show itself after a dialog is answered — a
  spinner, or a tool opening through the hooks — bounded at 15s so a dialog
  whose answer genuinely did end the turn still resolves. The Stop hook stays
  authoritative and is never waited past.

- **The PTY could not find the `claude` binary under systemd** — `CLAUDE_BIN`
  fell back to the bare name `claude`, which node-pty execs directly against
  the *service's* PATH. A systemd user unit gets the bare default, without
  `~/.local/bin`, which is where the native installer puts the CLI. execvp
  wrote "No such file or directory" into the pty and exited, so the bot saw a
  session that produced nothing and reported that the input box never appeared.

  `resolveBin()` has searched `~/.local/bin` first on Linux since it was
  written, for this exact reason — the pty provider just never called it.
  @code_share1_bot had not completed a single turn since the day it moved to a
  systemd unit; it went unnoticed because the failure names a symptom two
  layers above the cause.

- **A dialog with a status bar under it is still a dialog** — `parseModal` took
  the last non-empty line and required it to parse as key hints, so anything
  claude drew beneath the footer (its `⏵⏵ bypass permissions on` status bar, a
  transcript warning, a welcome notice) made the parser answer null. The
  readiness loop reads null as "a screen we cannot drive" and falls through to
  the timeout, so the dialog that should have arrived in the chat as two
  buttons instead spent its whole ceiling being silent and came back as
  "Claude Code's input box never appeared".

  This is how @code_share1_bot went quiet after a CLI update began asking about
  a folder it had been working in for weeks: the trust prompt was on screen,
  recognisable, and never relayed. The footer is now located as the lowest
  hint-bearing line rather than assumed to be last, bounded to three lines of
  chrome so a stale footer scrolled up in the transcript cannot pose as this
  screen's.

- **A stuck TUI now says what it is stuck on** — the warning named the symptom
  ("input box absent") and nothing else, so diagnosing the above meant spawning
  ptys by hand outside the bot to see a screen the bot had already read. It now
  logs the last dozen screen lines alongside the verdict.

## [1.1.0] — 2026-08-31

The release that makes a bot shareable. Everything before this assumed one
person on one machine; this batch adds the access model, the guardrails and the
visibility that a bot with other people in it needs.

### Sharing a bot

- **Admins and guests** (`9470e1d`) — `ADMIN_USER_IDS` names the subset of
  allowed users who may approve permission prompts and run lifecycle and
  transport commands. Unset, every allowed user is an admin, so single-user
  installs are unchanged. Includes a scope guard, a charter read before anything
  runs, and prompt-hold so a guest's request waits for an admin.
- **Its own Unix account** (`e72ee84`) — `scripts/setup-shared-bot-user.sh`
  provisions the account that decides what is actually *reachable*: no sudo, no
  docker, its own checkout, and a `--verify` that becomes the account and tries
  to read the operator's secrets rather than reasoning about file modes.
- **Resource ceilings** (`d8efbd9`) — MemoryHigh throttles before MemoryMax
  kills, CPUQuota leaves cores for everything else, IOWeight yields disk. Disk
  is reported rather than enforced, since only filesystem quotas would be honest.
- **Per-bot model and effort** (`365d134`) — `/model` and `/effort` apply to the
  bot you ran them in, with an opt-in fan-out to the rest.

### Added

- **`/prompts`** (`680c436`) — lists just the prompts you sent, one line each,
  without the replies. The fastest way to remember what a conversation was about.
- **`/cost`** (`562c205`) — usage limits on a subscription, dollar totals on API
  billing, plus a running per-conversation total that Claude Code cannot keep
  because its own counter dies with every turn.
- **`CLAUDE_PLUGINS`** (`7cdbf09`) — brings marketplace plugins into the agent.
  Enabling one in the terminal writes to a settings file neither transport
  reads, so its skills and commands were silently missing in Telegram.
- **Claude Code's own slash commands** (`86d9622`) — `/commands` reports which
  of them work here.
- **`EXTRA_MCP_CONFIG`** (`11dae19`) — load MCP servers you name yourself,
  without dragging in every server the machine has ever registered.

### Fixed

- **Refuse to start on an unreachable admin** (`2f19ba1`) — an id in
  `ADMIN_USER_IDS` but not `ALLOWED_USER_IDS` can never act. This replaces a
  warning that went to a log nobody reads and surfaced days later as an approval
  sent to the wrong person.
- **Truncated replies after a background task** (`6628922`) — a task reporting
  in mid-turn wrote a user-role record that the transcript reader treated as a
  turn boundary, dropping everything above it.
- **MarkdownV2 code spans** (`11ab6fc`) — added the escaper they need, which has
  different rules from ordinary text.

## 1.0.0

Everything before this changelog existed. See the git history.
