/**
 * The second gate in a group: not "is this message for the bot?" but "is this
 * person allowed to tell it what to do?".
 *
 * It runs after the mention gate on purpose. A spectator chatting with the
 * humans is not addressed to the bot, so it never reaches here and the group
 * stays quiet; only a message that genuinely asks the agent for something gets
 * turned away, and then only once every REMINDER_INTERVAL_MS so a confused
 * newcomer can't be made to flood the chat.
 *
 * The owner-only list is the third tier. A contributor can prompt the agent —
 * which is already shell access on the host — but the commands here reach past
 * the current conversation: they repoint the bot at another project, restart or
 * rebuild the process, upgrade the CLI under it, or hand the session to a
 * terminal. Those stay with the people in ALLOWED_USER_IDS, who own the
 * machine. Gating them here rather than inside each handler keeps the rule in
 * one readable list, and covers the inline buttons those commands put in the
 * chat — otherwise a contributor could simply tap the owner's confirm button.
 */

import { type Context, type MiddlewareFn } from 'grammy';
import { config } from '../../config.js';
import { BoundedMap } from '../../utils/bounded-map.js';
import { rememberUsername, resolveRole } from '../access/group-access.js';

/** Commands only ALLOWED_USER_IDS may run, even in an allow-listed group. */
export const OWNER_ONLY_COMMANDS = new Set([
  'restartbot',
  'rebuildbot',
  'update',
  'permissions',
  'teleport',
  'project',
  'newproject',
  'allow',
  'deny',
  // /members is deliberately not here: it only reads back the roster, and a
  // contributor asking "who can drive this thing?" deserves an answer.
]);

/** Callback-data prefixes belonging to the flows those commands open. */
export const OWNER_ONLY_CALLBACK_PREFIXES = [
  'restartbot:',
  'rebuild:',
  'restart:',
  'startup:',
  'update:',
  'project:',
];

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

/**
 * The command a message opens with, lowercased and without any `@botname`.
 *
 * Telegram tags the first segment of an absolute path as a command, so
 * `/home/me/notes` arrives looking like `/home` — the token has to end at
 * whitespace or end-of-text to count, the same rule the mention gate uses.
 */
export function leadingCommand(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const match = /^\/([A-Za-z0-9_]+)(@[A-Za-z0-9_]+)?(\s|$)/.exec(text.trimStart());
  return match ? match[1].toLowerCase() : undefined;
}

function isOwnerOnlyUpdate(ctx: Context): boolean {
  const data = ctx.callbackQuery?.data;
  if (data) return OWNER_ONLY_CALLBACK_PREFIXES.some((prefix) => data.startsWith(prefix));

  const msg = ctx.message;
  if (!msg) return false;
  const command = leadingCommand(typeof msg.text === 'string' ? msg.text : msg.caption);
  return command !== undefined && OWNER_ONLY_COMMANDS.has(command);
}

/** Refuse the update, in the quietest channel available. */
async function refuse(ctx: Context, text: string, alert: string): Promise<void> {
  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({ text: alert, show_alert: true });
    return;
  }
  await ctx.reply(text);
}

/**
 * Note the @handle of whoever just spoke, so `/allow @them` can resolve it.
 *
 * Registered ahead of the mention gate on purpose: most of what a spectator
 * says is aimed at the humans, and that is precisely the person an owner is
 * about to want to name. Learning only from messages addressed to the bot
 * would leave the handle unknown until after they'd tried to use it.
 */
export const learnHandlesMiddleware: MiddlewareFn<Context> = async (ctx, next) => {
  if (ctx.from?.id !== undefined && !ctx.from.is_bot) {
    rememberUsername(ctx.from.id, ctx.from.username);
  }
  return next();
};

export const groupRoleMiddleware: MiddlewareFn<Context> = async (ctx, next) => {
  const chatType = ctx.chat?.type;
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;

  // A DM only ever reaches here from an owner: the auth gate admits nobody
  // else to a private chat.
  if (chatType !== 'group' && chatType !== 'supergroup') return next();
  if (chatId === undefined || userId === undefined) return next();

  // Only the update types that can actually drive the bot are gated: a message
  // or a button tap. Everything else in a group — someone being promoted to
  // admin, the bot's own membership changing, an edit nothing listens for —
  // reaches no handler anyway, and answering those in the chat would have the
  // bot piping up about events nobody addressed to it.
  if (!ctx.message && !ctx.callbackQuery) return next();

  const role = resolveRole(chatId, userId);

  if (role === 'spectator') {
    console.log(`[access] spectator ${userId} addressed the bot in ${chatId} — ignored`);
    if (shouldRemind(chatId, userId)) {
      await refuse(
        ctx,
        '👀 You can read along here, but you are not set up to send prompts. ' +
          'An owner can reply to one of your messages with /allow to change that.',
        'You are a spectator in this chat.',
      );
    }
    return;
  }

  if (role !== 'owner' && isOwnerOnlyUpdate(ctx)) {
    console.log(`[access] contributor ${userId} blocked from an owner-only action in ${chatId}`);
    await refuse(
      ctx,
      '🔐 That one is owner-only — it changes the bot itself, not just this conversation.',
      'Owner-only action.',
    );
    return;
  }

  return next();
};

/** Whether an ungranted member of an allow-listed group may prompt the agent. */
export function groupDefaultIsContributor(): boolean {
  return config.GROUP_MEMBERS_DEFAULT === 'contributor';
}
