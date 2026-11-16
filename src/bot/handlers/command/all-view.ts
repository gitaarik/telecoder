/**
 * Telling a command typed in a bot's "All" view from one typed in a thread.
 *
 * Telegram has no chat-level place to type in a private chat with threads:
 * a message sent from the "All" view opens a new thread, named "New chat",
 * and arrives inside it. So `/model opus` typed there lands in an empty
 * thread nobody meant to start, and pinning the model to that thread alone
 * would do nothing anyone wanted. A command that is the first thing in such
 * a thread can only mean "from now on", and the settings commands read it so.
 */

import type { Context } from 'grammy';
import { sessionManager } from '../../../claude/session-manager.js';
import { hasImplicitName } from '../../../telegram/thread-titles.js';
import { getSessionKeyFromCtx } from '../../../utils/session-key.js';
import type { SettingLevel } from '../../../providers/user-preferences.js';

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

/** The level a /model or /effort applies at when the command names none. */
export function resolveLevel(ctx: Context, explicit: SettingLevel | undefined): SettingLevel {
  if (explicit) return explicit;
  return isFreshAllViewThread(ctx) ? 'default' : 'thread';
}
