import { Context, NextFunction } from 'grammy';
import type { User } from 'grammy/types';
import { config } from '../../config.js';
import { GROUP_ANONYMOUS_BOT_ID, isAdmin } from '../../utils/admins.js';
import { isAllowedUser, noteSeenUser, type UserIdentity } from '../../utils/user-roster.js';
import { requestAccess } from '../../telegram/access-request.js';

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

/** The fields the roster keeps, taken off a Telegram user. */
function identify(user: User): UserIdentity {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
  return {
    id: user.id,
    ...(user.username ? { username: user.username } : {}),
    ...(name ? { name } : {}),
  };
}

/**
 * Someone was added to, or joined, an allow-listed group.
 *
 * This is the other half of "how does an admin find out who to allow": the
 * `@username` in `/allow @someone` can only ever resolve against people the bot
 * has watched go by, and waiting for a newcomer to speak first means the admin
 * cannot admit them until after they have been turned away once. The join
 * itself is the earlier, better moment.
 *
 * Service messages stop here either way — nothing downstream handles them, and
 * the adder is not necessarily an allowed user, so letting one fall through to
 * the ordinary denial would answer a join with "⛔ You are not authorized".
 */
async function handleNewMembers(ctx: Context, members: User[]): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined || !config.ALLOWED_GROUP_IDS.includes(chatId)) return;

  for (const member of members) {
    if (member.is_bot) continue;
    const identity = identify(member);
    noteSeenUser(identity, chatId);
    if (!isAllowedUser(member.id)) {
      await requestAccess(ctx, identity);
    }
  }
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

  const newMembers = ctx.message?.new_chat_members;
  if (newMembers && newMembers.length > 0) {
    await handleNewMembers(ctx, newMembers);
    return;
  }

  // Allow anonymous admins in explicitly allowed groups (forum topics)
  if (userId === GROUP_ANONYMOUS_BOT_ID && chatId && config.ALLOWED_GROUP_IDS.includes(chatId)) {
    logAuthAttempt(true, userId, username, chatType);
    await next();
    return;
  }

  // The allow-list is `.env` plus whoever an admin has admitted with /allow,
  // so a newly admitted guest works immediately rather than at the next restart.
  if (!isAllowedUser(userId)) {
    logAuthAttempt(false, userId, username, chatType);
    // In the shared group, turn the refusal into something an admin can act on
    // with one tap. Everywhere else it stays a flat "no" — see access-request.ts.
    const outcome = ctx.from ? await requestAccess(ctx, identify(ctx.from)) : 'not-asked';
    await ctx.reply(
      outcome === 'pending'
        ? '⛔ Not authorized yet — an admin has been asked to let you in.'
        : '⛔ You are not authorized to use this bot.'
    ).catch(() => {});
    return;
  }

  // Remember allowed users too: this is how `/allow @them` and `/deny @them`
  // resolve a handle to an id, and it keeps display names current for /users.
  if (ctx.from) noteSeenUser(identify(ctx.from), chatId);

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
