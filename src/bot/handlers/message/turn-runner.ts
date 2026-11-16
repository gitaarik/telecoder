/**
 * Turn execution: every path that actually runs a user prompt through a
 * provider and renders the result into the chat.
 *
 * `runTurn` is the one path a prompt takes, so the typed-message and
 * suggestion-tap entry points cannot drift apart.
 */

import { Context } from 'grammy';
import { sendToAgent } from '../../../providers/provider-router.js';
import { messageSender } from '../../../telegram/message-sender.js';
import { progressCallbacks, toolCallbacks, withStreamingTurn } from '../../../telegram/streaming-turn.js';
import { maybeSendVoiceReply } from '../../../tts/voice-reply.js';
import { fireAutoTopic } from './shared.js';
import { closeTurn, relayCatchUpIfMissed } from './turn-notify.js';
import { guardSpawn } from '../../../claude/memory-guard.js';


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
  });
}
