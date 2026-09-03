/**
 * `/allow`, `/deny`, `/members` — managing who may prompt the agent in a group.
 *
 * Naming a person is the awkward part. The Bot API has no lookup from @handle
 * to user id, so the reliable form is a *reply*: reply to something the person
 * said and the update carries their id. `@handle` works too, but only once the
 * bot has seen them speak (see group-access's username cache), and a raw
 * numeric id always works. Telegram's `text_mention` entity — how someone with
 * no @handle gets tagged — carries the id outright, so it is accepted as well.
 *
 * Replies here are plain text on purpose. Everything interesting in them is a
 * handle or an id, and MarkdownV2 would need every `_` in a username and every
 * `.` in a sentence escaped for no gain in a three-line confirmation.
 */

import { Context } from 'grammy';
import { config } from '../../../config.js';
import {
  grantAccess,
  isOwner,
  listGroupAccess,
  resolveRole,
  resolveUserRef,
  revokeAccess,
} from '../../access/group-access.js';
import { groupDefaultIsContributor } from '../../middleware/group-role.middleware.js';

interface Target {
  userId: number;
  username?: string;
}

/** A person named by reply, by text_mention, by @handle, or by numeric id. */
function resolveTarget(ctx: Context): Target | { error: string } {
  const msg = ctx.message;
  if (!msg) return { error: 'Nothing to act on.' };

  const replied = msg.reply_to_message?.from;
  if (replied) {
    if (replied.id === ctx.me.id) return { error: "That's me." };
    return { userId: replied.id, username: replied.username };
  }

  const mention = (msg.entities ?? []).find((e) => e.type === 'text_mention');
  if (mention && 'user' in mention) {
    return { userId: mention.user.id, username: mention.user.username };
  }

  const arg = (msg.text ?? '').split(/\s+/).slice(1)[0];
  if (!arg) {
    return {
      error:
        'Who? Reply to one of their messages with this command, or pass @handle or a numeric user id.',
    };
  }

  const userId = resolveUserRef(arg);
  if (userId === undefined) {
    return {
      error:
        `I don't know ${arg} yet — I only learn a handle once I've seen that person post here. ` +
        'Reply to one of their messages with this command instead.',
    };
  }
  return { userId, username: arg.startsWith('@') ? arg.slice(1) : undefined };
}

/** How to refer to someone in a confirmation: handle if known, else bare id. */
function describe(target: Target): string {
  return target.username ? `@${target.username} (${target.userId})` : `user ${target.userId}`;
}

/** Group-only guard shared by all three commands. */
function requireGroup(ctx: Context): number | undefined {
  const chatType = ctx.chat?.type;
  if (chatType !== 'group' && chatType !== 'supergroup') return undefined;
  return ctx.chat?.id;
}

async function applyAccessChange(ctx: Context, action: 'allow' | 'deny'): Promise<void> {
  const chatId = requireGroup(ctx);
  if (chatId === undefined) {
    await ctx.reply(
      `/${action} manages access inside one group chat, so it only works there — run it in the group itself.`,
    );
    return;
  }

  const target = resolveTarget(ctx);
  if ('error' in target) {
    await ctx.reply(`❌ ${target.error}`);
    return;
  }

  if (isOwner(target.userId)) {
    await ctx.reply(
      action === 'allow'
        ? `${describe(target)} is an owner — they already have full access everywhere.`
        : `❌ ${describe(target)} is an owner. Owners come from the .env allow-list, so removing them means editing that file and restarting the bot.`,
    );
    return;
  }

  const grantedBy = ctx.from?.id;
  let previous;
  try {
    previous =
      action === 'allow'
        ? grantAccess(chatId, target.userId, { username: target.username, grantedBy })
        : revokeAccess(chatId, target.userId, { username: target.username, grantedBy });
  } catch (error) {
    // The store rethrows a failed write precisely so this doesn't confirm a
    // change that won't survive the next restart. A silent failure on /deny in
    // particular would leave someone thinking they had revoked access.
    console.error('[access] Failed to persist the change:', error);
    const detail = error instanceof Error ? error.message : String(error);
    await ctx.reply(`❌ Couldn't save that — nothing changed. ${detail}`);
    return;
  }

  console.log(`[access] ${grantedBy} set ${target.userId} to ${action} in ${chatId}`);

  if (action === 'allow') {
    const already = previous === 'contributor' ? ' (they already could — now it survives a default change)' : '';
    await ctx.reply(
      `✅ ${describe(target)} can now send prompts to the agent in this chat${already}.\n\n` +
        'Heads up: that means running commands on this machine, in whichever project the session is pointed at.',
    );
    return;
  }

  await ctx.reply(
    `🚫 ${describe(target)} is now a spectator here — they can read along and talk to everyone, ` +
      'but the bot will ignore anything they address to it.',
  );
}

export async function handleAllow(ctx: Context): Promise<void> {
  await applyAccessChange(ctx, 'allow');
}

export async function handleDeny(ctx: Context): Promise<void> {
  await applyAccessChange(ctx, 'deny');
}

export async function handleMembers(ctx: Context): Promise<void> {
  const chatId = requireGroup(ctx);
  if (chatId === undefined) {
    await ctx.reply('/members lists access for one group chat — run it in the group itself.');
    return;
  }

  const { allow, deny } = listGroupAccess(chatId);
  const label = (m: { userId: number; username?: string }) =>
    m.username ? `@${m.username} (${m.userId})` : String(m.userId);

  // Allow-listed non-owners are contributors everywhere without an entry in the
  // store, so /members has to add them back in or it under-reports who can
  // prompt. An explicit /deny still removes them from this group.
  const listed = new Set([...allow, ...deny].map((m) => m.userId));
  const implicit = config.ALLOWED_USER_IDS.filter(
    (id) => !config.OWNER_USER_IDS.includes(id) && !listed.has(id),
  ).map((id) => `${id} (allow-list)`);
  const contributors = [...allow.map(label), ...implicit];

  const lines = [
    `👥 Access in this chat (${chatId})`,
    '',
    `Default for anyone not listed: ${groupDefaultIsContributor() ? 'contributor' : 'spectator'}`,
    '',
    `Owners: ${config.OWNER_USER_IDS.join(', ') || '—'}`,
    `Contributors: ${contributors.join(', ') || '—'}`,
    `Spectators (explicit): ${deny.map(label).join(', ') || '—'}`,
  ];

  if (!groupDefaultIsContributor() && allow.length === 0) {
    lines.push(
      '',
      'Nobody has been granted yet. Reply to someone with /allow to let them prompt the agent.',
    );
  }

  await ctx.reply(lines.join('\n'));
}

/** The role the sender holds here — used by /status to show it. */
export function describeRole(ctx: Context): string | undefined {
  const chatId = requireGroup(ctx);
  const userId = ctx.from?.id;
  if (chatId === undefined || userId === undefined) return undefined;
  return resolveRole(chatId, userId);
}
