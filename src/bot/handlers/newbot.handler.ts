/**
 * /newbot: a bot for one project, without a trip to BotFather.
 *
 * A bot with Bot Management Mode on (BotFather's Mini App) can offer a button
 * that opens Telegram's own create-a-bot screen. Telegram reports the new bot
 * in a `managed_bot_created` message, we fetch its token, lock it to its
 * owner, and add it to instances.json with HOME_PROJECT set. The launcher
 * watches that file and starts it.
 *
 * Telegram doesn't say which button a new bot came from, so the project
 * waits here per user, from the /newbot to the bot it creates. And anyone can
 * create a bot managed by ours through a t.me/newbot link, so only an admin's
 * is adopted.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Context } from 'grammy';
import { isAdmin } from '../../utils/admins.js';
import { sanitizeError } from '../../utils/sanitize.js';
import { addInstance } from '../../utils/instances.js';
import { InstancesConfigError } from '../../utils/instance-config.js';
import { getWorkspaceRoot } from '../../utils/workspace-guard.js';
import { getSessionKeyFromCtx } from '../../utils/session-key.js';
import { sessionManager } from '../../claude/session-manager.js';
import { escapeMarkdownV2 as esc } from '../../telegram/markdown.js';

/** How long a /newbot waits for the bot it asked for. */
const PENDING_TTL_MS = 60 * 60_000;
/** Telegram's limits on a bot's name and username. */
const MAX_NAME_LENGTH = 64;
const MAX_USERNAME_LENGTH = 32;

const pending = new Map<number, { projectPath: string; at: number }>();

/** The name a new bot for `project` is offered: the user can change it. */
export function suggestedBotName(project: string): string {
  return `TeleCoder — ${project}`.slice(0, MAX_NAME_LENGTH);
}

/**
 * The username a new bot for `project` is offered: lowercase letters, digits
 * and underscores, ending in "bot", at most 32 long. Taken ones are refused
 * on the creation screen, where the user can change it.
 */
export function suggestedBotUsername(project: string): string {
  const suffix = '_telecoder_bot';
  const slug = project.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'project';
  return `${slug.slice(0, MAX_USERNAME_LENGTH - suffix.length).replace(/_+$/, '')}${suffix}`;
}

/** The folder `/newbot <args>` means, the way /project reads it. */
function resolveProject(args: string): string {
  if (args.startsWith('~')) return path.resolve(path.join(process.env.HOME || '', args.slice(1)));
  if (args.startsWith('/')) return path.resolve(args);
  return path.join(getWorkspaceRoot(), args);
}

export async function handleNewBot(ctx: Context): Promise<void> {
  if (ctx.chat?.type !== 'private' || !ctx.from) {
    await ctx.reply('/newbot works in a private chat with the bot.');
    return;
  }
  if (!ctx.me.can_manage_bots) {
    await ctx.reply(
      '🤖 This bot can\'t create bots. Turn on Bot Management Mode for it in @BotFather\'s Mini App, then try again.',
    );
    return;
  }

  const args = (ctx.message?.text ?? '').split(' ').slice(1).join(' ').trim();
  const keyInfo = getSessionKeyFromCtx(ctx);
  const current = keyInfo ? sessionManager.getSession(keyInfo.sessionKey)?.workingDirectory : undefined;
  const projectPath = args ? resolveProject(args) : current;
  if (!projectPath) {
    await ctx.reply('Usage: /newbot <project>, or /newbot alone for the project this chat is in.');
    return;
  }
  if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
    await ctx.reply(`📁 There's no project folder at ${projectPath}. Create it with /newproject first.`);
    return;
  }

  const project = path.basename(projectPath);
  pending.set(ctx.from.id, { projectPath, at: Date.now() });
  await ctx.reply(
    `🤖 Tap the button to create a bot for *${esc(project)}*\\. You can change its name and username on the next screen\\.\n\n` +
      'It starts in that project, and its threads are named without the project in front\\.',
    {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        keyboard: [[{
          text: `🤖 Create a bot for ${project}`,
          request_managed_bot: {
            request_id: Math.floor(Math.random() * 2 ** 31),
            suggested_name: suggestedBotName(project),
            suggested_username: suggestedBotUsername(project),
          },
        }]],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    },
  );
}

export async function handleManagedBotCreated(ctx: Context): Promise<void> {
  const created = ctx.message?.managed_bot_created?.bot;
  const from = ctx.from;
  if (!created || !from) return;
  if (!isAdmin(from.id)) {
    console.log(`[NewBot] Ignoring bot ${created.id} created by non-admin ${from.id}`);
    return;
  }

  const waiting = pending.get(from.id);
  pending.delete(from.id);
  const projectPath = waiting && Date.now() - waiting.at < PENDING_TTL_MS ? waiting.projectPath : undefined;
  const handle = created.username ? `@${created.username}` : created.first_name;
  const done = { reply_markup: { remove_keyboard: true as const } };

  let token: string;
  try {
    token = await ctx.api.getManagedBotToken(created.id);
  } catch (err) {
    console.error('[NewBot] getManagedBotToken failed:', sanitizeError(err));
    await ctx.reply(`❌ ${handle} was created, but its token couldn't be fetched: ${sanitizeError(err)}`, done);
    return;
  }

  // ALLOWED_USER_IDS already keeps strangers out of the conversation; this
  // keeps them from opening a chat with the bot at all.
  let locked = true;
  try {
    await ctx.api.setManagedBotAccessSettings(created.id, true);
  } catch (err) {
    locked = false;
    console.warn('[NewBot] setManagedBotAccessSettings failed:', sanitizeError(err));
  }

  let name: string;
  try {
    name = addInstance({
      name: created.first_name,
      token,
      overrides: projectPath ? { HOME_PROJECT: projectPath } : {},
    });
  } catch (err) {
    const reason = err instanceof InstancesConfigError ? err.message : sanitizeError(err);
    console.error(`[NewBot] Couldn't add bot ${created.id} to instances.json: ${reason}`);
    await ctx.reply(`❌ ${handle} was created, but instances.json couldn't take it: ${reason}`, done);
    return;
  }
  console.log(`[NewBot] Added bot ${created.id} as "${name}"${projectPath ? ` for ${projectPath}` : ''}`);

  const link = created.username ? `[${esc(handle)}](https://t.me/${created.username})` : `*${esc(handle)}*`;
  const lines = [
    projectPath
      ? `✅ ${link} is set up for *${esc(path.basename(projectPath))}* and starts in a few seconds\\.`
      : `✅ ${link} is set up and starts in a few seconds\\. It has no project of its own: this /newbot had expired\\.`,
    '',
    'To give it threads, turn on Threaded Mode for it in @BotFather\'s Mini App\\.',
  ];
  if (!locked) lines.push('', '⚠️ Couldn\'t restrict who can open it\\. Only allowed users get answers either way\\.');
  await ctx.reply(lines.join('\n'), { parse_mode: 'MarkdownV2', ...done });
}

/** Test hook. */
export function resetNewBotForTest(): void {
  pending.clear();
}
