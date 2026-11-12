/**
 * Keeps work still running in the background in sight after a command answers.
 *
 * A turn closes with the status line, which counts what runs. A command's
 * answer doesn't, and lands below whatever said a task was running, so after
 * a /btw or a /cost the chat reads as if nothing is going on. Under such an
 * answer the background card comes down again (PTY); without one, in SDK
 * mode, a line says how many tasks run.
 */

import type { Context } from 'grammy';
import { isProcessing } from '../../claude/request-queue.js';
import { bringCardDown } from '../../telegram/background-activity-card.js';
import { taskTracker } from '../../telegram/task-tracker.js';
import { EntityText } from '../../telegram/entities.js';
import { replyFormatted } from '../../telegram/send.js';
import { getSessionKeyFromCtx } from '../../utils/session-key.js';

export async function noteStillRunning(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;
  // A turn is under way: it closes with the status line, and the card under it.
  if (isProcessing(sessionKey)) return;
  if (bringCardDown(sessionKey)) return;
  const running = taskTracker.getBackgroundedCount(sessionKey);
  if (running === 0) return;
  const tasks = `${running} task${running === 1 ? '' : 's'}`;
  try {
    await replyFormatted(
      ctx,
      new EntityText().italic(`⏳ ${tasks} still running · `).add('/tasks').build(),
      { disable_notification: true },
    );
  } catch (err) {
    console.debug('[RunningNote] Failed to send:', err instanceof Error ? err.message : err);
  }
}

/** A command handler that ends with {@link noteStillRunning}. */
export function withRunningNote(handler: (ctx: Context) => Promise<void>): (ctx: Context) => Promise<void> {
  return async (ctx) => {
    await handler(ctx);
    await noteStillRunning(ctx);
  };
}
