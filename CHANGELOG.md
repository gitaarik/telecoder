# Changelog

Notable changes per release. Each entry links the commit that carries the full
reasoning — the commit bodies are the long form, this is the index.

## Unreleased

### Sharing a bot

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
