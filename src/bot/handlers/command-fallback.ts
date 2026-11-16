/**
 * "Did you mean" for a mistyped bot command.
 *
 * A slash command the bot never registered falls through to the agent as a
 * prompt, so `/task` or `/shel` ends up typed into Claude, which answers
 * "unknown command" at best. Before that happens, a token within a typo of a
 * bot command is checked against what Claude Code accepts here (its own
 * commands, skills, plugins and `.claude/commands/`), and when Claude doesn't
 * know it either the likely commands come back as buttons. A tap re-sends the
 * message with the corrected command and the arguments as typed, back through
 * the whole middleware chain as if the user had typed it.
 *
 * Anything Claude Code does know, or that we can't check, goes through as
 * before: the fallback only ever answers for a name nobody accepts.
 */

import { InlineKeyboard, type Bot, type Context } from 'grammy';
import type { Update } from 'grammy/types';
import { sessionManager } from '../../claude/session-manager.js';
import { getBotCommandNames, getForwardedCommandNames } from '../../claude/command-parser.js';
import { getAvailableCommands, getCachedAvailableCommands } from '../../claude/available-commands.js';
import { getProjectCommands } from '../../claude/project-commands.js';
import { resolvePtyClaudeBin } from '../../utils/resolve-claude-bin.js';
import { sanitizeError } from '../../utils/sanitize.js';
import { markAlreadyAddressed } from '../middleware/group-mention.middleware.js';
import { buildUnknownCommandMessage, findCommandFix, type CommandFix } from '../command-catalog.js';
import { EntityText } from '../../telegram/entities.js';
import { editCallbackMessage, replyFormatted } from '../../telegram/send.js';
import { parseCallback } from './command/shared.js';

type MessageUpdate = Update & { message: NonNullable<Update['message']> };

interface PendingFix {
  update: MessageUpdate;
  fix: CommandFix;
  expiresAt: number;
}

/** Keyed by the notice that carries the buttons. */
const pending = new Map<string, PendingFix>();
const PENDING_TTL_MS = 15 * 60 * 1000;
const PENDING_MAX = 200;

/** How long to wait for a cold command probe before letting the message through. */
const PROBE_WAIT_MS = 6000;

const CALLBACK_PREFIX = 'cmdfix:';
const BUTTON_MAX = 48;

let botRef: Bot | undefined;

/** Called once, so a tap can send the corrected message back through the bot. */
export function initCommandFallback(bot: Bot): void {
  botRef = bot;
}

function key(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`;
}

function prune(): void {
  const now = Date.now();
  for (const [k, entry] of pending) {
    if (entry.expiresAt < now) pending.delete(k);
  }
  while (pending.size >= PENDING_MAX) {
    const oldest = pending.keys().next().value;
    if (oldest === undefined) break;
    pending.delete(oldest);
  }
}

function commandLine(command: string, args: string): string {
  return args ? `/${command} ${args}` : `/${command}`;
}

function buttonLabel(command: string, args: string): string {
  const line = commandLine(command, args);
  return `▶️ ${line.length > BUTTON_MAX ? line.slice(0, BUTTON_MAX - 1) + '…' : line}`;
}

function delay(ms: number): Promise<undefined> {
  return new Promise((resolve) => setTimeout(() => resolve(undefined), ms));
}

/**
 * Answer a mistyped command with the likely ones. Returns true when it did,
 * false when the message should go on to the agent as usual.
 */
export async function offerCommandFix(ctx: Context, sessionKey: string, text: string): Promise<boolean> {
  const fix = findCommandFix(text, {
    botNames: getBotCommandNames(),
    forwarded: getForwardedCommandNames(),
  });
  if (!fix) return false;

  const session = sessionManager.getSession(sessionKey);
  if (!session) return false;
  const workingDirectory = session.workingDirectory;

  // A project command added since the last probe isn't in the snapshot yet.
  if (getProjectCommands(workingDirectory).some((c) => c.name === fix.token)) return false;

  const executable = resolvePtyClaudeBin();
  let snapshot = getCachedAvailableCommands(workingDirectory, executable);
  if (!snapshot) {
    // A cold cache means a probe — a fresh headless process — so show typing
    // rather than leave the chat silent; the probe keeps running past the
    // wait and fills the cache for next time.
    const typing = ctx.replyWithChatAction?.('typing');
    snapshot = await Promise.race([getAvailableCommands(workingDirectory, executable), delay(PROBE_WAIT_MS)]);
    await typing?.catch(() => { /* chat action is best-effort */ });
  }
  // Without Claude's list there's no telling a typo from a command we don't
  // know about, so let it through.
  if (!snapshot) return false;
  if (snapshot.slashCommands.includes(fix.token)) return false;

  const keyboard = new InlineKeyboard();
  fix.suggestions.forEach((s, i) => {
    keyboard.text(buttonLabel(s.command, fix.args), `${CALLBACK_PREFIX}${i}`).row();
  });
  const sent = await replyFormatted(ctx, buildUnknownCommandMessage(fix.token, fix.suggestions), {
    reply_markup: keyboard,
  });
  prune();
  pending.set(key(sent.chat.id, sent.message_id), {
    update: ctx.update as MessageUpdate,
    fix,
    expiresAt: Date.now() + PENDING_TTL_MS,
  });
  console.log(`[Commands] /${fix.token} isn't a command; suggested ${fix.suggestions.map((s) => '/' + s.command).join(', ')}`);
  return true;
}

/** A tap on a suggestion: send the corrected message as if it had been typed. */
export async function handleCommandFixCallback(ctx: Context): Promise<void> {
  const parsed = parseCallback(ctx, CALLBACK_PREFIX);
  const notice = ctx.callbackQuery?.message;
  if (!parsed || !notice) return;

  const k = key(notice.chat.id, notice.message_id);
  const entry = pending.get(k);
  const choice = entry?.fix.suggestions[Number(parsed.data.slice(CALLBACK_PREFIX.length))];
  if (!entry || !choice || entry.expiresAt < Date.now() || !botRef) {
    await ctx.answerCallbackQuery({ text: 'That suggestion has expired — type the command again.' });
    return;
  }
  pending.delete(k);

  const text = commandLine(choice.command, entry.fix.args);
  const update = structuredClone(entry.update);
  update.message.text = text;
  // grammY finds commands by their entity, so the new token needs one.
  update.message.entities = [{ type: 'bot_command', offset: 0, length: choice.command.length + 1 }];
  update.message.date = Math.floor(Date.now() / 1000);
  // The typo's own id has been through the duplicate filter once already;
  // the notice's never arrived as a message, so it is free.
  update.message.message_id = notice.message_id;
  // Whoever tapped sends it, under their own access.
  if (ctx.from) update.message.from = ctx.from;

  await ctx.answerCallbackQuery();
  await editCallbackMessage(ctx, new EntityText().add('▶️ ').code(text).build())
    .catch((err: unknown) => console.warn('[Commands] Could not update the suggestion notice:', sanitizeError(err)));
  markAlreadyAddressed(update);
  console.log(`[Commands] Sending ${text.split(' ')[0]} for a mistyped /${entry.fix.token}`);
  void botRef.handleUpdate(update).catch((err: unknown) => {
    console.error('[Commands] Sending the corrected command failed:', sanitizeError(err));
  });
}
