/**
 * `/autoapprove` — open, inspect and close a chat's auto-approve window.
 *
 * The command is deliberately small. Everything about what a window *means*
 * lives in src/claude/auto-approve.ts; this file is the part a person types at,
 * and its job is to make two things impossible to get wrong: how long the
 * window lasts, and what it does not cover. Both are stated when it opens,
 * because that is the only moment someone is definitely reading.
 */

import type { Context } from 'grammy';
import {
  closeWindow,
  formatDuration,
  formatRemaining,
  getWindow,
  listAlwaysPrompted,
  openWindow,
  parseWindowDuration,
  type AutoApproveWindow,
} from '../../../claude/auto-approve.js';
import { isPermissionGateEnabled } from '../../../claude/permission-gate.js';
import { isAdmin } from '../../../utils/admins.js';
import { EntityText, type EntityMessage } from '../../../telegram/entities.js';
import { replyFormatted } from '../../../telegram/send.js';

/** How the announcement names whoever opened the window. */
function describeOpener(ctx: Context): string {
  const from = ctx.from;
  if (!from) return 'someone';
  return [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || `user ${from.id}`;
}

/** The carve-outs a window never approves, under their heading. */
function appendCarveOuts(b: EntityText): EntityText {
  b.bold('Still asks, always:');
  for (const reason of listAlwaysPrompted()) b.add(`\n• ${reason}`);
  return b;
}

/** A heading line: the emoji, then the rest in bold. */
function heading(emoji: string, text: string): EntityText {
  return new EntityText().add(`${emoji} `).bold(text);
}

const END_EARLY: EntityMessage = new EntityText()
  .add('End it early with ').code('/autoapprove off').add('.')
  .build();

export async function handleAutoApprove(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;

  const arg = (ctx.message?.text ?? '').split(' ').slice(1).join(' ').trim();
  const lowered = arg.toLowerCase();

  if (lowered === 'off' || lowered === 'stop' || lowered === 'end') {
    await handleClose(ctx, chatId);
    return;
  }

  if (lowered === 'status') {
    await handleStatus(ctx, chatId);
    return;
  }

  const duration = parseWindowDuration(arg);
  if (!duration.ok) {
    await ctx.reply(`❌ ${duration.error}`);
    return;
  }

  await handleOpen(ctx, chatId, duration.ms);
}

async function handleOpen(ctx: Context, chatId: number, durationMs: number): Promise<void> {
  const existing = getWindow(chatId);
  const openerName = describeOpener(ctx);

  const window = openWindow(chatId, {
    openedBy: ctx.from?.id ?? 0,
    openedByName: openerName,
    durationMs,
    // Announced rather than silent: a window that lapses unnoticed leaves
    // people tapping prompts they thought were handled, and — worse the other
    // way — a window people believe is shut but is not.
    onExpire: (lapsed) => {
      void announceExpiry(ctx, lapsed);
    },
  });

  console.log(
    `[AutoApprove] chat:${chatId} opened by ${ctx.from?.id ?? '?'} for ${formatDuration(durationMs)}`
    + (existing ? ' (replacing an open window)' : ''),
  );

  const b = heading('⚡', `Auto-approve is on for ${formatDuration(durationMs)}`).add('\n\n');
  if (existing) {
    b.italic(`Replaces the window ${existing.openedByName} opened, which had ${formatRemaining(existing)} left.`)
      .add('\n\n');
  }
  b.add(
    `Opened by ${openerName}. Guarded commands in this chat will run without ` +
      'asking, and each one is posted here as it happens.\n\n',
  );
  appendCarveOuts(b).add('\n\n').append(END_EARLY);

  if (!isPermissionGateEnabled()) {
    b.add('\n\n⚠️ The permission gate is ').bold('off')
      .add(' in this bot, so nothing was prompting in the first place and this window changes nothing.');
  }

  await replyFormatted(ctx, b.build());
}

async function handleClose(ctx: Context, chatId: number): Promise<void> {
  const closed = closeWindow(chatId);
  if (!closed) {
    await ctx.reply('✅ No auto-approve window is open here.');
    return;
  }

  // Anyone who could open one can close one, including someone else's: a
  // supervision hole should be closable by whoever notices it, not only by
  // whoever left it open.
  const byOther = closed.openedBy !== ctx.from?.id;
  console.log(`[AutoApprove] chat:${chatId} closed by ${ctx.from?.id ?? '?'}${byOther ? ` (opened by ${closed.openedBy})` : ''}`);

  const b = heading('🔒', 'Auto-approve is off.').add(`\n\n${describeTally(closed)}`);
  if (byOther) b.add('\n\n').italic(`It was ${closed.openedByName}'s window.`);
  await replyFormatted(ctx, b.build());
}

async function handleStatus(ctx: Context, chatId: number): Promise<void> {
  const window = getWindow(chatId);
  if (!window) {
    const b = heading('🔒', 'Auto-approve is off here.')
      .add('\n\nGuarded commands post an approval prompt, and an admin or approver taps it.')
      .add('\n\nOpen a window with ').code('/autoapprove 30m').add('.');
    if (!isAdmin(ctx.from?.id)) {
      b.add('\n\n').italic('You can open one — approvers may, guests may not.');
    }
    await replyFormatted(ctx, b.build());
    return;
  }

  const b = heading('⚡', `Auto-approve is on — ${formatRemaining(window)} left.`)
    .add(`\n\nOpened by ${window.openedByName}. ${describeTally(window)}\n\n`);
  appendCarveOuts(b).add('\n\n').append(END_EARLY);
  await replyFormatted(ctx, b.build());
}

function describeTally(window: AutoApproveWindow): string {
  if (window.approved === 0) return 'Nothing has needed approving yet.';
  return window.approved === 1
    ? 'It approved 1 command.'
    : `It approved ${window.approved} commands.`;
}

async function announceExpiry(ctx: Context, window: AutoApproveWindow): Promise<void> {
  console.log(`[AutoApprove] chat:${window.chatId} lapsed after approving ${window.approved}`);
  try {
    await ctx.api.sendMessage(
      window.chatId,
      `🔒 Auto-approve has lapsed — guarded commands ask again. ${describeTally(window)}`,
    );
  } catch (err) {
    // Fires on a bare timer with nobody to catch it, and a chat that has gone
    // away must not take the process with it.
    console.error('[AutoApprove] expiry notice failed:', err instanceof Error ? err.message : err);
  }
}
