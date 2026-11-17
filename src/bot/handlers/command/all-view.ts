/**
 * Telling a command typed in a bot's "All" view from one typed in a thread.
 *
 * Telegram has no chat-level place to type in a private chat with threads:
 * a message sent from the "All" view opens a new thread, named "New chat",
 * and arrives inside it. A bare `/model fable` there pins that thread like
 * anywhere else, which is how to start one thread on another model while new
 * threads keep the default. A wider level typed there (`/model opus new`)
 * leaves the thread with nothing in it, so that confirmation offers to
 * delete it.
 */

import type { Context } from 'grammy';
import { sessionManager } from '../../../claude/session-manager.js';
import { hasImplicitName } from '../../../telegram/thread-titles.js';
import { getSessionKeyFromCtx } from '../../../utils/session-key.js';

/**
 * Whether this update comes from a private-chat thread opened from the "All"
 * view that no conversation has happened in yet. Works for a typed command,
 * whose creation notice says the name was implicit, and for a button tapped
 * in that thread afterwards, through the name recorded from that notice.
 */
export function isFreshAllViewThread(ctx: Context): boolean {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo || keyInfo.threadId === undefined || keyInfo.chatId <= 0) return false;
  const { sessionKey } = keyInfo;

  const created = ctx.message?.reply_to_message?.forum_topic_created;
  if (!created?.is_name_implicit && !hasImplicitName(sessionKey)) return false;

  if (sessionManager.getSession(sessionKey)?.claudeSessionId) return false;
  return sessionManager.getSessionHistory(sessionKey, 1).length === 0;
}
