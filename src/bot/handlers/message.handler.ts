/**
 * Entry point for ordinary (non-command) Telegram messages, plus the public
 * surface of the message-handling domain.
 *
 * `handleMessage` decides what a message *is* — a reply to a ForceReply
 * prompt, a pending fork to offer, or a prompt for the agent — and hands off to the module that owns that flow. The domains
 * live in `./message/`:
 *
 *   shared.ts      helpers every entry point needs (session, topic, queueing)
 *   turn-runner.ts running a prompt through a provider; all turn entry points
 *   turn-notify.ts what gets posted after a turn: catch-up relay + notices
 *   replies.ts     the ForceReply answer handlers
 *   throttle.ts    CCR throttle state and the switch-and-retry prompt
 *
 * Re-exports below keep the import path stable for bot.ts and the other
 * consumers that predate the split.
 */

import { Context } from 'grammy';
import { isDuplicate, markProcessed } from '../../telegram/deduplication.js';
import { isStaleMessage } from '../middleware/stale-filter.js';
import { isClaudeCommand, stripCommandBotMention } from '../../claude/command-parser.js';
import { offerPendingForkIfAny } from './fork.handler.js';
import { getSessionKeyFromCtx } from '../../utils/session-key.js';
import { fireAutoTopic, requireSession, runQueuedTurn } from './message/shared.js';
import { runTurn } from './message/turn-runner.js';
import {
  handleProjectReply,
  handleFileReply,
  handleAgentReply,
  handleTelegraphReply,
} from './message/replies.js';

export { relayCatchUpIfMissed } from './message/turn-notify.js';
export { runQueuedTurn } from './message/shared.js';
export { formatResetIn } from './message/throttle.js';
export { handleCcrThrottleCallback, dispatchPromptFromCallback } from './message/turn-runner.js';

export async function handleMessage(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  const rawText = ctx.message?.text;
  const messageId = ctx.message?.message_id;
  const messageDate = ctx.message?.date;

  if (!keyInfo || !rawText || !messageId || !messageDate) return;
  const { chatId, sessionKey } = keyInfo;

  // In group chats Telegram appends `@BotName` to slash commands
  // (`/compact@MyBot`). Strip it so command detection below — and native
  // slash commands forwarded to the agent, like /compact — see a clean token
  // rather than one the PTY TUI would type verbatim. No-op for ordinary text.
  const text = stripCommandBotMention(rawText);

  // Filter stale messages (sent before bot started)
  if (isStaleMessage(messageDate)) {
    console.log(`[Message] Ignoring stale message ${messageId} from before bot start`);
    return;
  }

  // Check for duplicate messages (Telegram retries)
  if (isDuplicate(messageId)) {
    console.log(`[Message] Ignoring duplicate message ${messageId}`);
    return;
  }
  markProcessed(messageId);

  // Check if this is a reply to a ForceReply prompt
  const replyTo = ctx.message?.reply_to_message;
  if (replyTo && replyTo.from?.is_bot) {
    const replyText = replyTo.text || '';

    // Handle project path reply
    if (replyText.includes('Set Project Directory')) {
      await handleProjectReply(ctx, sessionKey, text);
      return;
    }

    // Handle telegraph/instant view reply (check BEFORE file - both have "file path")
    if (replyText.includes('Instant View') || replyText.includes('Markdown files')) {
      await handleTelegraphReply(ctx, sessionKey, text);
      return;
    }

    // Handle file download reply
    if (replyText.includes('Download File')) {
      await handleFileReply(ctx, sessionKey, text);
      return;
    }

    // Handle plan mode reply
    if (replyText.includes('Plan Mode') || replyText.includes('Describe your task')) {
      await handleAgentReply(ctx, sessionKey, text, 'plan');
      return;
    }

    // Handle explore mode reply
    if (replyText.includes('Explore Mode') || replyText.includes('What would you like to know')) {
      await handleAgentReply(ctx, sessionKey, text, 'explore');
      return;
    }

    // Handle loop mode reply
    if (replyText.includes('Loop Mode') || replyText.includes('work iteratively')) {
      await handleAgentReply(ctx, sessionKey, text, 'loop');
      return;
    }
  }

  // Skip if this is a Claude command (handled by command handler)
  if (isClaudeCommand(text)) {
    return;
  }

  // If a /fork from another bot is sitting in our pending-forks file, the
  // user's first non-command message triggers the accept/decline prompt and
  // gets held back. /accept and /decline (handled above as commands) bypass
  // this — slash commands route to the command handler, not handleMessage.
  if (await offerPendingForkIfAny(ctx)) {
    return;
  }

  // Check for active session — falls back to disk if the bot restarted recently.
  if (!await requireSession(ctx, sessionKey)) return;

  fireAutoTopic(ctx, sessionKey, text);

  // Queue the request - process one at a time per session
  await runQueuedTurn(ctx, sessionKey, text, 'Message', () =>
    runTurn(ctx, sessionKey, chatId, text),
  );
}
