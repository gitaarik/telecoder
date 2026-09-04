/**
 * Handing out access from chat: `/allow`, `/deny`, `/users`, `/members`.
 *
 * These exist because the alternative is editing `ALLOWED_USER_IDS` and
 * restarting, and because the obvious shape — "just type their @username" —
 * cannot work on its own. No Bot API method resolves a username to a user id.
 * `getChatAdministrators` returns full user objects, but only for a group's
 * admins; nothing lists ordinary members at all. A bot only ever learns a
 * username by watching one go past.
 *
 * So they lean on the same two moves the bot already makes: it records everyone
 * it sees in a shared group, and it posts a tap-to-approve card when a stranger
 * turns up. Typing a username is the fallback, not the primary path — `/allow`
 * as a reply to someone's message is exact, works for the many Telegram users
 * who have no username at all, and cannot be aimed at the wrong person by a
 * handle that changed hands.
 *
 * There are two access layers, and `/allow` means the nearer one:
 *
 *   - In an allow-listed group it makes someone a *contributor there*. That is
 *     the least surprising reading of a command typed in a room — and the
 *     narrower grant, since it does not also hand out a private channel with
 *     the bot that nobody else in the group can see.
 *   - In a DM it admits them to the *global roster*, which is what makes them a
 *     contributor in every group at once.
 *
 * `/users` reads back the first, `/members` the second.
 */

import { Context } from 'grammy';
import { config } from '../../../config.js';
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
import {
  grantAccess,
  groupDefaultIsContributor,
  listGroupAccess,
  resolveRole,
  revokeAccess,
} from '../../access/group-access.js';
import { ACCESS_CALLBACK_PREFIX, clearAccessCooldown } from '../../../telegram/access-request.js';
import { sanitizeError } from '../../../utils/sanitize.js';
import { replyMd } from './shared.js';

/** The argument text after the command word, or '' when there is none. */
function argsOf(ctx: Context): string {
  const text = ctx.message?.text ?? '';
  return text.split(' ').slice(1).join(' ').trim();
}

/**
 * The allow-listed group this update is in, or undefined for anywhere else.
 *
 * This is what decides whether `/allow` means "here" or "everywhere", so it is
 * deliberately strict: an unlisted group is not a scope anyone has agreed to
 * hand out access in.
 */
