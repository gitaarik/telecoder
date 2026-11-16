---
title: Security
description: What's protected, what's stored and where your data goes.
sidebar:
  order: 4
---

- **User whitelist** — only approved Telegram IDs can interact
- **Admins & guests** — a shared bot can reserve approvals, lifecycle and
  transport for `ADMIN_USER_IDS`; see [Sharing a bot](../guides/sharing.md)
- **Group confinement** — `RESTRICT_TO_GROUPS` keeps guests out of private chats
- **Group roles** — inside a group, admins / contributors / spectators, so being
  in the chat need not mean being able to prompt the agent (`GROUP_MEMBERS_DEFAULT`)
- **Addressed-only** — `GROUP_REQUIRE_MENTION` keeps human conversation in a
  shared group from becoming prompts
- **Permission gate** — dangerous Bash patterns pause for an admin's approval,
  on the SDK and PTY transports alike (CCR included), subagents too
- **Scope guard** — tool calls reaching outside the shared projects, or at any
  credential path, pause too
- **Charter judge** — guest messages are read against a charter before they run
- **Project sandbox** — the project picker is scoped to `WORKSPACE_DIR`
- **Permission mode** — `/mode` sets how much Claude asks before acting
- **Secrets** — loaded from `.env` (gitignored), never committed
- **Secret requests** — a key Claude asks for goes from your message into the
  command it named, and the message is deleted; Claude sees only the result.
  Private chats with an admin only
- **Gate fails closed** — in PTY mode a tool runs only on the bot's explicit
  allow: if the bot can't be reached (restarting, erroring), the tool is
  blocked. Background agents and turns Claude starts on its own between your
  messages go through the gate too, in the chat the session belongs to
- **Local IPC token** — the loopback server the hooks and MCP tools talk to
  requires a random per-process token, passed through the environment only,
  so other users on the machine can't drive it

## What it stores and sends

TeleCoder has no server of its own. Its state stays on your machine, in `~/.telecoder`
(owner-only permissions), and includes session metadata and preferences. Before November 2026
it was `~/.claudegram`: the launcher moves that across on its first start and leaves a link
at the old path. On a shared bot it
also includes the Telegram ids and names of the people it has seen or let in.

Your messages go to Telegram and to Claude Code, and from there to the model provider you
use. A secret you send when Claude asks for one is the exception: it goes to Telegram like any
message, until the bot deletes it, and from there only into the command Claude named. A Claude
token made with `claude setup-token` doesn't go through Telegram at all. Claude Code keeps its own session transcripts in `~/.claude`. Voice and text-to-speech
go to Groq or OpenAI, and only if you configure them. Nothing is published anywhere: a long
reply arrives in the chat in full, and `/handoff` sends its note as a file.
