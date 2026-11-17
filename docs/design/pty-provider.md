# Claude Code in a pty

Every chat runs the real `claude` CLI in a pseudo-terminal. TeleCoder types the prompt into
Claude Code's own TUI and reads the answer back. This note says why, how the parts fit, and
what building it taught. It began in May 2026 as a plan and was rewritten in November 2026 to
describe what was built. The header comments of the files named below are the detailed
reference.

## Why a pty

- **It is Claude Code, not a lookalike.** The interactive CLI brings its own login,
  `CLAUDE.md`, settings, skills, plugins, slash commands and dialogs. Driving it means none of
  that has to be rebuilt, or kept in step with each release.
- **It runs on the login you already have.** A Pro or Max plan covers the interactive CLI. The
  work started in May 2026, when Anthropic announced that Agent SDK and `claude -p` use would
  be metered apart from the subscription, and the Agent SDK doesn't let a third-party product
  offer claude.ai login on it.

The price is that a TUI is not an API: a Claude Code release can move a glyph or reword a
footer. The parts below are built to notice that and stop, not to guess.

The Agent SDK package is still a dependency, for small one-shot Haiku calls that run outside
any chat: naming a conversation's topic, and the charter judge.

## How it works

| Part | What it does | Where |
|------|--------------|-------|
| Spawn | One long-lived `claude` per chat or thread, under `node-pty`, started with `--session-id` or `--resume`. An idle one is ended and resumes from its transcript on the next message | `src/claude/pty-provider.ts`, `pty-idle-reaper.ts` |
| Screen | The pty's output goes into an `@xterm/headless` virtual terminal, so a spinner overwrites itself as it does on a real screen. Claude Code's state is read from the rendered rows | `tui-state.ts` |
| Prompt | Typed into the input box, and checked there before Enter is pressed | `pty-provider.ts` |
| Tool events | The `--settings` payload registers hooks (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`) that POST to a loopback HTTP server in the bot, with a token that reaches them through the pty's environment. They drive the live tool lines and edit diffs. `PreToolUse` is the permission gate, and fails closed | `pty-spawn-config.ts`, `ipc-server.ts`, `permission-gate.ts` |
| End of turn | Inferred from several signals together: the `Stop` hook, a quiet pty with the input box back and no spinner, and the session log having moved | `pty-provider.ts`, `turn-end.ts` |
| Reply text | Read from Claude Code's session log (JSONL): every assistant text block since the prompt. While the turn runs, the screen supplies the block still being written | `session-jsonl.ts`, `pty-stream.ts` |
| Tools that reach Telegram | A stdio MCP server that `claude` starts from `--mcp-config`. Tools that need the bot, such as sending a file or asking a question, call back over the same loopback server | `src/bin/mcp-server.ts`, `mcp-bridge.ts` |
| Dialogs | A dialog Claude Code opens is parsed from the screen and put in the chat as buttons. The tap becomes keystrokes, and no answer presses nothing | `tui-modal.ts`, `modal-relay.ts` |
| Background work | Monitors, backgrounded shells and subagents report after the turn has ended. A relay follows the session log and posts what arrives | `monitor-relay.ts` |
| Other models | Claude Code Router runs the same `claude` in the same pty, started through a shim script that sets CCR's environment for that one process | `ccr-shim.ts` |
| Watching | `telecoder watch` shows a chat's screen in your terminal, read-only | `pty-watch.ts` |

Files without a folder are in `src/claude/`.

## What building it taught

1. **Stripping escape codes doesn't give you the screen.** Spinner frames overdraw in place,
   so with the codes stripped every frame turns up as text. A virtual terminal applies them
   instead, and what is left is what a person would see.
2. **Silence alone says nothing about a turn.** A running turn redraws several times a second, and
   a finished one sits still for as long as you like. The `❯` prompt doesn't separate the two
   either: Claude Code draws it throughout a turn, because you can type while the model
   works. What does track a turn is the footer's `esc to interrupt` and the live spinner
   (`tui-state.ts`).
3. **The reply is not on the screen.** A turn can write several `●` text blocks with tool
   calls between them, and taking the last block drops the prose before it. The session log
   has every block, in the Markdown the model wrote.
4. **Wait before typing.** A prompt typed while Claude Code is still starting is eaten by
   whatever is on screen, such as the folder-trust dialog.
5. **Never guess at a dialog.** Enter pressed at a dialog mistaken for the input box is
   enough to change a setting. A dialog goes to the person the chat belongs to, and one that
   can't be parsed is shown as text with no buttons (`modal-relay.ts`).
6. **The end of a turn is an inference.** No single signal means "Claude is finished".
   `turn-end.ts` records the two cases where the signals mislead, each found by a live
   session hanging.

Two parts of the original plan were not built: a Haiku call to extract the reply when parsing
failed, and a corpus of recorded sessions replayed on every commit. The tests hold rows
recorded from live ptys instead, for example in `tests/claude/tui-state.test.ts`.

## Reading interface facts from the CLI

The parsing rests on facts about Claude Code's interface: the prompt and reply glyphs, footer
and dialog wording, flags and environment variables.

- **Allowed:** reading those observable strings from the Claude Code install on the local
  machine, and measuring them on a live pty. It is licensed software that is already running
  here.
- **Not allowed:** copying code or recognisable structure from it into TeleCoder, or using
  de-obfuscated mirrors of it. Neither is needed: the interface facts are enough.

The first notes are in `prototypes/pty/INTERFACE_NOTES.md`. Later measurements sit in the
comments next to the code that depends on them, with the Claude Code version and terminal
size they were taken at.

## The prototype

`prototypes/pty/` is the prototype from May 2026. `prototype.ts` spawns `claude` under
`node-pty`, types one prompt, waits for the output to go quiet and dumps it raw and stripped.
It showed that spawning and submitting work, and that stripped output is unusable. It is
self-contained and not part of the build.
