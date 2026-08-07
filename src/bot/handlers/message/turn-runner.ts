/**
 * Turn execution: every path that actually runs a user prompt through a
 * provider and renders the result into the chat.
 *
 * `runTurn` is the single place the streaming-vs-wait choice is made, so the
 * typed-message, suggestion-tap and throttle-retry entry points cannot drift
 * apart. `handleCcrThrottleCallback` lives here rather than in throttle.ts
 * because it re-runs a prompt — keeping it here lets throttle.ts stay a leaf.
 */

import { Context } from 'grammy';
import { sendToAgent, getActiveProviderName } from '../../../providers/provider-router.js';
import { switchProvider } from '../../../providers/provider-switch.js';
import type { ToolResultEvent, EditDiffEvent, TaskEvent } from '../../../providers/types.js';
import { config } from '../../../config.js';
import { setAbortController } from '../../../claude/request-queue.js';
import { messageSender } from '../../../telegram/message-sender.js';
import { maybeSendVoiceReply } from '../../../tts/voice-reply.js';
import { getSessionKeyFromCtx } from '../../../utils/session-key.js';
import { resolveVerbosityFlags } from '../../../utils/verbosity.js';
import { getStreamingMode, sendStatusLine } from '../command.handler.js';
import { fireAutoTopic, runQueuedTurn } from './shared.js';
import { sendTurnNotifications } from './turn-notify.js';
import { lastThrottledPrompt, postThrottlePrompt } from './throttle.js';

/**
 * Build the `onToolResult` callback passed to the provider runner. Resolves
 * verbosity flags lazily on each event so a /verbosity change mid-turn takes
 * effect immediately, and short-circuits when the chat opts out of tool
 * previews entirely.
 */
function makeToolResultHandler(ctx: Context): (event: ToolResultEvent) => Promise<void> | undefined {
  return (event) => {
    const cid = ctx.chat?.id;
    if (cid === undefined) return;
    const flags = resolveVerbosityFlags(cid);
    if (!flags.showToolResults) return;
    return messageSender.postToolResult(ctx, event, flags.toolResultMaxLines, flags.toolResultMaxChars);
  };
}

/** Companion to `makeToolResultHandler` for Edit/Write diff previews. */
function makeEditDiffHandler(ctx: Context): (event: EditDiffEvent) => Promise<void> | undefined {
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

export async function handleCcrThrottleCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith('ccr_throttle:')) return;

  const action = data.replace('ccr_throttle:', '');
  const sessionKeyInfo = getSessionKeyFromCtx(ctx);
  if (!sessionKeyInfo) {
    await ctx.answerCallbackQuery({ text: 'Session not found' });
    return;
  }
  const { sessionKey } = sessionKeyInfo;
  const chatId = ctx.chat?.id;

  if (action === 'cancel') {
    lastThrottledPrompt.delete(sessionKey);
    await ctx.answerCallbackQuery({ text: 'Cancelled' });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    return;
  }

  if (action === 'switch') {
    if (!config.CCR_ENABLED || !chatId) {
      await ctx.answerCallbackQuery({ text: 'CCR not available' });
      return;
    }
    const pending = lastThrottledPrompt.get(sessionKey);
    if (getActiveProviderName(chatId) !== 'ccr') {
      // Fork onto a fresh CCR session, carrying over a summary so the retry
      // keeps context. A direct resume would replay the Anthropic session's
      // thinking blocks; CCR tolerates that, but forking keeps the two
      // backends' sessions cleanly separated for the eventual switch back.
      await switchProvider(sessionKey, chatId, 'ccr');
    }
    lastThrottledPrompt.delete(sessionKey);

    await ctx.answerCallbackQuery({ text: 'Switched to CCR' });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined });

    if (!pending) {
      await ctx.reply(
        '🔌 Switched to CCR\\. Send your message again to retry\\.',
        { parse_mode: 'MarkdownV2' },
      );
      return;
    }

    await ctx.reply('🔁 Retrying via CCR\\.\\.\\.', { parse_mode: 'MarkdownV2' });
    await runQueuedTurn(ctx, sessionKey, pending, 'CcrRetry', () =>
      runTurn(ctx, sessionKey, chatId, pending),
    );
  }
}

