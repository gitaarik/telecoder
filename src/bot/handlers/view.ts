/**
 * A view: one message that /tree and /prompts redraw in place as their
 * buttons are tapped — a list keyed by letters, the item a letter opens, back
 * to the list — and the check the buttons that switch conversations share.
 */

import { Context } from 'grammy';
import { sanitizeError } from '../../utils/sanitize.js';
import { isProcessing } from '../../claude/request-queue.js';
import { plainMarker } from './fork.handler.js';

export type Keyboard = { text: string; callback_data: string }[][];

export interface View {
  text: string;
  keyboard: Keyboard;
}

/**
 * Send `view` as a reply, or put it in place of the tapped message. A view
 * Telegram won't parse goes out as plain text instead, so a formatting slip
 * costs the formatting and not the view.
 */
export async function sendView(ctx: Context, view: View, how: 'reply' | 'edit'): Promise<void> {
  const reply_markup = { inline_keyboard: view.keyboard };
  const send = (text: string, parse_mode?: 'MarkdownV2') => how === 'edit'
    ? ctx.editMessageText(text, { parse_mode, reply_markup })
    : ctx.reply(text, { parse_mode, reply_markup });
  try {
    await send(view.text, 'MarkdownV2');
  } catch (err) {
    // "message is not modified": the same view, tapped again. Nothing to do.
    if (err instanceof Error && err.message.includes('not modified')) return;
    console.error('[View] MarkdownV2 send failed, falling back to plain text:', sanitizeError(err));
    await send(plainView(view.text));
  }
}

/** A view as plain text: a tree's code fences dropped, then unmarked like a banner. */
function plainView(text: string): string {
  return plainMarker(text.split('\n').filter((line) => line !== '```').join('\n'));
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
