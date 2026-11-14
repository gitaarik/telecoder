# Roadmap

What I plan to build next on TeleCoder, roughly in order. It is all work I'd do anyway,
because I use this bot every day. Hour figures are rough estimates, and the plan changes
when daily use turns up something more urgent.

## Next up

### 1. `/tree` follow-ups (8–12 h)

`/tree` draws a conversation's fork tree and can branch from its split points and branch
ends. Next, in order:

- Pick any turn inside a stretch, not only split points and branch ends
- Give each stretch a short, cached label that reads better than the prompt excerpt
- Name or pin a point when forking from it
- Zoom into a subtree, for trees too large to fit on a phone screen

### 2. Make the PTY transport sturdier across CLI updates (8–12 h)

The PTY transport reads the Claude Code TUI, so a CLI release can change what it sees.
Recent examples are a new fullscreen renderer and a change in which settings files the
CLI reads.

- Commit the live TUI probe harness, which runs the real PTY provider against a real
  `claude` with Telegram stubbed
- Refresh TUI fixtures from a current CLI, so a change shows up as a failing test instead
  of odd behaviour in chat
- Report clearly when the installed CLI is newer than the last version tested

## After that

### 3. Split the largest modules (8–12 h)

Behaviour stays the same, and tests come first where coverage is thin:

| File | Lines |
|------|-------|
| `src/claude/pty-provider.ts` | 2,476 |
| `src/telegram/message-sender.ts` | 1,449 |
| `src/claude/agent.ts` | 1,387 |
| `src/bot/handlers/command/settings.ts` | 1,153 |

### 4. Codex alongside Claude Code (25–35 h)

When my Claude subscription runs out, the fallback today is CCR, which points Claude Code
at DeepSeek through a local router. Codex, on a ChatGPT plan, would be a fallback with its
own agent loop, tools and models.

It gets one transport, `codex app-server` (JSON-RPC over stdio), which OpenAI documents
for clients that handle approvals and streamed events. There is no PTY mode: the Claude
PTY transport exists because Anthropic bills SDK use apart from the subscription, and
Codex doesn't appear to make that split, so scraping a second TUI would buy nothing.

- Add a Codex provider on `codex app-server`: streamed replies, tool indicators, edit
  diffs, interrupting a turn, and usage
- Route Codex's approval requests through the permission gate and scope guard, using the
  Telegram prompt both Claude transports already have
- Load TeleCoder's stdio MCP server (`src/bin/mcp-server.ts`) into Codex, and support
  `/model`, reasoning effort and images
- Offer Codex in `/provider` and the throttle failover. A switch forks the conversation
  with a summary, as switching to CCR does
- Give Claude-only features such as `/tree`, background tasks and plugins a clear "not on
  Codex" reply, and list what stays behind, as [`site/src/content/docs/guides/providers.md`](site/src/content/docs/guides/providers.md) does for CCR

### 5. Settle the "interrupted by user" misattribution (2–4 h)

Long background tasks sometimes report "Request interrupted by user" when nobody
interrupted them. The foreground variant is understood; the background one is still open.
Findings so far are in
[`docs/debugging/interrupted-by-user-misattribution.md`](docs/debugging/interrupted-by-user-misattribution.md).

### 6. Files over 20 MB (4–6 h)

Telegram's cloud Bot API won't let a bot download a file over 20 MB. Add optional support
for a self-hosted Telegram Bot API server: an opt-in Compose file, docs, and a safe
migration path, since moving a bot token to a local server is hard to undo.

### 7. Regular releases (under 1 h each)

- Publish release notes for each version from 1.2.0 on, so "Unreleased" stays short

## Out of scope

TeleCoder stays a self-hosted client for coding agents like Claude Code and Codex. These
are not planned:

- A hosted or multi-tenant service
- Hosting, training or evaluating AI models
