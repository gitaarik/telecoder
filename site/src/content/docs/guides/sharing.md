---
title: Sharing a bot
description: Admins, guests, group roles, the permission gate and a separate Unix account.
sidebar:
  order: 6
---

TeleCoder's original access model is one flat list: everyone in
`ALLOWED_USER_IDS` can do everything. That is right for a bot with one user, and
it stops being right the moment you add a second — an approval prompt the person
who triggered it can tap themselves is not an approval.

So an instance can split its users into **admins** and **guests**. Guests use the
agent normally; admins own the parts that reach past their own session.

One owner answering every prompt becomes its own bottleneck, though, so there is
a tier in between: an **approver** is a guest who can answer someone else's
permission prompt. They stay a guest in every other respect — the charter judge
still reads their messages, the gate still stops their tool calls, and the
lifecycle commands still refuse them — and they cannot approve their own
request, which is what keeps the prompt meaningful.

```bash
# .env — a bot shared with friends in one group
ALLOWED_USER_IDS=111,222,333     # you and two friends
ADMIN_USER_IDS=111               # just you
APPROVER_USER_IDS=222            # can unblock a prompt, owns nothing
ALLOWED_GROUP_IDS=-1001234567890 # the group you share
RESTRICT_TO_GROUPS=true          # guests can't take it into a DM
WORKSPACE_DIR=/srv/shared        # the only projects the picker offers
```

Three layers decide what needs a human, from cheapest to smartest:

| Layer | Catches | Costs |
|-------|---------|-------|
| **Permission gate** | destructive commands — `rm -rf`, `sudo`, force-push, `DROP TABLE` | a regex |
| **Scope guard** | a tool call naming a path outside the projects, or any credential path | a path check |
| **Charter judge** | what neither of those can see — "open a tunnel to this box", "email me the projects folder" | a Haiku call, ~5s per guest message |

The first two stop a tool call mid-turn. The third runs *before* the message
reaches Claude, so a held request is still a sentence a person can read rather
than a diff to review afterwards.

What that buys you:

- **Approval prompts go to admins, and to whoever you name in
  `APPROVER_USER_IDS`.** A guarded command pauses, and the prompt names them
  with a real Telegram mention — so it notifies you even in a muted group, and
  even if you have no @username. Everyone else tapping it gets told who they're
  waiting on; an approver tapping their *own* request gets told why that one is
  the exception. Unanswered, it denies after
  `PERMISSION_PROMPT_TIMEOUT_MINUTES`.
- **A decision can be made once instead of forty times.** A job built out of
  guarded commands — a dependency bump that runs `rm -rf node_modules` four
  times, a rebase that force-pushes twice — costs a tap each, and a guardrail
  people tap without reading is worse than one that isn't there. So
  `/autoapprove 30m` answers them in advance for one chat. Admins and approvers
  can open one; it posts every command it waves through, announces itself when
  it lapses, and a restart closes it. `mkfs`, `dd of=/dev/…`, `DROP DATABASE`,
  `terraform destroy` and credential reads still ask, because those are not
  tedium. `/autoapprove off` ends it early, `/autoapprove status` reads it back.
- **The gate turns itself on.** With guests present you get prompts without
  setting a second variable; `TELECODER_PERMISSION_PROMPTS=0` opts out.
- **Lifecycle and backend are yours.** `/update`, `/restartbot`,
  `/rebuildbot`, `/provider` and `/ccr` refuse a guest.
- **The same gate on every turn.** It is a PreToolUse hook on the `claude`
  the pty runs, on Claude and on CCR, in every `/mode` including bypass, and it
  covers subagents' tool calls too. If it breaks while judging a call, the
  call is denied.
- **A `!command` is checked too.** A message starting with `!` runs as a shell
  command in Claude Code's shell mode, without Claude and without a tool call.
  It goes through the same gate and scope guard before it runs, so a guest's
  `!sudo …` waits for an approver like Claude's own would.
- **Out-of-scope paths prompt too.** `cat ~/.ssh/id_rsa`, an edit to a project
  nobody was invited to, a read of this bot's own `.env` — all held. System
  paths and language toolchains stay readable without prompting, because a
  guardrail that fires on `cat /etc/os-release` is one people learn to tap
  through.
- **A charter in plain language.** Drop a `CHARTER.md` in your workspace root
  (or point `CHARTER_FILE` at one) and every guest message is read against it
  first. No charter, no problem — a default is generated from the allowed
  roots. The judge only ever *asks*; it never refuses on its own, and it fails
  open, with the scope guard underneath as the deterministic backstop.
- **`/permissions` reports the truth.** Gate state, scope roots, which charter
  is in force, your role, and the guarded patterns.
- **Letting someone in takes one tap.** A stranger who posts in the shared group
  gets a refusal *and* an approve card naming them, mentioning the admins so it
  notifies you in a muted group. Tap Allow and they're a guest immediately — no
  `.env` edit, no restart. Someone added to the group is asked about the moment
  they join, before they've said anything.

