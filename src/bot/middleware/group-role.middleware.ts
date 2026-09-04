/**
 * The second gate in a group: not "is this message for the bot?" but "is this
 * person allowed to tell it what to do?".
 *
 * It runs after the mention gate on purpose. A spectator chatting with the
 * humans is not addressing the bot, so it never reaches here and the group
 * stays quiet; only a message that genuinely asks the agent for something gets
 * turned away, and then only once every REMINDER_INTERVAL_MS so a confused
 * newcomer can't be made to flood the chat.
 *
 * There is no third, owner-only tier here. An earlier draft carried a list of
 * command names that only admins could run, but the handlers those names point
 * at are already wrapped in `adminOnly` at registration — and a list sitting a
 * long way from the registrations it governs is one rename away from silently
 * covering nothing. The wrapper is the gate; this file is only about roles.
 */

import { type Context, type MiddlewareFn } from 'grammy';
import { BoundedMap } from '../../utils/bounded-map.js';
import { resolveRole } from '../access/group-access.js';
import { identifyUser } from '../../utils/user-roster.js';
import { requestAccess } from '../../telegram/access-request.js';

/** How long a turned-away spectator is left alone before being told again. */
const REMINDER_INTERVAL_MS = 10 * 60 * 1000;

const lastReminder = new BoundedMap<string, number>(500);

/** True once per chat+user per REMINDER_INTERVAL_MS. */
function shouldRemind(chatId: number, userId: number, now = Date.now()): boolean {
  const key = `${chatId}:${userId}`;
  const previous = lastReminder.get(key);
  if (previous !== undefined && now - previous < REMINDER_INTERVAL_MS) return false;
  lastReminder.set(key, now);
  return true;
}

/** Forget the throttle state. Test seam. */
export function resetSpectatorReminders(): void {
  lastReminder.clear();
}

/** Refuse the update, in the quietest channel available. */
async function refuse(ctx: Context, text: string, alert: string): Promise<void> {
  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({ text: alert, show_alert: true });
    return;
  }
  await ctx.reply(text);
}

export const groupRoleMiddleware: MiddlewareFn<Context> = async (ctx, next) => {
  const chatType = ctx.chat?.type;
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;

  // A DM only ever reaches here from someone already on the roster: the auth
  // gate admits nobody else to a private chat.
  if (chatType !== 'group' && chatType !== 'supergroup') return next();
  if (chatId === undefined || userId === undefined) return next();

  // Only the update types that can actually drive the bot are gated: a message
  // or a button tap. Everything else in a group — someone being promoted to
  // admin, the bot's own membership changing, an edit nothing listens for —
  // reaches no handler anyway, and answering those in the chat would have the
  // bot piping up about events nobody addressed to it.
  if (!ctx.message && !ctx.callbackQuery) return next();

  if (resolveRole(chatId, userId) !== 'spectator') return next();

  console.log(`[access] spectator ${userId} addressed the bot in ${chatId} — ignored`);

  // Put the decision in front of an admin rather than only telling the
  // spectator no. The card carries its own re-ask cooldown, so this cannot
  // become a way to page the admins by typing repeatedly.
  if (ctx.from) await requestAccess(ctx, identifyUser(ctx.from));

  if (shouldRemind(chatId, userId)) {
    await refuse(
      ctx,
      '👀 You can read along here, but you are not set up to send prompts. ' +
        'An admin can reply to one of your messages with /allow to change that.',
      'You are a spectator in this chat.',
    );
  }
};
