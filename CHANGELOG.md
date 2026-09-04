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
