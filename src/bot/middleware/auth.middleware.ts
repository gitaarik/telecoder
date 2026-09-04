import { Context, NextFunction } from 'grammy';
import type { User } from 'grammy/types';
import { config } from '../../config.js';
import { GROUP_ANONYMOUS_BOT_ID, isAdmin } from '../../utils/admins.js';
import { isAllowedUser, noteSeenUser, identifyUser as identify } from '../../utils/user-roster.js';
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

  // Membership of an allow-listed group is the coarse gate: an invite-only
  // group is a vetted room, and being in it is enough to reach the bot at all.
  // What that membership is *worth* is the finer question, and it is answered
  // downstream by group-role.middleware — under GROUP_MEMBERS_DEFAULT, which
  // ships as `spectator`, being in the room only buys the right to read along.
  //
  // Fails closed on a missing chat id: an update we can't place is not one we
  // can say is inside the group.
  const inAllowedGroup = chatId !== undefined && config.ALLOWED_GROUP_IDS.includes(chatId);

  // Record everyone the shared group sees, on the roster or not. `/allow
  // @handle` can only resolve against handles the bot has watched go by, and
  // the person an admin is about to name is precisely the one not admitted
  // yet; /users lists them as pending on the strength of this.
  if (inAllowedGroup && ctx.from) noteSeenUser(identify(ctx.from), chatId);

  // Outside the shared group the roster is the whole answer. Inside it, a
  // stranger is not refused here — they fall through to the role gate, which
  // turns them away only if they actually address the bot, so the group stays
  // quiet while people talk to each other.
  if (!isAllowedUser(userId) && !inAllowedGroup) {
    logAuthAttempt(false, userId, username, chatType);
    const outcome = ctx.from ? await requestAccess(ctx, identify(ctx.from)) : 'not-asked';
    await ctx.reply(
      outcome === 'pending'
        ? '⛔ Not authorized yet — an admin has been asked to let you in.'
        : '⛔ You are not authorized to use this bot.'
    ).catch(() => {});
    return;
  }

  // Keep display names current for /users. In the group this already ran.
  if (!inAllowedGroup && ctx.from) noteSeenUser(identify(ctx.from), chatId);

  // Confine non-admins to the allow-listed groups. A bot shared in a group is
  // shared on the understanding that the owner can see what is asked of it, and
  // a private chat with the same bot is the one place they cannot. Admins are
  // exempt — being able to DM your own bot is the normal way to use it.
  if (config.RESTRICT_TO_GROUPS && !isAdmin(userId) && !inAllowedGroup) {
    logAuthAttempt(false, userId, username, chatType);
    await ctx.reply(
      '⛔ This bot only works in its shared group chat, not in private messages.'
    );
    return;
  }

  logAuthAttempt(true, userId, username, chatType);
  await next();
}
