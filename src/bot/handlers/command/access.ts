/**
 * Admitting people from chat: `/allow`, `/deny`, `/users`.
 *
 * These exist because the alternative is editing `ALLOWED_USER_IDS` and
 * restarting, and because the obvious shape — "just type their @username" —
 * cannot work on its own. No Bot API method resolves a username to a user id.
 * `getChatAdministrators` returns full user objects, but only for a group's
 * admins; nothing lists ordinary members at all. A bot only ever learns a
 * username by watching one go past.
 *
 * So all three commands lean on the same two moves the bot already makes: it
 * records everyone it sees in a shared group, and it posts a tap-to-approve
 * card when a stranger turns up. Typing a username is the fallback, not the
 * primary path — `/allow` as a reply to someone's message is exact, works for
 * the many Telegram users who have no username at all, and cannot be aimed at
 * the wrong person by a handle that changed hands.
 */

import { Context } from 'grammy';
import { escapeMarkdownV2 as esc } from '../../../telegram/markdown.js';
import { getAdminIds, isAdmin } from '../../../utils/admins.js';
import {
  admitUser,
  describeUser,
  envAllowedIds,
  listAdmitted,
  listPending,
  resolveUser,
  revokeUser,
  type UserIdentity,
} from '../../../utils/user-roster.js';
import { ACCESS_CALLBACK_PREFIX, clearAccessCooldown } from '../../../telegram/access-request.js';
import { sanitizeError } from '../../../utils/sanitize.js';
import { replyMd } from './shared.js';

/** The argument text after the command word, or '' when there is none. */
function argsOf(ctx: Context): string {
  const text = ctx.message?.text ?? '';
  return text.split(' ').slice(1).join(' ').trim();
}

/**
 * Who a command is aimed at: the author of the replied-to message, else the
 * `@username` or numeric id in the arguments.
 *
 * The reply wins when both are present. It is the unambiguous one, and someone
 * who replies *and* types a name has most likely typed the name of the person
 * they are replying to.
 */
function targetOf(ctx: Context): { user?: UserIdentity; query?: string } {
  const replied = ctx.message?.reply_to_message?.from;
  if (replied && !replied.is_bot) {
    const name = [replied.first_name, replied.last_name].filter(Boolean).join(' ');
    return {
      user: {
        id: replied.id,
        ...(replied.username ? { username: replied.username } : {}),
        ...(name ? { name } : {}),
      },
    };
  }

  const query = argsOf(ctx);
  if (!query) return {};
  return { user: resolveUser(query), query };
}

/** What to say when a handle names nobody the bot has ever seen. */
function unresolvedMessage(query: string): string {
  return (
    `❌ I don't know ${esc(query)}\\.\n\n` +
    'Telegram gives bots no way to look up a username, so I can only match ' +
    'people I have already seen post here\\. Ask them to send a message in the ' +
    'group — then reply to it with `/allow`, which is exact\\.'
  );
}

export async function handleAllow(ctx: Context): Promise<void> {
  const { user, query } = targetOf(ctx);

  if (!user) {
    if (query) {
      await replyMd(ctx, unresolvedMessage(query));
      return;
    }
    await replyMd(
      ctx,
      'Usage: reply to their message with `/allow`, or `/allow @username`\\.\n\n' +
        'Replying is exact and works for people with no username\\.',
    );
    return;
  }

  const by = ctx.from?.id;
  if (by === undefined) return;

  try {
    const result = admitUser(user, by);
    clearAccessCooldown(user.id);
    if (result === 'already-allowed') {
      await replyMd(ctx, `✅ ${esc(describeUser(user))} can already use this bot\\.`);
      return;
    }
    console.log(`[access] ${by} admitted ${describeUser(user)}`);
    await replyMd(
      ctx,
      `✅ ${esc(describeUser(user))} is in — as a *guest*, so their requests go ` +
        'through the charter judge and the permission gate\\.',
    );
  } catch (error) {
    console.error('[access] admit failed:', sanitizeError(error));
    await replyMd(ctx, '❌ Could not save the roster — they are *not* allowed in\\. Check the bot logs\\.');
  }
}

