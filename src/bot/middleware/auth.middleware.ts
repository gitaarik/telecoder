import { Context, NextFunction } from 'grammy';
import { config } from '../../config.js';
import { GROUP_ANONYMOUS_BOT_ID, isAdmin } from '../../utils/admins.js';

/**
 * Log authentication attempt for security auditing.
 * Avoids logging message content to protect privacy.
 */
function logAuthAttempt(
  success: boolean,
  userId: number | undefined,
  username: string | undefined,
  chatType: string | undefined
): void {
  const timestamp = new Date().toISOString();
  const userInfo = userId ? `user:${userId}` : 'user:unknown';
  const usernameInfo = username ? `@${username}` : '';
  const status = success ? 'ALLOWED' : 'DENIED';
  console.log(`[auth] ${timestamp} ${status} ${userInfo} ${usernameInfo} chat:${chatType || 'unknown'}`);
}

export async function authMiddleware(
  ctx: Context,
  next: NextFunction
): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username;
  const chatType = ctx.chat?.type;
  const chatId = ctx.chat?.id;

  if (!userId) {
    logAuthAttempt(false, undefined, undefined, chatType);
    return;
  }

  // Allow anonymous admins in explicitly allowed groups (forum topics)
  if (userId === GROUP_ANONYMOUS_BOT_ID && chatId && config.ALLOWED_GROUP_IDS.includes(chatId)) {
    logAuthAttempt(true, userId, username, chatType);
    await next();
    return;
  }

  if (!config.ALLOWED_USER_IDS.includes(userId)) {
    logAuthAttempt(false, userId, username, chatType);
    await ctx.reply('⛔ You are not authorized to use this bot.');
    return;
  }

  // Confine non-admins to the allow-listed groups. A bot shared in a group is
  // shared on the understanding that the owner can see what is asked of it, and
  // a private chat with the same bot is the one place they cannot. Admins are
  // exempt — being able to DM your own bot is the normal way to use it.
  //
  // Fails closed on a missing chat id: an update we can't place is not an
  // update we can say is inside the group.
  if (config.RESTRICT_TO_GROUPS && !isAdmin(userId)) {
    if (chatId === undefined || !config.ALLOWED_GROUP_IDS.includes(chatId)) {
      logAuthAttempt(false, userId, username, chatType);
      await ctx.reply(
        '⛔ This bot only works in its shared group chat, not in private messages.'
      );
      return;
    }
  }

  logAuthAttempt(true, userId, username, chatType);
  await next();
}
