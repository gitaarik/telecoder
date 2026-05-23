import type { Bot, Context } from 'grammy';
import { sendToAgent } from '../providers/provider-router.js';
import { sessionManager } from './session-manager.js';
import { sessionHistory } from './session-history.js';
import { queueRequest, setAbortController } from './request-queue.js';
import { messageSender } from '../telegram/message-sender.js';
import { resolveVerbosityFlags } from '../utils/verbosity.js';
import { maybeSendVoiceReply } from '../tts/voice-reply.js';
import { relayCatchUpIfMissed } from '../bot/handlers/message.handler.js';
import { parseSessionKey } from '../utils/session-key.js';
import { buildSyntheticCtx } from './synthetic-ctx.js';
import { scheduler, type Schedule } from './scheduler.js';
import { escapeMarkdownV2 } from '../telegram/markdown.js';

/**
 * Wires the scheduler to the rest of the bot. On boot, registers a fire
 * handler that resolves the session, posts a "🔔 Scheduled" header, then
 * enqueues the schedule's prompt through the normal turn pipeline so the
 * response renders identically to a user-typed message.
 *
 * Failures don't auto-disable on a single miss — the scheduler tracks
 * consecutive failures and disables only after MAX_CONSECUTIVE_FAILURES so
 * transient errors don't silently kill an otherwise healthy schedule.
 */

export function startScheduledRunner(bot: Bot): void {
  scheduler.loadAll((schedule) => fireSchedule(bot, schedule));
}

async function fireSchedule(bot: Bot, schedule: Schedule): Promise<void> {
  const { sessionKey, prompt, label } = schedule;
  const { chatId, threadId } = parseSessionKey(sessionKey);
  const threadOpts = threadId !== undefined ? { message_thread_id: threadId } : {};

  // Resolve the session — restore from disk if the PTY isn't live anymore.
  // The scheduler doesn't capture a long-lived ctx, so cold-restore is
  // expected after bot restart or >1h idle.
  let { session } = sessionManager.getOrRestoreSession(sessionKey);
  if (!session) {
    // Fall back to the most recent persisted entry regardless of age — a
    // user who explicitly scheduled a task wants it to fire even if the
    // session has been idle for a day.
    if (sessionHistory.getLastSession(sessionKey)) {
      session = sessionManager.resumeLastSession(sessionKey) ?? undefined;
    }
  }

  if (!session) {
    // Can't fire — let the user know but keep the schedule armed; they may
    // restore the project shortly.
    try {
      await bot.api.sendMessage(
        chatId,
        `⚠️ Scheduled fire skipped — no project bound to this chat. Use /project to bind one, then the next fire will run\\.`,
        { parse_mode: 'MarkdownV2', ...threadOpts },
      );
    } catch (err) {
      console.error('[ScheduledRunner] failed to notify missing session:', err);
    }
    throw new Error('no session');
  }

  const ctx = buildSyntheticCtx({ api: bot.api, sessionKey, syntheticText: prompt });
  const labelText = label ?? prompt.slice(0, 60);
  await messageSender.postScheduledFire(ctx, labelText, prompt);

  // Enqueue through the same FIFO the user's own messages flow through.
  // If a user turn is already running, the scheduled fire waits behind it
  // instead of racing — same ordering guarantees `/btw`-bypassing commands
  // get when they bypass the queue.
  try {
    await queueRequest(sessionKey, `[scheduled] ${prompt}`, async () => {
      await runScheduledTurn(ctx, sessionKey, prompt);
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      await bot.api.sendMessage(
        chatId,
        `⚠️ Scheduled fire failed: ${escapeMarkdownV2(msg)}`,
        { parse_mode: 'MarkdownV2', ...threadOpts },
      );
    } catch { /* ignore */ }
    throw err instanceof Error ? err : new Error(msg);
  }
}

async function runScheduledTurn(ctx: Context, sessionKey: string, prompt: string): Promise<void> {
  const startTime = Date.now();
  await messageSender.startStreaming(ctx);

  const abortController = new AbortController();
  setAbortController(sessionKey, abortController);

  try {
    const response = await sendToAgent(sessionKey, prompt, {
      onProgress: (progressText) => {
        messageSender.updateStream(ctx, progressText);
      },
      onToolStart: (toolName, input) => {
        messageSender.updateToolOperation(sessionKey, toolName, input, ctx);
      },
      onToolEnd: () => {
        messageSender.clearToolOperation(sessionKey);
      },
      onTaskEvent: (event) => messageSender.notifyTaskEvent(ctx, sessionKey, event),
      onSubTurnResponse: (text) => messageSender.postSubTurnResponse(ctx, text),
      onToolResult: (event) => {
        const cid = ctx.chat?.id;
        if (cid === undefined) return;
        const flags = resolveVerbosityFlags(cid);
        if (!flags.showToolResults) return;
        return messageSender.postToolResult(ctx, event, flags.toolResultMaxLines, flags.toolResultMaxChars);
      },
      onEditDiff: (event) => {
        const cid = ctx.chat?.id;
        if (cid === undefined) return;
        const flags = resolveVerbosityFlags(cid);
        if (!flags.showDiffs) return;
        return messageSender.postEditDiff(ctx, event, flags.diffMaxLines);
      },
      abortController,
      telegramCtx: ctx,
    });

    await messageSender.finishStreaming(ctx, response.text);
    await relayCatchUpIfMissed(ctx, sessionKey, response.text || '');
    await maybeSendVoiceReply(ctx, response.text);
    await messageSender.sendCompletionNotification(ctx, Date.now() - startTime);
  } catch (error) {
    await messageSender.cancelStreaming(ctx);
    throw error;
  }
}
