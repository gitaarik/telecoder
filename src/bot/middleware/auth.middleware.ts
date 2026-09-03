import { Context, NextFunction } from 'grammy';
import { config } from '../../config.js';

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

  // In an allow-listed group, Telegram membership decides who gets *in*:
  // anyone the group owner has invited passes here, and kicking them from the
  // group revokes that on their next message. Keep the group private
  // (invite-only) — a leaked invite link becomes an open door.
  //
  // What membership is then worth is a separate question, answered downstream
  // by group-role.middleware: under GROUP_MEMBERS_DEFAULT=spectator, passing
  // this gate only buys the right to read along.
  const isAllowedGroup =
    (chatType === 'group' || chatType === 'supergroup') &&
    chatId !== undefined &&
    config.ALLOWED_GROUP_IDS.includes(chatId);

  if (isAllowedGroup || config.ALLOWED_USER_IDS.includes(userId)) {
    logAuthAttempt(true, userId, username, chatType);
    await next();
    return;
  }

  logAuthAttempt(false, userId, username, chatType);
  await ctx.reply('⛔ You are not authorized to use this bot.');
}
