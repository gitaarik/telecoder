/**
 * A view: one message that /tree and /prompts redraw in place as their
 * buttons are tapped — a list keyed by letters, the item a letter opens, back
 * to the list — and the check the buttons that switch conversations share.
 */

import { Context } from 'grammy';
import { isProcessing } from '../../claude/request-queue.js';
import type { EntityMessage } from '../../telegram/entities.js';
import { editCallbackMessage, replyFormatted } from '../../telegram/send.js';

export type Keyboard = { text: string; callback_data: string }[][];

export interface View {
  text: EntityMessage;
  keyboard: Keyboard;
}

/**
 * Send `view` as a reply, or put it in place of the tapped message. A view
 * Telegram won't format goes out as plain text instead (the send helpers
 * retry it), so a formatting slip costs the formatting and not the view.
 */
export async function sendView(ctx: Context, view: View, how: 'reply' | 'edit'): Promise<void> {
  const reply_markup = { inline_keyboard: view.keyboard };
  try {
    if (how === 'edit') await editCallbackMessage(ctx, view.text, { reply_markup });
    else await replyFormatted(ctx, view.text, { reply_markup });
  } catch (err) {
    // "message is not modified": the same view, tapped again. Nothing to do.
    if (err instanceof Error && err.message.includes('not modified')) return;
    throw err;
  }
}

/**
 * Switching conversations under a running reply would cut it off, so the
 * switches wait for it. Says so on the button and returns true when busy.
 */
export async function refuseWhileBusy(ctx: Context, sessionKey: string): Promise<boolean> {
  if (!isProcessing(sessionKey)) return false;
  await ctx.answerCallbackQuery({
    text: 'A reply is still running here — wait for it to finish, or /cancel it, then tap again.',
    show_alert: true,
  });
  return true;
}
