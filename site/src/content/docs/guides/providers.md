---
title: Providers
description: SDK or PTY mode, and Claude Code Router for when your plan throttles.
sidebar:
  order: 5
---

Claude Code is the backend. What varies is the model behind it: a provider router
sits in front of every message, so when Max throttles or you want a different model,
the bot keeps working instead of stopping.

| Provider | What it is | Enable |
|----------|------------|--------|
| `claude` | Claude Code itself, over one of two transports (`/method`): **SDK** (default, Claude Agent SDK) or **PTY** (drives the real `claude` CLI in a pseudo-terminal) | on by default |
| `ccr` | The same `claude` binary, routed through a local [Claude Code Router](https://github.com/musistudio/claude-code-router) proxy so non-Anthropic models can back it | `CCR_ENABLED=true` |

`/provider` opens a picker listing the enabled backends. `/ccr` is a one-tap toggle
between Claude and CCR for the common "I'm throttled, keep going" case. Both are
sticky — the choice holds until you switch back.

## Throttle failover

When a Max usage-limit throttle is detected mid-turn, the bot doesn't just surface
the error — it offers a **🔌 Switch to CCR & retry** button, with the reset time when
one can be parsed from the response. One tap moves the session to CCR and replays the
message you just sent. Set `CCR_AUTO_PROMPT_ON_THROTTLE=false` for a plain error instead.

If the CCR proxy isn't reachable, `CCR_AUTOSTART=true` runs `ccr start` in the background
rather than letting the request hang on a refused connection.

## Switching mid-conversation

Sessions can't cross backends — one model can't replay another's thinking blocks, and
attempting it fails with a signature error. So a switch that would abandon a live session
asks for confirmation first, then **forks**: a fresh session starts on the new backend,
carrying a plain-text summary of the conversation so far. The model preference is cleared
at the same time, since `opus`/`sonnet`/`haiku` don't map 1:1 once CCR's router decides
the real backend per request.

## What stays behind on CCR

CCR runs the same agent, so nearly everything carries over. The exception:

- **PTY transport** — `ccr` always takes the SDK path, along with the PTY-only
  features layered on it. The permission gate isn't one of them: it runs on the
  SDK path too

```bash
# .env
CCR_ENABLED=true
CCR_BASE_URL=http://localhost:3456
CCR_AUTH_TOKEN=your_ccr_token
CCR_AUTO_PROMPT_ON_THROTTLE=true
CCR_AUTOSTART=false
```
