/**
 * Turn execution: every path that actually runs a user prompt through a
 * provider and renders the result into the chat.
 *
 * `runTurn` is the one path a prompt takes, so the typed-message,
 * suggestion-tap and throttle-retry entry points cannot drift apart.
 * `handleCcrThrottleCallback` lives here rather than in throttle.ts because it
 * re-runs a prompt — keeping it here lets throttle.ts stay a leaf.
 */

import { Context } from 'grammy';
import { sendToAgent, getActiveProviderName } from '../../../providers/provider-router.js';
import { switchProvider } from '../../../providers/provider-switch.js';
import { config } from '../../../config.js';
import { messageSender } from '../../../telegram/message-sender.js';
import { progressCallbacks, toolCallbacks, withStreamingTurn } from '../../../telegram/streaming-turn.js';
import { maybeSendVoiceReply } from '../../../tts/voice-reply.js';
import { getSessionKeyFromCtx } from '../../../utils/session-key.js';
import { fireAutoTopic, runQueuedTurn } from './shared.js';
import { closeTurn, relayCatchUpIfMissed } from './turn-notify.js';
import { lastThrottledPrompt, postThrottlePrompt } from './throttle.js';
import { guardSpawn } from '../../../claude/memory-guard.js';


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
    if (getActiveProviderName(sessionKey) !== 'ccr') {
      // Fork onto a fresh CCR session, carrying over a summary so the retry
      // keeps context. A direct resume would replay the Anthropic session's
      // thinking blocks; CCR tolerates that, but forking keeps the two
      // backends' sessions cleanly separated for the eventual switch back.
      await switchProvider(sessionKey, 'ccr');
    }
    lastThrottledPrompt.delete(sessionKey);

    await ctx.answerCallbackQuery({ text: 'Switched to CCR' });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined });

    if (!pending) {
      await ctx.reply('🔌 Switched to CCR. Send your message again to retry.');
      return;
    }

    await ctx.reply('🔁 Retrying via CCR...');
    await runQueuedTurn(ctx, sessionKey, pending, 'CcrRetry', () =>
      runTurn(ctx, sessionKey, pending),
    );
  }
}

/**
 * Run one prompt in whichever response mode the chat is currently set to.
 * Every entry point that executes a user prompt funnels through here, so the
 * streaming-vs-wait decision lives in exactly one place.
 */
export async function runTurn(ctx: Context, sessionKey: string, message: string): Promise<void> {
  // A message that would start a new claude on a machine short of memory is
  // held until the chat says so (see memory-guard.ts). One to a running
  // claude passes straight through.
  const guard = await guardSpawn(ctx, sessionKey);
  if (!guard.proceed) {
    await ctx.reply(guard.message);
    return;
  }
  await streamTurn(ctx, sessionKey, message);
}

/**
 * Entry point used by callback-triggered prompts (suggestion-tap, CCR
 * throttle retry). Dispatches through the same code path a typed message
 * would take, and fires the topic update so the bot name still tracks the
 * topic the user implicitly chose by tapping.
 */
export async function dispatchPromptFromCallback(ctx: Context, sessionKey: string, message: string): Promise<void> {
  fireAutoTopic(ctx, sessionKey, message);
  await runTurn(ctx, sessionKey, message);
}

async function streamTurn(
  ctx: Context,
  sessionKey: string,
  message: string
): Promise<void> {
  const startTime = Date.now();

  await withStreamingTurn(ctx, sessionKey, message, async (abortController) => {
    const response = await sendToAgent(sessionKey, message, {
      ...progressCallbacks(ctx),
      ...toolCallbacks(ctx, sessionKey),
      abortController,
      telegramCtx: ctx,
    });

    await messageSender.finishStreaming(ctx, response.text, { nextPromptSuggestion: response.nextPromptSuggestion });
    await relayCatchUpIfMissed(ctx, sessionKey, response.text || '');
    await maybeSendVoiceReply(ctx, response.text);

    // Completion notification for long tasks (streaming edits don't trigger push notifications)
    await messageSender.sendCompletionNotification(ctx, Date.now() - startTime);

    await closeTurn(ctx, sessionKey, response, message);

    if (response.throttle) {
      await postThrottlePrompt(ctx, sessionKey, message, response.throttle);
    } else {
      lastThrottledPrompt.delete(sessionKey);
    }
  });
}
