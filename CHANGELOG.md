# Changelog

Notable changes per release. Each entry links the commit that carries the full
reasoning — the commit bodies are the long form, this is the index.

## Unreleased

### Sessions

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
