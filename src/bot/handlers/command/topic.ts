/**
 * The /topic command.
 *
 * The topic state itself lives in `topic-store.ts`, which stays below the
 * provider layer so `agent.ts` and `mcp-tools.ts` can read and set the topic
 * without closing an import cycle. This module adds the Telegram command
 * surface on top and re-exports the store so the command barrel's public API
 * is unchanged.
 */

import { Context } from 'grammy';
import { EntityText } from '../../../telegram/entities.js';
import { replyFormatted } from '../../../telegram/send.js';
import { getSessionKeyFromCtx } from '../../../utils/session-key.js';
import { setSessionTopic } from './topic-store.js';

export {
  clearTopic,
  restoreTopic,
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
  await replyFormatted(ctx, topic ? new EntityText().add('✅ Topic: ').bold(topic).build() : '✅ Topic cleared');
}
