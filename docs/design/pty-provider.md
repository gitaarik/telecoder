# Pty-driven Claude Code provider

Status: **paused** — design and prototype done; resume closer to the policy date (2026-06-15) or sooner if circumstances change.

## Why this exists

Anthropic announced (article: xda-developers.com — "Anthropic's Claude subscriptions no longer include Agent SDK and claude -p usage") that starting **2026-06-15**, programmatic usage is separated from the Pro/Max subscription:

- **Still on subscription:** interactive Claude (web app, interactive CLI/TUI).
- **Now on a separate metered pool:** Agent SDK, `claude -p`, GitHub Actions, third-party tools using these APIs.

Pool sizes: Pro $20/mo, Max 5x $100/mo, Max 20x $200/mo. After the pool drains, traffic falls back to standard API rates (or pauses if API billing isn't enabled).

Claudegram currently uses `@anthropic-ai/claude-agent-sdk` (see `src/claude/agent.ts`). Under the new policy it draws from the programmatic pool, not the subscription.

**User's framing for keeping it on subscription:** Claudegram is used by a single person as a Telegram skin over Claude Code — the actual usage pattern is identical to a human typing in the interactive CLI, just over a different I/O channel. The goal of this work is to make the technical shape match that framing.

## The constraint

The article doesn't spell out Anthropic's classifier, but the likely signals are:

- Presence of `-p` / `--print` flag
- `--output-format stream-json` flag (what the SDK uses)
- TTY status of stdin/stdout
- Some header the SDK sets on its HTTP calls

So the interactive TUI, running under a real (or pseudo-)TTY, with no programmatic flags, is the shape that should fall on the subscription side.

## Options considered

1. **Accept the metered pool.** Zero engineering work. For light usage, $100/mo on Max 5x may be enough. Doesn't preserve the "remote terminal" framing.
2. **Switch to a different provider** (OpenAI, Gemini, CCR-routed others). Big rewrite. Loses Claude-specific features (Skill system, Claude Code preset, tool-use ergonomics). Sidesteps the policy entirely. CCR is already integrated as a throttle fallback (`f31cef3`).
3. **Pty-driven interactive Claude Code.** Spawn `claude` (no `-p`) under `node-pty`, send prompts via stdin, parse rendered TUI output for the response. Matches the framing. Brittle to TUI changes. → **chosen approach.**
4. **Self-host an open model.** Out of scope here.

Decision: build pty mode as a third provider alongside SDK and CCR, with a per-chat selector. SDK and CCR stay available as fallbacks if Anthropic adds active detection later.

## Architecture

### Provider switch

Slot into the existing `src/providers/types.ts` abstraction (same template as the CCR provider added in `f31cef3`). A `PtyProvider` implements the same `AgentProvider` interface. Add a `/method` command alongside `/model`, persist via `userPreferences`. Likely a single selector enum (`sdk` | `ccr` | `pty`) rather than two parallel toggles.

Session continuity is shareable across providers: all three ultimately spawn the same `claude` binary and read the same on-disk session files. `claude --resume <id>` works regardless of which provider started the session. Worth making this an explicit feature so users can flip between modes without losing context.

### MCP tools

Still needed. Telegram-facing tools (`send_file`, `ask_user`, `set_topic`) bridge the bot to Telegram, not the SDK. Content tools (`fetch_reddit`, `fetch_medium`, `extract_media`) encode useful behavior worth keeping.

What changes is the **transport**:
- SDK mode: in-process MCP via `createClaudegramMcpServer()` (see `src/claude/mcp-tools.ts`).
- Pty mode: MCP server must be a stdio subprocess spawned by `claude` via `--mcp-config`.

Migration: extract `mcp-tools.ts` into a standalone Node bin (e.g. `bin/claudegram-mcp.js`) that the spawned `claude` process loads. The MCP subprocess needs IPC back to the main bot process to actually send Telegram messages (Unix socket or HTTP loopback on localhost). The chat/session ID gets passed per-spawn via env or `--mcp-config`, and the MCP subprocess threads it through every IPC call.

This extraction would also benefit SDK mode (cleaner process boundary), so worth doing first.

### Hook callbacks

Today's in-process JS hooks (`UserPromptSubmit` auto-topic nudge in `src/claude/agent.ts:589-612`, `PreCompact` logger) cannot be JS callbacks under the interactive CLI. They become shell-script hooks in `.claude/settings.json`, or get dropped.

For the auto-topic nudge specifically, the AUTO_TOPIC_HAIKU side-call path is already implemented and is the cleaner alternative — pty mode would just force that path on.

### Event fidelity

SDK mode gives structured `tool_use` / `tool_result` events. Pty mode gives rendered TUI text. The bot's terminal-style UI (tool indicators, footer status) will be lower-fidelity in pty mode. Two options:

- Accept the degradation: pty mode shows a simpler streaming-text UX.
- Backfill events from the parser: detect "Running Bash..." spinner → emit a synthetic tool_start event.

Decision deferred — depends on how nice the v2 parser turns out.

## Parser strategy

Raw `strip-ansi` is insufficient (see prototype findings below). The v2 parser should be layered for resilience to TUI changes:

1. **Render through a virtual terminal.** Use `@xterm/headless` to apply escape codes to a virtual screen instead of stripping them. Spinner frames overwrite each other on the virtual screen instead of accumulating as text. Read the final rendered state.
2. **Cadence-based end-of-turn detection.** The most stable signal is "stdout idle for >N ms AND the input prompt glyph (`❯`) is visible at the bottom." Single-signal regexes are fragile; combine signals (idle window + prompt indicator + cursor home column + no active spinner) and require K-of-N. Survives most reshuffles.
3. **Region-based response extraction.** The `●` glyph prefixes assistant messages on the rendered screen. Extract the region between the latest `●` block and the input box. Visual changes within a region don't break region detection.
4. **Haiku fallback.** If heuristics return something nonsensical (empty, too short, contains spinner artifacts), hand the rendered screen to Haiku with "extract the assistant's last reply." Cheap, robust, only fires on parser misses. Doubles as a regression alarm — track fallback rate per Claude Code version.
5. **Snapshot corpus.** Maintain a dozen recorded sessions on disk. CI replays them against the parser on every commit and every Claude Code version bump. Divergence = early warning.

What this won't survive: Claude Code switching to a fundamentally different paradigm (e.g. multi-pane layout). Rare event, Haiku fallback covers the gap.

## Mining interface facts from the local bundle

To bootstrap the parser, we need stable interface facts: assistant message glyph, prompt glyph, end-of-turn sequences, blocking-dialog text (folder trust, permission requests), flag/env semantics.

Sourcing rules:

- **Allowed:** grep the publicly-distributed minified bundle on the local machine (`~/.local/lib/node_modules/@anthropic-ai/claude-code/cli.js` or wherever the local install is). It's licensed code we already run. Document only observable interface strings.
- **Disallowed:** copying code or recognizable structure into Claudegram; using DMCA'd de-obfuscated mirrors. Both raise real account-revocation risk and aren't necessary — the interface facts are enough.

Output of this work goes in `prototypes/pty/INTERFACE_NOTES.md` (not yet written).

## Prototype findings (2026-05-14)

Prototype lives in `prototypes/pty/` (self-contained, doesn't touch main `package.json`):

- `prototype.ts` — spawns `claude` with `node-pty`, waits for REPL idle, types prompt, waits for end-of-turn via idle window, dumps raw + stripped output.
- Dependencies: `node-pty`, `strip-ansi` (v1 only — v2 will swap for `@xterm/headless`).

**Validated:**

- `node-pty` spawn of `claude --dangerously-skip-permissions` works.
- Sending the prompt as `<text>\r` correctly submits to the REPL.
- Idle-window end-of-turn detection (IDLE_MS = 1200) fires correctly — Claude responded with `PONG` and the prototype caught it within ~1-2 s.
- `waitForIdle()` before typing is necessary to avoid the prompt being eaten by a startup dialog (e.g. folder-trust check). Default cwd to a known-trusted directory.

**Open / unresolved:**

- `strip-ansi` produces unusable output. Spinner animations overdraw in place; without a virtual terminal applying the escapes, every frame appears as separate text. The signal (`●PONG`) is in there but buried. → must upgrade to `@xterm/headless` for v2.
- We **cannot validate billing** until 2026-06-15. The technical shape (interactive TUI, no `-p`, no `stream-json`) is the right shape, but Anthropic may add server-side heuristics. Keep SDK/CCR providers available as fallbacks.

## Suggested next-step order when resuming

1. Mine interface facts from the local bundle → `prototypes/pty/INTERFACE_NOTES.md`.
2. Extract MCP into a subprocess + IPC scheme (benefits SDK mode too).
3. Build v2 prototype with `@xterm/headless`, region-based extraction, Haiku fallback hook.
4. Wire into the `AgentProvider` abstraction as `PtyProvider`.
5. Snapshot-corpus harness + parser regression tests.
6. `/method` switcher + persisted preference.
7. Roll out shadow-mode (SDK in foreground, pty mode logged for comparison) before flipping the default.

Step 1 is small and unblocks the parser design. Step 2 is the largest mechanical refactor. Step 3 is the gating risk — if `@xterm/headless` rendering plus region extraction doesn't produce clean output reliably, the whole plan needs a rethink.

## Files touched by this work so far

- `prototypes/pty/package.json`
- `prototypes/pty/tsconfig.json`
- `prototypes/pty/prototype.ts`
- `docs/design/pty-provider.md` (this file)

No changes to `src/` yet.
