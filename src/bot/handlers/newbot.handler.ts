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
import type { Api, Context } from 'grammy';
import { isAdmin } from '../../utils/admins.js';
import { sanitizeError } from '../../utils/sanitize.js';
import { addInstance } from '../../utils/instances.js';
import { InstancesConfigError } from '../../utils/instance-config.js';
import { getWorkspaceRoot } from '../../utils/workspace-guard.js';
import { getSessionKeyFromCtx, parseSessionKey } from '../../utils/session-key.js';
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

/** What offerNewBot did: the button is up, or why it isn't. */
export type OfferResult = { ok: true; project: string } | { ok: false; message: string };

let canManageBots: boolean | undefined;

/**
 * Put the create-a-bot button for `projectPath` in front of `userId`, in
 * their private chat with this bot (and in `threadId`, when given). Shared by
 * /newbot and the telecoder_create_bot tool, so asking the agent for a bot
 * gets the same button: Telegram only creates one when its user confirms.
 */
export async function offerNewBot(
  api: Api,
  userId: number,
  projectPath: string,
  threadId?: number,
): Promise<OfferResult> {
  if (!isAdmin(userId)) return { ok: false, message: 'Only an admin of this bot can create bots.' };
  // Only a yes is kept: a no should notice Bot Management Mode being turned on.
  if (!canManageBots) canManageBots = (await api.getMe()).can_manage_bots;
  if (!canManageBots) {
    return {
      ok: false,
      message: 'This bot can\'t create bots. Turn on Bot Management Mode for it in @BotFather\'s Mini App, then try again.',
    };
  }
  if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
    return { ok: false, message: `There's no project folder at ${projectPath}. Create it with /newproject first.` };
  }

  const project = path.basename(projectPath);
  pending.set(userId, { projectPath, at: Date.now() });
  await api.sendMessage(
    userId,
    `🤖 Tap the button to create a bot for *${esc(project)}*\\. You can change its name and username on the next screen\\.\n\n` +
      'It starts in that project, and its threads are named without the project in front\\.',
    {
      parse_mode: 'MarkdownV2',
      ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
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
  return { ok: true, project };
}

/** The folder a project name or path means, the way /project reads it. */
export function resolveProject(args: string): string {
  if (args.startsWith('~')) return path.resolve(path.join(process.env.HOME || '', args.slice(1)));
  if (args.startsWith('/')) return path.resolve(args);
  return path.join(getWorkspaceRoot(), args);
}

/**
 * The telecoder_create_bot tool: offer the button in the chat a turn runs
 * in. Returns what to tell the agent, which is also what the user is waiting
 * on: the bot only exists once they tap and confirm.
 */
export async function offerNewBotForSession(api: Api, sessionKey: string, projectName: string): Promise<{ ok: boolean; message: string }> {
  const { chatId, threadId } = parseSessionKey(sessionKey);
  // A private chat's id is its user's id, and only there can the button go.
  if (chatId <= 0) return { ok: false, message: 'Bots can only be created from a private chat with this bot.' };
  const projectPath = resolveProject(projectName.trim());
  const result = await offerNewBot(api, chatId, projectPath, threadId);
  if (!result.ok) return result;
  return {
    ok: true,
    message: `Sent the user a button to create a bot for ${result.project}. Nothing exists until they tap it and confirm on Telegram's screen; ` +
      'then this bot adds it to instances.json, the launcher starts it, and a confirmation follows in this chat.',
  };
}

export async function handleNewBot(ctx: Context): Promise<void> {
  if (ctx.chat?.type !== 'private' || !ctx.from) {
    await ctx.reply('/newbot works in a private chat with the bot.');
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

  const threadId = ctx.message?.is_topic_message ? ctx.message.message_thread_id : undefined;
  const result = await offerNewBot(ctx.api, ctx.from.id, projectPath, threadId);
  if (!result.ok) await ctx.reply(`🤖 ${result.message}`);
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
  // keeps them from opening a chat with the bot at all. Its creator has to be
  // named: "the owner can always access it" didn't cover them, and a /start
  // from them never reached the bot.
  let locked = true;
  try {
    await ctx.api.setManagedBotAccessSettings(created.id, true, { added_user_ids: [from.id] });
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
    'It has no threads yet: only you can turn them on, in [@BotFather](https://t.me/BotFather)\'s Mini App\\. Message it and it walks you through it, and tells you once they\'re on\\.',
  ];
  if (!locked) lines.push('', '⚠️ Couldn\'t restrict who can open it\\. Only allowed users get answers either way\\.');
  await ctx.reply(lines.join('\n'), { parse_mode: 'MarkdownV2', ...done });
}

/** Test hook. */
export function resetNewBotForTest(): void {
  pending.clear();
  canManageBots = undefined;
}
