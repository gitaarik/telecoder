# Roadmap

What I plan to build next on TeleCoder, roughly in order. It is all work I'd do anyway,
because I use this bot every day. Hour figures are rough estimates, and the plan changes
when daily use turns up something more urgent.

## Next up

### 1. Rebuild the live checklist on the Task tools (4–6 h)

Current Claude Code CLIs replaced `TodoWrite` with `TaskCreate`, `TaskUpdate` and
`TaskList`. The SDK transport's live checklist still only recognises `TodoWrite`
(`src/telegram/message-sender.ts`), so on a current CLI the card never appears.

- Assemble checklist state from separate create and update calls, where `TodoWrite`
  delivered one complete array
- Keep editing a single Telegram message in place per turn
- Add Vitest coverage for the state transitions, including out-of-order and unknown ids

### 2. `/tree` follow-ups (8–12 h)

`/tree` draws a conversation's fork tree and can branch from its split points and branch
ends. Next, in order:

- Pick any turn inside a stretch, not only split points and branch ends
- Give each stretch a short, cached label that reads better than the prompt excerpt
- Name or pin a point when forking from it
- Zoom into a subtree, for trees too large to fit on a phone screen

### 3. Make the PTY transport sturdier across CLI updates (8–12 h)

The PTY transport reads the Claude Code TUI, so a CLI release can change what it sees.
Recent examples are a new fullscreen renderer and a change in which settings files the
CLI reads.

- Commit the live TUI probe harness, which runs the real PTY provider against a real
  `claude` with Telegram stubbed
- Refresh TUI fixtures from a current CLI, so a change shows up as a failing test instead
  of odd behaviour in chat
- Report clearly when the installed CLI is newer than the last version tested

### 4. Permission gate on every transport (6–8 h)

The permission gate is a hook on the `claude` CLI, so it only runs on the PTY transport.
A chat on the SDK transport, or on CCR (which always takes the SDK path), gets no gate,
and `/permissions` can only warn about it.

- Enforce the same guarded patterns and scope guard through the SDK's permission callback
- Share one test suite across both transports, so they can't drift apart

## After that

### 5. Split the largest modules (8–12 h)

Behaviour stays the same, and tests come first where coverage is thin:

| File | Lines |
|------|-------|
| `src/claude/pty-provider.ts` | 2,476 |
| `src/telegram/message-sender.ts` | 1,449 |
| `src/claude/agent.ts` | 1,387 |
| `src/bot/handlers/command/settings.ts` | 1,153 |

### 6. Settle the "interrupted by user" misattribution (2–4 h)

Long background tasks sometimes report "Request interrupted by user" when nobody
interrupted them. The foreground variant is understood; the background one is still open.
Findings so far are in
[`docs/debugging/interrupted-by-user-misattribution.md`](docs/debugging/interrupted-by-user-misattribution.md).

### 7. Files over 20 MB (4–6 h)

Telegram's cloud Bot API won't let a bot download a file over 20 MB. Add optional support
for a self-hosted Telegram Bot API server: an opt-in Compose file, docs, and a safe
migration path, since moving a bot token to a local server is hard to undo.

### 8. Easier setup and releases (5–8 h)

- A `doctor` command that checks the bot token, the `claude` login and `ffmpeg`, and says
  exactly what to fix
- Move the full configuration reference out of the README into `docs/`
- Cut v1.2.0 from the changelog's large "Unreleased" section, and publish release notes
  for each version from then on

## Out of scope

TeleCoder stays a self-hosted client for Claude Code. These are not planned:

- A hosted or multi-tenant service
- Hosting, training or evaluating AI models
