# "Request interrupted by user" misattribution

Status: **open** — root cause for the *background-task* variant not yet pinpointed. The foreground-bash variant is understood (Bash tool's 10-min cap).

## Symptom

The user reports seeing "Request interrupted by user" / "user sent SIGKILL" / "aborted by user" appear during long-running tool calls when they did not actually press cancel. This causes Claude to misattribute the kill to the user, sometimes leading to apology loops or incorrect retries.

## Confirmed causes

### 1. Foreground Bash tool's 10-min hard cap

Source: Claude Code SDK's Bash tool documentation — `timeout` parameter is capped at `600000ms`. When a foreground `Bash` call exceeds that, the SDK sends SIGKILL to the child and surfaces it as "Request interrupted by user for tool use". The wording is misleading; it's the tool's own enforcement, not the user.

**Workaround for the model:** for any command that may exceed ~5 min (docker builds, long test suites, deploys), use `run_in_background: true`. Backgrounded commands detach and bypass the 10-min cap.

**Not fixable in Claudegram** — this is SDK-level. As of SDK v0.2.84 the wording is supposed to no longer say "interrupted by user" for non-user causes, but in practice we still see it in this scenario.

## Investigated and ruled out

### Hypothesis A: AgentWatchdog firing silence/stale timeout after `result`

Date investigated: 2026-05-13.

**Theory:** After the model launches a backgrounded task (`run_in_background:true` Bash or `Monitor`) and the turn ends with `result/success`, the SDK goes silent waiting for the backgrounded task's events. The default `AGENT_SILENCE_TIMEOUT_MS=180000` (3 min) would then trip and call `controller.abort()`, which the SDK reports as "interrupted by user".

**Reproduction harness:** `src/utils/debug-watchdog.ts` with `SILENCE_MS=20000` confirmed that *if* the watchdog runs after a `result`, it does fire silence timeout and aborts — surfacing the misleading wording.

**Why it was ruled out:** `src/claude/agent.ts:942` already calls `watchdog?.stop()` on every `result` message. Re-running the harness with production-faithful stop-on-result (`/tmp/watchdog-prod-bgsleep.log`, `/tmp/watchdog-prod-monitor.log`) showed both prompts complete cleanly — long quiet periods after `result` do **not** trigger any abort in production. The first repro was a self-inflicted artifact of the harness not matching production behavior.

**Lesson:** when writing a repro harness, mirror the production code path exactly (in particular every `start`/`stop`/`onEvent` boundary) before claiming a mechanism is the cause.

### Hypothesis B: tool_progress / stream_event heartbeats triggering stale-tool timeout

**Theory:** `tool_progress` and `stream_event` are not in `MEANINGFUL_MESSAGE_TYPES`, so they reset the silence timer but not the stale-tool timer. A long backgrounded wait that emits only these would trip `AGENT_STALE_TOOL_TIMEOUT_MS`.

**Why it was ruled out:** in the repro logs, the SDK emits **zero** messages during the post-result quiet period — neither heartbeats nor stream events. So this path is moot for the backgrounded-task scenario. The stale-tool timeout *can* still fire for genuine long-running foreground tools, but that's its intended purpose.

### Hypothesis C: SDK has a known bug in our version

**Status:** mostly ruled out for "interrupted by user" wording specifically. SDK changelog shows:
- **v0.2.84** — Fixed showing "Request interrupted by user" for errors that were not caused by user interruption.
- **v0.2.91** — Added `terminal_reason` field on result messages.

We were on **v0.2.119**, both fixes already in. **Upgraded to v0.2.140 on 2026-05-13** anyway for general parity (typecheck clean, debug-watchdog smoke test clean). No changelog entries between 0.2.119 and 0.2.140 address this issue specifically.

**Known deprecations in 0.2.140 affecting Claudegram (non-blocking):**
- `'Skill'` in `tools` / `allowedTools` arrays at `src/claude/agent.ts:495,499`. The SDK now exposes a dedicated `skills?:` field. Migration is a follow-up — current usage still works.
- `'TodoWrite'` is deprecated as a tool name in favor of `TaskCreate`/`TaskGet`/`TaskUpdate`/`TaskList` (v0.2.136). Still listed in our tools arrays and detected by name in `src/telegram/message-sender.ts:303` for UI rendering. Functional today; migration deferred until the deprecated path is actually removed.

## Still open

The user's *background-process kill* complaint remains unexplained. With the watchdog hypothesis ruled out and the SDK already containing the relevant fix, we have no captured production evidence for the symptom — only Claudegram 4's misdiagnosis of a single foreground docker-build incident (which was actually the Bash 10-min cap).

Possible mechanisms we have not yet ruled out:
- Bash tool's 10-min cap somehow applying to backgrounded commands (would contradict its documented behavior, but worth verifying with a controlled test).
- Network/SDK glitch causing an unrelated error to surface with the "interrupted" wording.
- The user conflating distinct incidents (foreground Bash-cap kills with separate background hangs).
- A hook or middleware in Claudegram silently calling `controller.abort()` somewhere we haven't audited (worth a grep for all `abort()` callers and adding diagnostic logging).

## Diagnostic added 2026-05-13

`agent.ts` now logs the SDK's `terminal_reason` field on every result message at `basic` log level. When `terminal_reason !== 'completed'`, this tells us exactly why the query ended:

- `aborted_streaming` — explicit `controller.abort()` during streaming
- `aborted_tools` — abort during a tool call
- `max_turns`, `blocking_limit`, `prompt_too_long`, `model_error`, etc.

Each `controller.abort()` call site also logs a distinct reason string, so we can correlate.

## What to do next time this happens

1. Note timestamp + bot (`Claudegram N`) + whether the killed command was foreground or background.
2. Pull `claudegram.log` (or the launcher's stdout) for the 60s around the kill.
3. Grep for `WATCHDOG`, `TERMINAL_REASON`, `Cancel flag detected`, and `controller.abort` related lines.
4. If `TERMINAL_REASON: aborted_streaming` appears but no Claudegram-side abort log precedes it, the abort came from inside the SDK (likely Bash tool cap or similar).

## Files involved

- `src/claude/agent.ts` — query loop, watchdog wiring, abort sites (lines 651/658/666 historically; check current line numbers).
- `src/claude/agent-watchdog.ts` — watchdog implementation. Silence + stale-tool timeouts. `shouldPauseTimeouts` callback for legitimate waits.
- `src/config.ts` — `AGENT_*` env-var defaults (`AGENT_SILENCE_TIMEOUT_MS=180000`, `AGENT_STALE_TOOL_TIMEOUT_MS=180000`, `AGENT_QUERY_TIMEOUT_MS=0`).
- `src/utils/debug-watchdog.ts` — repro harness. Run with `PROMPT=monitor` or `PROMPT=bgsleep`, `SILENCE_MS` and `STALE_MS` env vars override timeouts.