export async function handleDeny(ctx: Context): Promise<void> {
  const { user, query } = targetOf(ctx);

  if (!user) {
    if (query) {
      await replyMd(ctx, unresolvedMessage(query));
      return;
    }
    await replyMd(ctx, 'Usage: reply to their message with `/deny`, or `/deny @username`\\.');
    return;
  }

  if (isAdmin(user.id)) {
    await replyMd(
      ctx,
      `🔒 ${esc(describeUser(user))} is an *admin*\\. Remove them from ` +
        '`ADMIN_USER_IDS` and `ALLOWED_USER_IDS` in the bot\'s `.env`, then restart\\.',
    );
    return;
  }

  try {
    const result = revokeUser(user.id);
    clearAccessCooldown(user.id);
    if (result === 'env-configured') {
      await replyMd(
        ctx,
        `🔒 ${esc(describeUser(user))} is allowed by the bot's \`.env\`, which I can't ` +
          'edit\\. Remove their id from `ALLOWED_USER_IDS` and restart\\.',
      );
      return;
    }
    if (result === 'not-allowed') {
      await replyMd(ctx, `✅ ${esc(describeUser(user))} already had no access\\.`);
      return;
    }
    console.log(`[access] ${ctx.from?.id} revoked ${describeUser(user)}`);
    await replyMd(ctx, `🚫 ${esc(describeUser(user))} is out\\.`);
  } catch (error) {
    console.error('[access] revoke failed:', sanitizeError(error));
    await replyMd(ctx, '❌ Could not save the roster — they *still* have access\\. Check the bot logs\\.');
  }
}

/** One roster line: name, handle and the id that is the real identity. */
function userLine(user: { id: number; username?: string; name?: string }): string {
  const label = user.name ?? (user.username ? `@${user.username}` : `id ${user.id}`);
  const handle = user.name && user.username ? ` @${user.username}` : '';
  return `• ${esc(label)}${esc(handle)} — \`${user.id}\``;
}

export async function handleUsers(ctx: Context): Promise<void> {
  const admins = getAdminIds();
  const env = envAllowedIds().filter((id) => !admins.includes(id));
  const admitted = listAdmitted();
  const pending = listPending();

  const lines: string[] = ['*Who can use this bot*'];

  lines.push('', `*Admins* \\(${admins.length}\\)`);
  for (const id of admins) lines.push(`• \`${id}\`${id === ctx.from?.id ? ' — you' : ''}`);

  if (env.length > 0) {
    lines.push('', `*Guests from \`.env\`* \\(${env.length}\\)`);
    for (const id of env) lines.push(`• \`${id}\``);
  }

  lines.push('', `*Guests admitted here* \\(${admitted.length}\\)`);
  if (admitted.length === 0) {
    lines.push('_none yet_');
  } else {
    for (const user of admitted) lines.push(userLine(user));
  }

  if (pending.length > 0) {
    const shown = pending.slice(0, 10);
    lines.push('', `*Seen but not allowed* \\(${pending.length}\\)`);
    for (const user of shown) lines.push(userLine(user));
    if (pending.length > shown.length) {
      lines.push(`_…and ${pending.length - shown.length} more_`);
    }
    lines.push('', 'Reply to one of their messages with `/allow` to let them in\\.');
  }

  await replyMd(ctx, lines.join('\n'));
}

/**
 * The Allow / Ignore buttons on an access card.
 *
 * Registered behind `adminOnly`, which answers the callback itself for anyone
 * else — so reaching here means an admin tapped it.
 */
export async function handleAccessCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith(`${ACCESS_CALLBACK_PREFIX}:`)) return;

  const [, rawId, verdict] = data.split(':');
  const userId = parseInt(rawId, 10);
  if (!Number.isFinite(userId)) {
    await ctx.answerCallbackQuery({ text: 'Malformed button.' }).catch(() => {});
    return;
  }

  const by = ctx.from?.id;
  if (by === undefined) return;

  // The card carries only an id. Recover the name from the roster so the
  // outcome line names a person rather than a number.
  const known = resolveUser(String(userId)) ?? { id: userId };

  if (verdict === 'y') {
    try {
      const result = admitUser(known, by);
      clearAccessCooldown(userId);
      const text =
        result === 'already-allowed'
          ? `${describeUser(known)} could already use this bot.`
          : `${describeUser(known)} is in, as a guest.`;
      await ctx.answerCallbackQuery({ text }).catch(() => {});
      await editCardOutcome(ctx, `✅ ${describeUser(known)} was allowed in.`);
      console.log(`[access] ${by} admitted ${describeUser(known)} by card`);
    } catch (error) {
      console.error('[access] admit failed:', sanitizeError(error));
      await ctx
        .answerCallbackQuery({ text: 'Could not save the roster — they are not in.', show_alert: true })
        .catch(() => {});
    }
    return;
  }

  await ctx.answerCallbackQuery({ text: `${describeUser(known)} was not let in.` }).catch(() => {});
  await editCardOutcome(ctx, `🚫 ${describeUser(known)} was not let in.`);
  console.log(`[access] ${by} ignored ${describeUser(known)}`);
}

/**
 * Replace the card with its outcome, so a group with several admins does not
 * keep a live pair of buttons on a decision that has already been taken.
 */
async function editCardOutcome(ctx: Context, text: string): Promise<void> {
  await ctx.editMessageText(text, { reply_markup: { inline_keyboard: [] } }).catch(() => {});
}
