/**
 * The parts of running a streamed agent turn that don't depend on *why* the
 * turn is running.
 *
 * Lives under `telegram/` rather than with the message handlers because the
 * scheduler drives turns too, and `claude/scheduled-runner.ts` cannot import
 * the handler layer without closing a cycle. Everything here depends only on
 * the message sender, the request queue and the verbosity settings — all of
 * which sit below both callers.
 */

import type { Context } from 'grammy';
import type { ToolResultEvent, EditDiffEvent, TaskEvent } from '../providers/types.js';
import { setAbortController } from '../claude/request-queue.js';
import { resolveVerbosityFlags } from '../utils/verbosity.js';
import { messageSender } from './message-sender.js';

/**
 * Build the `onToolResult` callback passed to the provider runner. Resolves
 * verbosity flags lazily on each event so a /verbosity change mid-turn takes
 * effect immediately, and short-circuits when the chat opts out of tool
 * previews entirely.
 */
export function makeToolResultHandler(ctx: Context): (event: ToolResultEvent) => Promise<void> | undefined {
  return (event) => {
    const cid = ctx.chat?.id;
    if (cid === undefined) return;
    const flags = resolveVerbosityFlags(cid);
    if (!flags.showToolResults) return;
    return messageSender.postToolResult(ctx, event, flags.toolResultMaxLines, flags.toolResultMaxChars);
  };
}

/** Companion to `makeToolResultHandler` for Edit/Write diff previews. */
export function makeEditDiffHandler(ctx: Context): (event: EditDiffEvent) => Promise<void> | undefined {
  return (event) => {
    const cid = ctx.chat?.id;
    if (cid === undefined) return;
    const flags = resolveVerbosityFlags(cid);
    if (!flags.showDiffs) return;
    return messageSender.postEditDiff(ctx, event, flags.diffMaxLines);
  };
}

/**
 * Callbacks that render a turn's progress into the streaming message. Shared
 * by every streaming entry point, including /loop — which takes only these,
 * since `sendLoopToAgent` reports iteration progress rather than individual
 * tool calls.
 */
export function progressCallbacks(ctx: Context) {
  return {
    onProgress: (progressText: string) => {
      messageSender.updateStream(ctx, progressText);
    },
    onTip: (tip: string | null) => {
      messageSender.updateTip(ctx, tip);
    },
    onToolResult: makeToolResultHandler(ctx),
    onEditDiff: makeEditDiffHandler(ctx),
  };
}

/**
 * Per-tool telemetry on top of `progressCallbacks`, for the `sendToAgent`
 * paths that surface the running tool in the stream header and relay
 * sub-agent output.
 */
export function toolCallbacks(ctx: Context, sessionKey: string) {
  return {
    onToolStart: (toolName: string, input?: Record<string, unknown>) => {
      messageSender.updateToolOperation(sessionKey, toolName, input, ctx);
    },
    onToolEnd: () => {
      messageSender.clearToolOperation(sessionKey);
    },
    onTaskEvent: (event: TaskEvent) => messageSender.notifyTaskEvent(ctx, sessionKey, event),
    onSubTurnResponse: (text: string) => messageSender.postSubTurnResponse(ctx, text),
  };
}

/**
 * Open a streaming message, run `body` against a fresh abort controller, and
 * guarantee the stream is torn down if anything throws.
 *
 * Every caller previously repeated this preamble by hand. Two invariants are
 * easy to lose that way and are now structural: the session's abort controller
 * is always registered before the provider is called (so /cancel can reach the
 * turn), and a failure always replaces the spinner with the error rather than
 * leaving it animating forever.
 *
 * The error is re-thrown after teardown so the caller's own queue handling —
 * "Queue cleared" suppression, error replies — still sees it.
 */
export async function withStreamingTurn(
  ctx: Context,
  sessionKey: string,
  body: (abortController: AbortController) => Promise<void>,
): Promise<void> {
  await messageSender.startStreaming(ctx);

  const abortController = new AbortController();
  setAbortController(sessionKey, abortController);

  try {
    await body(abortController);
  } catch (error) {
    await messageSender.cancelStreaming(ctx, error as Error);
    throw error;
  }
}
