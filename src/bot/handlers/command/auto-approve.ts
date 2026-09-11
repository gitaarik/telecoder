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
import { escapeMarkdownV2 as esc } from '../../../telegram/markdown.js';
import { replyMd } from './shared.js';

/** How the announcement names whoever opened the window. */
function describeOpener(ctx: Context): string {
  const from = ctx.from;
  if (!from) return 'someone';
  return [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || `user ${from.id}`;
}

function carveOutLines(): string[] {
  return listAlwaysPrompted().map((reason) => `• ${esc(reason)}`);
}

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
    await replyMd(ctx, `❌ ${esc(duration.error)}`);
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

  const lines = [
    `⚡ *Auto\\-approve is on for ${esc(formatDuration(durationMs))}*`,
    '',
    `Opened by ${esc(openerName)}\\. Guarded commands in this chat will run without ` +
      'asking, and each one is posted here as it happens\\.',
    '',
    '*Still asks, always:*',
    ...carveOutLines(),
    '',
    'End it early with `/autoapprove off`\\.',
  ];

  if (existing) {
    lines.splice(2, 0, `_Replaces the window ${esc(existing.openedByName)} opened, which had ${esc(formatRemaining(existing))} left\\._`, '');
  }

  if (!isPermissionGateEnabled()) {
    lines.push(
      '',
      '⚠️ The permission gate is *off* in this bot, so nothing was prompting in ' +
        'the first place and this window changes nothing\\.',
    );
  }

  await replyMd(ctx, lines.join('\n'));
}

async function handleClose(ctx: Context, chatId: number): Promise<void> {
  const closed = closeWindow(chatId);
  if (!closed) {
    await replyMd(ctx, '✅ No auto\\-approve window is open here\\.');
    return;
  }

  // Anyone who could open one can close one, including someone else's: a
  // supervision hole should be closable by whoever notices it, not only by
  // whoever left it open.
  const byOther = closed.openedBy !== ctx.from?.id;
  console.log(`[AutoApprove] chat:${chatId} closed by ${ctx.from?.id ?? '?'}${byOther ? ` (opened by ${closed.openedBy})` : ''}`);

  await replyMd(
    ctx,
    `🔒 *Auto\\-approve is off\\.*\n\n${esc(describeTally(closed))}` +
      (byOther ? `\n\n_It was ${esc(closed.openedByName)}'s window\\._` : ''),
  );
}

async function handleStatus(ctx: Context, chatId: number): Promise<void> {
  const window = getWindow(chatId);
  if (!window) {
    const lines = [
      '🔒 *Auto\\-approve is off here\\.*',
      '',
      'Guarded commands post an approval prompt, and an admin or approver taps it\\.',
      '',
      'Open a window with `/autoapprove 30m`\\.',
    ];
    if (!isAdmin(ctx.from?.id)) {
      lines.push('', '_You can open one — approvers may, guests may not\\._');
    }
    await replyMd(ctx, lines.join('\n'));
    return;
  }

  await replyMd(
    ctx,
    [
      `⚡ *Auto\\-approve is on — ${esc(formatRemaining(window))} left\\.*`,
      '',
      `Opened by ${esc(window.openedByName)}\\. ${esc(describeTally(window))}`,
      '',
      '*Still asks, always:*',
      ...carveOutLines(),
      '',
      'End it early with `/autoapprove off`\\.',
    ].join('\n'),
  );
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
