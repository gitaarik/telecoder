/**
 * The /topic and /botname commands.
 *
 * The topic state itself and the bot-name mutators live in `topic-store.ts`,
 * which stays below the provider layer so `agent.ts` and `mcp-tools.ts` can
 * read and set the topic without closing an import cycle. This module adds
 * the Telegram command surface on top and re-exports the store so the command
 * barrel's public API is unchanged.
 */

import { Context } from 'grammy';
import { config } from '../../../config.js';
import { escapeMarkdownV2 as esc } from '../../../telegram/markdown.js';
import { getBotNameSettings, setBotNameEnabled } from '../../../telegram/botname-settings.js';
import { getSessionKeyFromCtx } from '../../../utils/session-key.js';
import { replyMd, parseCallback } from './shared.js';
import { pushBotName, setSessionTopic } from './topic-store.js';

export {
  buildBotDisplayName,
  pushBotName,
  clearTopicAndRefreshBotName,
  restoreTopicAndRefreshBotName,
  setSessionTopic,
  getSessionTopic,
  getMsSinceTopicSet,
} from './topic-store.js';

export async function handleTopic(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const text = ctx.message?.text || '';
  const topic = text.split(' ').slice(1).join(' ').trim();

  // Topic lives in the status line, not the Telegram bot name —
  // setSessionTopic updates in-memory + persistent state but the bot's
  // Telegram-side display name doesn't change, so no setMyName call.
  setSessionTopic(sessionKey, topic);
  await replyMd(ctx, topic ? `✅ Topic: *${esc(topic)}*` : '✅ Topic cleared');
}

export async function handleBotName(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const settings = getBotNameSettings(sessionKey);
  const currentStatus = settings.enabled ? 'ON' : 'OFF';

  const keyboard = [
    [
      {
        text: settings.enabled ? '✓ On' : 'On',
        callback_data: 'botname:on'
      },
      {
        text: !settings.enabled ? '✓ Off' : 'Off',
        callback_data: 'botname:off'
      },
    ],
  ];

  const description = settings.enabled
    ? '_Bot name updates to include the active project when switching_'
    : '_Bot name stays as configured in BOT\\_NAME_';

  await ctx.reply(
    `✏️ *Dynamic Bot Name*\n\nCurrent: *${currentStatus}*\n${description}`,
    {
      parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: keyboard },
    }
  );
}

export async function handleBotNameCallback(ctx: Context): Promise<void> {
  const cb = parseCallback(ctx, 'botname:');
  if (!cb) return;
  const { sessionKey, data } = cb;

  const newState = data.replace('botname:', '') === 'on';
  setBotNameEnabled(sessionKey, newState);

  const statusText = newState ? 'ON' : 'OFF';
  const description = newState
    ? '_Bot name updates to include the active project when switching_'
    : '_Bot name stays as configured in BOT\\_NAME_';

  await ctx.answerCallbackQuery({ text: `Dynamic bot name ${statusText}!` });
  await ctx.editMessageText(
    `✅ Dynamic Bot Name *${statusText}*\n\n${description}`,
    { parse_mode: 'MarkdownV2' }
  );

  // Reset bot name to base when disabling
  if (!newState) {
    await pushBotName(ctx, config.BOT_NAME, 'disable reset');
  }
}

