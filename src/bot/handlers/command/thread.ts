/**
 * /deletethread: delete the thread it's sent in, messages and all, and end
 * the session that belonged to it. Works in a private chat's threads and, for
 * a bot allowed to delete messages there, in a group's forum topics.
 *
 * It answers mid-turn, since stopping that turn is part of the point. The
 * thread goes first and its session after, so a thread Telegram won't delete
 * keeps a session that works.
 */

import { Context, GrammyError } from 'grammy';
import { EntityText } from '../../../telegram/entities.js';
import { replyFormatted, editCallbackMessage } from '../../../telegram/send.js';
import { getSessionKeyFromCtx } from '../../../utils/session-key.js';
import { sanitizeError } from '../../../utils/sanitize.js';
import { forgetThread, isThreadGoneError } from '../../deleted-threads.js';
import { parseCallback } from './shared.js';

const SKIP_CONFIRM = new Set(['-y', '--yes', 'yes', 'force']);

/** Delete the thread, then let its session go. What went wrong, or null. */
async function deleteThread(ctx: Context, chatId: number, threadId: number, sessionKey: string): Promise<string | null> {
  try {
    await ctx.api.deleteForumTopic(chatId, threadId);
  } catch (err) {
    // Already gone, deleted by hand since the confirmation was sent: let go all the same.
    if (!(err instanceof GrammyError && isThreadGoneError(err.description))) {
      console.error(`[DeleteThread] Deleting ${sessionKey} failed:`, sanitizeError(err));
      return err instanceof GrammyError ? err.description : 'Telegram refused';
    }
  }
  await forgetThread(ctx.api, sessionKey, '/deletethread');
  return null;
}

export async function handleDeleteThread(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { chatId, threadId, sessionKey } = keyInfo;

  if (threadId === undefined) {
    await ctx.reply('ℹ️ Send /deletethread inside the thread you want to delete.');
    return;
  }

  const arg = (ctx.message?.text ?? '').split(' ').slice(1).join(' ').trim().toLowerCase();
  if (SKIP_CONFIRM.has(arg)) {
    const failed = await deleteThread(ctx, chatId, threadId, sessionKey);
    if (failed) await ctx.reply(`❌ Couldn't delete this thread: ${failed}`);
    return;
  }

  const confirm = new EntityText()
    .add('⚠️ ').bold('Delete this thread?')
    .add('\n\nThe thread and all its messages are removed from Telegram, and its Claude session ends. ')
    .add('The conversation itself stays on disk, so ').code('/resume').add(' can still pick it up.\n\n')
    .italic('Telegram can\'t undo this.')
    .add('\n\n💡 Tip: ').code('/deletethread -y').add(' skips this confirmation.')
    .build();

  await replyFormatted(ctx, confirm, {
    reply_markup: {
      inline_keyboard: [[
        { text: '🗑️ Yes, delete it', callback_data: 'delthread:confirm' },
        { text: '✗ Cancel', callback_data: 'delthread:cancel' },
      ]],
    },
  });
}

export async function handleDeleteThreadCallback(ctx: Context): Promise<void> {
  const cb = parseCallback(ctx, 'delthread:');
  if (!cb) return;
  const { chatId, threadId, sessionKey, data } = cb;

  if (data !== 'delthread:confirm' || threadId === undefined) {
    await ctx.answerCallbackQuery({ text: 'Kept the thread.' }).catch(() => {});
    await editCallbackMessage(ctx, new EntityText().add('👍 Kept the thread.').build()).catch(() => {});
    return;
  }

  const failed = await deleteThread(ctx, chatId, threadId, sessionKey);
  if (failed) {
    await ctx.answerCallbackQuery({ text: 'Couldn\'t delete the thread.' }).catch(() => {});
    await editCallbackMessage(ctx, new EntityText().add(`❌ Couldn't delete this thread: ${failed}`).build()).catch(() => {});
    return;
  }
  await ctx.answerCallbackQuery({ text: 'Thread deleted.' }).catch(() => {});
}
