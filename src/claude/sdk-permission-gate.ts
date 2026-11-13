import type { Context } from 'grammy';
import type { HookCallbackMatcher, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { gateHookTimeoutSeconds, gateToolCall } from './permission-gate.js';

/**
 * The permission gate on the SDK transport, and so on CCR, which always takes
 * the SDK path.
 *
 * The PTY transport runs the gate as a PreToolUse command hook that calls back
 * into the bot over IPC. Here the CLI is driven through the agent SDK, which
 * takes PreToolUse hooks as in-process callbacks, so the same decision is made
 * by the same function (gateToolCall) without the round trip. A PreToolUse
 * hook rather than canUseTool, for two reasons: canUseTool is only asked about
 * calls the permission rules leave open, and the curated `allowedTools` list
 * pre-approves Bash, Write and the rest; and a hook fires in every permission
 * mode, bypass included, which is what the PTY hook does too — so a chat's
 * /mode means the same thing on both transports.
 *
 * Hooks fire for a subagent's tool calls as well (their input carries an
 * `agent_id`), so a Task or a background agent is gated like the main thread.
 */

/**
 * The Telegram update behind each session's latest turn. A query can outlive
 * the turn that started it — it is held open for background work, and the
 * chat's next message joins it — and the gate has to prompt about, and name,
 * whoever's turn it is now, as the PTY gate does through its registered turn.
 */
const turnContexts = new Map<string, Context>();

/**
 * Record `ctx` as the update behind `sessionKey`'s current turn. A turn with
 * none clears it, so the gate denies rather than prompting on behalf of an
 * earlier turn's sender — as a PTY turn without a context does.
 */
export function noteTurnContext(sessionKey: string, ctx: Context | undefined): void {
  if (ctx) turnContexts.set(sessionKey, ctx);
  else turnContexts.delete(sessionKey);
}

/** Forget a session's turn context, for tests and a cleared conversation. */
export function forgetTurnContext(sessionKey: string): void {
  turnContexts.delete(sessionKey);
}

/**
 * The PreToolUse matcher that runs the gate for `sessionKey`'s query.
 *
 * Registered whether or not the gate is on: it is checked per call, so a bot
 * that gains a guest mid-query gets the gate on its next tool call, and the
 * hook set a held query is matched on stays the same either way.
 */
export function permissionGateHook(sessionKey: string): HookCallbackMatcher {
  return {
    // Long enough for an unanswered prompt to time out into the gate's own
    // denial. A hook that times out is skipped, so the call would run.
    timeout: gateHookTimeoutSeconds(),
    hooks: [async (input): Promise<HookJSONOutput> => {
      if (input.hook_event_name !== 'PreToolUse') return { continue: true };
      const toolInput = input.tool_input;
      const decision = await gateToolCall({
        sessionKey,
        toolName: String(input.tool_name ?? 'unknown'),
        toolInput: toolInput && typeof toolInput === 'object'
          ? toolInput as Record<string, unknown>
          : {},
        telegramCtx: turnContexts.get(sessionKey),
      });
      if (!decision.block) return { continue: true };
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: decision.reason,
        },
      };
    }],
  };
}
