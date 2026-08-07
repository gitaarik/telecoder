/**
 * Suggestion-tap callback handler.
 *
 * When a user taps the "💡 …" inline button under an assistant response,
 * we look up the stored suggestion text (callback_data only carries a short
 * id) and dispatch it through the same path as a user-typed message:
 *   - echo a one-line "💡 _<text>_" header so the conversation log shows
 *     what was effectively sent
 *   - remove the buttons from the original message so the same suggestion
 *     can't be replayed accidentally
 *   - push the prompt through the normal request queue and streaming path
 */

import { Context } from 'grammy';
import { consumeSuggestion } from '../../claude/pending-suggestions.js';
import { getSessionKeyFromCtx } from '../../utils/session-key.js';
import { sessionManager } from '../../claude/session-manager.js';
import { escapeMarkdownV2 as esc } from '../../telegram/markdown.js';

export async function handleSuggestionTapCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith('sgt:')) return;
  const id = data.slice('sgt:'.length);

  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) {
    await ctx.answerCallbackQuery({ text: 'Session not found' });
    return;
  }
  const { sessionKey, chatId } = keyInfo;

  const entry = consumeSuggestion(id);
  if (!entry) {
    await ctx.answerCallbackQuery({ text: 'Suggestion expired or already used' });
    try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }); } catch { /* ignore */ }
    return;
  }

  // A button tap can sometimes outlive the session it came from (bot
  // restarted between the response posting and the tap). Bail with a clear
  // message rather than dispatching a prompt against no session.
  const session = sessionManager.getSession(sessionKey);
  if (!session) {
    await ctx.answerCallbackQuery({ text: 'No active session' });
    return;
  }

  await ctx.answerCallbackQuery({ text: 'Sending…' });
  try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }); } catch { /* ignore */ }

  // Echo what we're sending so the chat scroll reads like a real conversation.
  try {
    await ctx.reply(`💡 _${esc(entry.text)}_`, { parse_mode: 'MarkdownV2' });
  } catch (err) {
    console.debug('[Suggestion] echo failed:', err instanceof Error ? err.message : err);
  }

  // Dispatch through the normal pipeline. Lazy import avoids a circular
  // import between this file and message.handler.ts.
  const { dispatchPromptFromCallback, runQueuedTurn } = await import('./message.handler.js');
  await runQueuedTurn(ctx, sessionKey, entry.text, 'Suggestion', () =>
    dispatchPromptFromCallback(ctx, sessionKey, chatId, entry.text),
  );
}
