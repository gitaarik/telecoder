# Architecture and development

## Built with

| Area | Technology |
|------|------------|
| Language and runtime | TypeScript on Node.js 22+ |
| Telegram | [grammY](https://grammy.dev/) |
| Claude Code transports | [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview), or the real `claude` CLI through `node-pty` and `@xterm/headless` |
| Agent tools | [Model Context Protocol](https://modelcontextprotocol.io/) server, for the tools that reach back into Telegram |
| Config and scheduling | Zod, croner |
| Tests | Vitest |
| Optional | Groq and OpenAI for speech, and `ffmpeg` for Groq's spoken replies |

## How it fits together

```
Telegram ⇄ grammY bot ⇄ provider router ─┬─ claude: Agent SDK ─────┐
           auth, group roles,            ├─ claude: PTY (real CLI) ┼─▶ tools on your machine
           batching, queueing            └─ ccr: Agent SDK ────────┘
                ▲
                └── MCP server: lets the agent ask questions, send files and schedule prompts
```

| Path | What's there |
|------|--------------|
| `src/cli.ts`, `src/cli/` | The `telecoder` command: `start`, `init`, `doctor` and `service` |
| `src/index.ts`, `src/launcher.ts` | Entry points for one bot, or several in worker threads |
| `src/config.ts` | Zod-validated environment config |
| `src/bot/` | Bot setup, command and message handlers, middleware, group access |
| `src/providers/` | Provider router, SDK and CCR providers, switching, per-user preferences |
| `src/claude/` | PTY provider and TUI parsing, session state and history, watchdog, permission gate, scope guard, charter judge, scheduler, MCP tools |
| `src/bin/` | The MCP server process |
| `src/telegram/` | Streaming, markdown to entities, splitting, Telegraph, task cards |
| `src/startup/` | Restoring chats after a restart |
| `src/audio/`, `src/tts/` | Speech: voice transcription and spoken replies |
| `src/utils/` | Shared helpers, including download, path and error sanitizing |
| `tests/` | Vitest suite, mirroring `src/` |
| `scripts/` | Bot control and shared-bot account setup |
| `docs/` | Website, [PTY design notes](design/pty-provider.md), [debugging notes](debugging/interrupted-by-user-misattribution.md), [example charter](CHARTER.example.md) |
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

CI runs the type check, tests and build on every push. See [CONTRIBUTING.md](../CONTRIBUTING.md).

### Bot control script

```bash
./scripts/telecoder-botctl.sh dev start       # Start dev mode
./scripts/telecoder-botctl.sh dev restart     # Restart dev
./scripts/telecoder-botctl.sh prod start      # Start production
./scripts/telecoder-botctl.sh dev log         # Tail logs
./scripts/telecoder-botctl.sh dev status      # Check if running
```

### Self-editing workflow

If TeleCoder is editing its own codebase, use **prod mode** to avoid hot-reload restarts:

```bash
./scripts/telecoder-botctl.sh prod start      # No hot reload
# ... let Claude edit files ...
./scripts/telecoder-botctl.sh prod restart    # Apply changes
```

Then `/continue` or `/resume` in Telegram to restore your session.