function groupScope(ctx: Context): number | undefined {
  const chatId = ctx.chat?.id;
  const type = ctx.chat?.type;
  if (chatId === undefined) return undefined;
  if (type !== 'group' && type !== 'supergroup') return undefined;
  return config.ALLOWED_GROUP_IDS.includes(chatId) ? chatId : undefined;
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

  const chatId = groupScope(ctx);
  if (chatId !== undefined) {
    try {
      const previous = grantAccess(chatId, user.id, { username: user.username, grantedBy: by });
      clearAccessCooldown(user.id);
      console.log(`[access] ${by} made ${describeUser(user)} a contributor in ${chatId}`);
      const already =
        previous === 'contributor'
          ? ' They already could — now it survives a change of default\\.'
          : '';
      await replyMd(
        ctx,
        `✅ ${esc(describeUser(user))} can send prompts to the agent in this chat\\.${already}\n\n` +
          '⚠️ That means running commands on this machine, in whichever project the ' +
          'session is pointed at\\.',
      );
    } catch (error) {
      // The store rethrows a failed write precisely so this doesn't confirm a
      // change that won't survive the next restart.
      console.error('[access] grant failed:', sanitizeError(error));
      await replyMd(ctx, '❌ Could not save that — nothing changed\\. Check the bot logs\\.');
    }
    return;
  }

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

  const by = ctx.from?.id;
  const chatId = groupScope(ctx);
  if (chatId !== undefined) {
    try {
      revokeAccess(chatId, user.id, { username: user.username, grantedBy: by });
      clearAccessCooldown(user.id);
      console.log(`[access] ${by} made ${describeUser(user)} a spectator in ${chatId}`);
      await replyMd(
        ctx,
        `🚫 ${esc(describeUser(user))} is a *spectator* here — they can read along and talk ` +
          'to everyone, but the bot will ignore anything they address to it\\.\n\n' +
          'This covers *this chat*\\. If they are on the bot\'s global roster, `/deny` them in ' +
          'a DM to take that away too\\.',
      );
    } catch (error) {
      console.error('[access] revoke failed:', sanitizeError(error));
      await replyMd(ctx, '❌ Could not save that — they *still* have access here\\. Check the bot logs\\.');
    }
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

/** Who may drive the agent in this one group. The per-group half of /users. */
export async function handleMembers(ctx: Context): Promise<void> {
  const chatId = groupScope(ctx);
  if (chatId === undefined) {
    await replyMd(
      ctx,
      '`/members` lists access for one group chat — run it in the group itself\\.\n\n' +
        'Use `/users` for who can reach the bot at all\\.',
    );
    return;
  }

  const { allow, deny } = listGroupAccess(chatId);
  const label = (m: { userId: number; username?: string }) =>
    m.username ? `@${esc(m.username)} \\(\`${m.userId}\`\\)` : `\`${m.userId}\``;

  // Anyone on the global roster is a contributor here without an entry in the
  // store, so /members has to add them back in or it under-reports who can
  // prompt. An explicit /deny still removes them from this group.
  const admins = getAdminIds();
  const listed = new Set([...allow, ...deny].map((m) => m.userId));
  const implicit = [...envAllowedIds(), ...listAdmitted().map((u) => u.id)]
    .filter((id) => !admins.includes(id) && !listed.has(id) && resolveRole(chatId, id) === 'contributor')
    .map((id) => `\`${id}\` \\(roster\\)`);
  const contributors = [...allow.map(label), ...implicit];

  const lines = [
    `*Access in this chat* \\(\`${chatId}\`\\)`,
    '',
    `Default for anyone not listed: *${groupDefaultIsContributor() ? 'contributor' : 'spectator'}*`,
    '',
    `*Admins:* ${admins.map((id) => `\`${id}\``).join(', ') || '—'}`,
    `*Contributors:* ${contributors.join(', ') || '—'}`,
    `*Spectators \\(explicit\\):* ${deny.map(label).join(', ') || '—'}`,
  ];

  if (!groupDefaultIsContributor() && allow.length === 0) {
    lines.push(
      '',
      'Nobody has been granted here yet\\. Reply to someone with `/allow` to let them prompt the agent\\.',
    );
  }

  await replyMd(ctx, lines.join('\n'));
}

/**
 * The Allow / Ignore buttons on an access card.
 *
 * Registered behind `adminOnly`, which answers the callback itself for anyone
 * else — so reaching here means an admin tapped it.
 *
 * The card is only ever posted in an allow-listed group, so "allow" here means
 * the same as `/allow` typed in that group: a contributor in this chat, not a
 * key to the bot everywhere.
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
    const chatId = groupScope(ctx);
    try {
      if (chatId !== undefined) {
        grantAccess(chatId, userId, { username: known.username, grantedBy: by });
        clearAccessCooldown(userId);
        await ctx
          .answerCallbackQuery({ text: `${describeUser(known)} can prompt the agent here.` })
          .catch(() => {});
        await editCardOutcome(ctx, `✅ ${describeUser(known)} was allowed in, as a contributor here.`);
        console.log(`[access] ${by} made ${describeUser(known)} a contributor in ${chatId} by card`);
        return;
      }

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
        .answerCallbackQuery({ text: 'Could not save that — they are not in.', show_alert: true })
        .catch(() => {});
    }
    return;
  }

  await ctx.answerCallbackQuery({ text: `${describeUser(known)} was not let in.` }).catch(() => {});
  await editCardOutcome(ctx, `🚫 ${describeUser(known)} was not let in.`);
  console.log(`[access] ${by} ignored ${describeUser(known)}`);
}

/** The role the sender holds here — used by /status to show it. */
export function describeRole(ctx: Context): string | undefined {
  const chatId = groupScope(ctx);
  const userId = ctx.from?.id;
  if (chatId === undefined || userId === undefined) return undefined;
  return resolveRole(chatId, userId);
}

/**
 * Replace the card with its outcome, so a group with several admins does not
 * keep a live pair of buttons on a decision that has already been taken.
 */
async function editCardOutcome(ctx: Context, text: string): Promise<void> {
  await ctx.editMessageText(text, { reply_markup: { inline_keyboard: [] } }).catch(() => {});
}
