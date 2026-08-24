/**
 * The admin guard for handlers that act on the bot rather than on a
 * conversation.
 *
 * Restarting the bot, rebuilding it, pulling an update, or switching the
 * transport are not "things you do with the agent" — they are things you do to
 * everyone else's session, and on a shared bot they also reach the guardrails
 * themselves: the permission gate is a hook on the PTY transport, so anyone who
 * can flip a chat to SDK can turn the gate off without ever being told no.
 *
 * Wrapping is per handler rather than one middleware matching a name list,
 * because the list would live a long way from the registrations it governs and
 * would silently stop covering a command the day one gets renamed.
 */

import type { Context } from 'grammy';
import { isAdmin } from '../../utils/admins.js';

type Handler<C extends Context> = (ctx: C) => Promise<void> | void;

const DENIAL = 'Admins only — ask an admin of this bot to run it.';

/**
 * Wrap a command or callback handler so only admins reach it. Non-admins get a
 * toast (callback) or a reply (command); with no admin subset configured every
 * allowed user is an admin, so this is transparent on a solo bot.
 */
export function adminOnly<C extends Context>(handler: Handler<C>): Handler<C> {
  return async (ctx: C): Promise<void> => {
    if (isAdmin(ctx.from?.id)) {
      await handler(ctx);
      return;
    }

    console.log(`[admins] DENIED user:${ctx.from?.id ?? 'unknown'} chat:${ctx.chat?.id ?? 'unknown'} admin-only handler`);

    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: `🔒 ${DENIAL}`, show_alert: true }).catch(() => {});
      return;
    }
    await ctx.reply(`🔒 ${DENIAL}`).catch(() => {});
  };
}