/**
 * Run one prompt in whichever response mode the chat is currently set to.
 * Every entry point that executes a user prompt funnels through here, so the
 * streaming-vs-wait decision lives in exactly one place.
 */
export async function runTurn(
  ctx: Context,
  sessionKey: string,
  chatId: number,
  message: string,
): Promise<void> {
  if (getStreamingMode() === 'streaming') {
    await handleStreamingResponse(ctx, sessionKey, message);
  } else {
    await handleWaitResponse(ctx, sessionKey, chatId, message);
  }
}

/**
 * Entry point used by callback-triggered prompts (suggestion-tap, CCR
 * throttle retry). Dispatches through the same code path a typed message
 * would take, and fires the topic update so the bot name still tracks the
 * topic the user implicitly chose by tapping.
 */
export async function dispatchPromptFromCallback(
  ctx: Context,
  sessionKey: string,
  chatId: number,
  message: string,
): Promise<void> {
  fireAutoTopic(ctx, sessionKey, message);
  await runTurn(ctx, sessionKey, chatId, message);
}

async function handleStreamingResponse(
  ctx: Context,
  sessionKey: string,
  message: string
): Promise<void> {
  const startTime = Date.now();
  await messageSender.startStreaming(ctx);

  const abortController = new AbortController();
  setAbortController(sessionKey, abortController);

  try {
    const response = await sendToAgent(sessionKey, message, {
      ...progressCallbacks(ctx),
      ...toolCallbacks(ctx, sessionKey),
      abortController,
      telegramCtx: ctx,
    });

    await messageSender.finishStreaming(ctx, response.text, { nextPromptSuggestion: response.nextPromptSuggestion });
    await maybeSendVoiceReply(ctx, response.text);

    // Completion notification for long tasks (streaming edits don't trigger push notifications)
    await messageSender.sendCompletionNotification(ctx, Date.now() - startTime);

    // Context visibility notifications
    await sendTurnNotifications(ctx, sessionKey, response);

    const chatId = ctx.chat?.id;
    if (chatId !== undefined) await sendStatusLine(ctx, chatId, sessionKey, response.usage, message);

    if (response.throttle) {
      await postThrottlePrompt(ctx, sessionKey, message, response.throttle);
    } else {
      lastThrottledPrompt.delete(sessionKey);
    }
  } catch (error) {
    await messageSender.cancelStreaming(ctx, error as Error);
    throw error;
  }
}

async function handleWaitResponse(
  ctx: Context,
  sessionKey: string,
  chatId: number,
  message: string
): Promise<void> {
  // Start continuous typing indicator (every 4s)
  const keyInfo = getSessionKeyFromCtx(ctx);
  const typingInterval = messageSender.startTypingIndicator(ctx.api, chatId, keyInfo?.threadId);

  const abortController = new AbortController();
  setAbortController(sessionKey, abortController);

  try {
    const response = await sendToAgent(sessionKey, message, {
      abortController,
      telegramCtx: ctx,
      onToolResult: makeToolResultHandler(ctx),
      onEditDiff: makeEditDiffHandler(ctx),
    });
    messageSender.stopTypingInterval(typingInterval);

    const sentId = await messageSender.sendMessage(ctx, response.text);
    await messageSender.attachForkButton(ctx, sessionKey, sentId);
    await maybeSendVoiceReply(ctx, response.text);

    // Context visibility notifications
    await sendTurnNotifications(ctx, sessionKey, response);

    await sendStatusLine(ctx, chatId, sessionKey, response.usage, message);

    if (response.throttle) {
      await postThrottlePrompt(ctx, sessionKey, message, response.throttle);
    } else {
      lastThrottledPrompt.delete(sessionKey);
    }
  } catch (error) {
    messageSender.stopTypingInterval(typingInterval);
    throw error;
  }
}