Write the house rules in `CHARTER.md` at your workspace root — see
[`CHARTER.example.md`](https://github.com/gitaarik/telecoder/blob/main/docs/CHARTER.example.md) for a starting point.

## Your own Claude Code setup

On a bot that is only yours, Claude starts as it does in your terminal: with
`~/.claude` (your `CLAUDE.md`, skills, commands, agents and `settings.json`),
your MCP servers, your plugins and your claude.ai connectors.

On a bot with guests all of that stays out. A guest would otherwise work with
your personal instructions, and with connectors signed in as you: your documents
and mail are not part of the projects you shared. What a project carries itself
still applies, so its `CLAUDE.md`, `.claude/` settings, skills and commands work
for everyone.

It follows the roster, as the permission gate does. Admitting a first guest
takes your setup out from each conversation's next message, and the startup log
says which way it went. To bring something along anyway:

- `CLAUDE_PLUGINS` names plugins to enable, and `EXTRA_MCP_CONFIG` points at a
  file of MCP servers. Guests get these too.
- `CLAUDE_USER_SETUP=on` brings everything, guests or not. `off` keeps it out of
  a bot that has none.

A shared bot running as [its own Unix account](#a-real-boundary-its-own-unix-account)
has its own `~/.claude`, with nothing of yours in it. The claude.ai connectors
belong to the Claude account it is signed in with, though, so `on` there still
hands those to guests.

## Admitting people from chat

`ALLOWED_USER_IDS` is read once at startup, so every new person there costs an
edit and a restart. `/allow` is the runtime half of the same list:

| Command | What it does |
|---------|--------------|
| `/users` | Who can use this bot: admins, `.env` guests, guests admitted from chat, and people seen in the group but not let in |
| `/allow` | Admit someone as a **guest** — reply to their message, or `/allow @user` / `/allow 12345` |
| `/deny` | Remove someone `/allow` admitted |

All three are admin-only, and take effect immediately. With several bots, each
keeps its own list: `/allow` lets someone into the bot you sent it to and no other,
and `/deny` takes them out of that one.

**Reply to their message rather than typing a handle.** Telegram gives bots no
way to resolve a `@username` — there is no such API call, `getChatAdministrators`
covers only a group's admins, and nothing enumerates ordinary members. So the
only handles this bot can match are the ones it has watched go by, and a reply
is both exact and the one form that works for the many people who have no
username at all. A handle it hasn't seen gets told so, rather than failing
mysteriously.

Ids are the identity throughout. A Telegram username can be dropped and claimed
by someone else, so it's re-resolved on every use and never stored as the thing
being allowed.

Admitting someone makes them a guest, which switches on the permission gate, the
scope guard and the charter judge if they weren't already on. `/deny` on an id
that came from `ALLOWED_USER_IDS` reports where it actually lives instead of
appearing to work until the next restart.

> [!IMPORTANT]
> All of the above is supervision, not isolation. Claude still runs as your Unix
> user, so a guest's session can reach anything that user can — auto mode asks
> before the riskier steps, but it is Claude's judgement, not a boundary.
> `WORKSPACE_DIR` scopes the project picker, not the filesystem. For a real
> boundary, run the shared instance as
> [its own Unix account](#a-real-boundary-its-own-unix-account).

## Group roles

Access in a group has three tiers. **Admins** (`ADMIN_USER_IDS`, or everyone in
`ALLOWED_USER_IDS` when that is unset) have full access everywhere and are the
only ones who can hand out the rest. **Contributors** can prompt the agent in
that group. **Spectators** are in the chat and ignored by the bot — they read
along and talk to everyone, and the bot only answers them with a (rate-limited)
note if they address it directly, alongside a card an admin can tap to let them
in.

This layers on the bot's roster rather than replacing it: anyone in
`ALLOWED_USER_IDS`, or admitted with `/allow` in a DM, is a contributor in every
group without a per-group grant. `/users` reads back that bot-wide list;
`/members` reads back one group.

`GROUP_MEMBERS_DEFAULT` picks which of the last two an ungranted member lands
in. `spectator` is the default: nobody can prompt the agent until an admin runs
`/allow`, so adding someone to the chat is not the same as handing them a shell.
`contributor` makes Telegram membership the whole gate — right for a group of
peers who all own the box.

Commands that reconfigure the bot rather than drive the conversation stay with
admins — `/restartbot`, `/rebuildbot`, `/update`, `/mode`,
`/provider`, `/ccr`, `/permissions`, `/terminal`, `/project`, `/newbot`,
`/users`, `/allow` and `/deny`, along with the inline buttons those
open. A contributor drives the conversation; only an admin repoints or restarts
the bot. `/members` is readable by anyone who can prompt.

## A real boundary: its own Unix account

Supervision decides what needs your attention. Unix decides what is reachable at
all. If the people you're sharing with shouldn't be able to read your other
projects even in principle, the shared bot needs an account that owns nothing but
the shared projects:

```bash
sudo ./scripts/setup-shared-bot-user.sh --operator "$USER"
```

That script locks down your home directory, creates a `telefriends` account with
no sudo and no docker (the docker group is root-equivalent), gives it a projects
directory and its own TeleCoder checkout, writes a starter `.env` with the
sharing settings already filled in, and installs a lingering `systemd --user`
service so it survives a reboot. Authenticating Claude and pasting the bot token
stay yours — both are interactive, and neither belongs in a script's arguments.

It ends by verifying its own work, which you can re-run at any time:

```bash
sudo ./scripts/setup-shared-bot-user.sh --verify
```

The check doesn't reason about modes; it becomes the account and *tries* to read
your secrets, which is the only form of that answer worth trusting.

> [!WARNING]
> Check this before adding any account: a home directory at mode `0751` lets
> other accounts traverse into it, so every world-readable file inside is
> reachable by absolute path — and a `.env` written at the default `0664` is one
> of them. `--verify` reports it; the setup script fixes it.
