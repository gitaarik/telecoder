---
title: Architecture and development
description: How TeleCoder is built, and how to work on it.
sidebar:
  order: 5
---

## Built with

| Area | Technology |
|------|------------|
| Language and runtime | TypeScript on Node.js 22+ |
| Telegram | [grammY](https://grammy.dev/) |
| Claude Code | The real `claude` CLI, driven through `node-pty` and read through `@xterm/headless`; the [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview) only for one-shot Haiku side calls (topic names, the charter judge) |
| Agent tools | [Model Context Protocol](https://modelcontextprotocol.io/) server, for the tools that reach back into Telegram |
| Config and scheduling | Zod, croner |
| Tests | Vitest |
| Optional | Groq and OpenAI for speech, and `ffmpeg` for Groq's spoken replies |

## How it fits together

```
Telegram ⇄ grammY bot ⇄ provider router ─┬─ claude: the CLI in a pty ───┐
           auth, group roles,            │                             ┼─▶ tools on your machine
           batching, queueing            └─ ccr: the same, via a proxy ─┘
                ▲
                └── MCP server: lets the agent ask questions, send files and schedule prompts
```

| Path | What's there |
|------|--------------|
| `src/cli.ts`, `src/cli/` | The `telecoder` command: `start`, `init`, `doctor` and `service` |
| `src/index.ts`, `src/launcher.ts` | Entry points for one bot, or several in worker threads |
| `src/config.ts` | Zod-validated environment config |
| `src/bot/` | Bot setup, command and message handlers, middleware, group access |
| `src/providers/` | Provider router, the Claude and CCR providers, switching, per-user preferences |
| `src/claude/` | PTY provider and TUI parsing, session state and history, watchdog, permission gate, scope guard, charter judge, scheduler, MCP tools |
| `src/bin/` | The MCP server process |
| `src/telegram/` | Streaming, markdown to entities, splitting, task cards |
| `src/startup/` | Restoring chats after a restart |
| `src/audio/`, `src/tts/` | Speech: voice transcription and spoken replies |
| `src/utils/` | Shared helpers, including download, path and error sanitizing |
| `tests/` | Vitest suite, mirroring `src/` |
| `scripts/` | Bot control and shared-bot account setup |
| `site/` | The website and these docs (Astro + Starlight); `npm run build` there checks the Commands page against `src/bot/bot.ts` |
| `docs/` | The old single-page website, [PTY design notes](https://github.com/gitaarik/telecoder/blob/main/docs/design/pty-provider.md), [debugging notes](https://github.com/gitaarik/telecoder/blob/main/docs/debugging/interrupted-by-user-misattribution.md), [example charter](https://github.com/gitaarik/telecoder/blob/main/docs/CHARTER.example.md) |
| `prototypes/pty/` | The prototype that came before the PTY provider |

---

## Development

```bash
npm run dev            # Dev mode with hot reload (tsx watch)
npm run dev:multi      # Run the bots in instances.json
npm test               # Run the test suite
npm run test:coverage  # Tests with a coverage report
npm run typecheck      # Type check only
npm run build          # Compile to dist/
npm start              # Run compiled build
```

CI runs the type check, tests and build on every push. See [CONTRIBUTING.md](https://github.com/gitaarik/telecoder/blob/main/CONTRIBUTING.md).

### Running a checkout

Run the compiled build under a supervisor that starts it again when it exits, and
`/restartbot` and `/rebuildbot` work from the chat:

```bash
npm run build
pm2 start npm --name telecoder -- start      # or: npm run start:multi for instances.json
pm2 logs telecoder                            # Tail logs
```

Not `npm run dev`: if TeleCoder is editing its own codebase, the hot reload restarts it
mid-turn. A restart carries each chat's session on by itself; `/resume` is there for one
it left alone.
