/**
 * Entry point for ordinary (non-command) Telegram messages, plus the public
 * surface of the message-handling domain.
 *
 * `handleMessage` decides what a message *is* — a reply to a ForceReply
 * prompt, a bare media/reddit URL, a pending fork to offer, or a prompt for
 * the agent — and hands off to the module that owns that flow. The domains
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
import { config } from '../../config.js';
import { isDuplicate, markProcessed } from '../../telegram/deduplication.js';
import { isStaleMessage } from '../middleware/stale-filter.js';
import { isProcessing, getQueuePosition, cancelRequest, clearQueue } from '../../claude/request-queue.js';
import { isClaudeCommand, stripCommandBotMention } from '../../claude/command-parser.js';
import { executeRedditFetch, executeMediumFetch, showExtractMenu } from './command.handler.js';
import { executeVReddit } from '../../reddit/vreddit.js';
import { detectPlatform, isValidUrl } from '../../media/extract.js';
import { offerPendingForkIfAny } from './fork.handler.js';
import { getSessionKeyFromCtx } from '../../utils/session-key.js';
import { fireAutoTopic, replyFeatureDisabled, requireSession, runQueuedTurn } from './message/shared.js';
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

export function extractRedditUrl(text: string): string | null {
  const matches = text.match(/https?:\/\/\S+/gi);
  if (!matches) return null;
  for (const match of matches) {
    try {
      const url = new URL(match);
      if (url.hostname === 'reddit.com' || url.hostname.endsWith('.reddit.com') || url.hostname === 'redd.it' || url.hostname === 'v.redd.it') {
        return match;
      }
    } catch {
      // ignore malformed URLs
    }
  }
  return null;
}

export function getAutoVRedditUrl(text: string): string | null {
  if (!config.VREDDIT_ENABLED) return null;

  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('/')) return null;

  const url = extractRedditUrl(trimmed);
  if (!url) return null;

  const tokens = trimmed.split(/\s+/);
  const isSolo = tokens.length === 1;
  const askedForVReddit = /\bvreddit\b|\bv\s*reddit\b/i.test(trimmed);

  return isSolo || askedForVReddit ? url : null;
}

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

    // Handle reddit fetch reply
    if (replyText.includes('Reddit Fetch') || replyText.includes('Reddit target')) {
      if (!config.REDDIT_ENABLED) {
        await replyFeatureDisabled(ctx, 'Reddit');
        return;
      }
      await executeRedditFetch(ctx, text.trim());
      return;
    }

    // Handle Reddit video fetch reply
    if (replyText.includes('Reddit Video')) {
      if (!config.VREDDIT_ENABLED) {
        await replyFeatureDisabled(ctx, 'Reddit video');
        return;
      }
      await executeVReddit(ctx, text.trim());
      return;
    }

    // Handle medium fetch reply
    if (replyText.includes('Medium Fetch') || replyText.includes('Medium article')) {
      if (!config.MEDIUM_ENABLED) {
        await replyFeatureDisabled(ctx, 'Medium');
        return;
      }
      await executeMediumFetch(ctx, text.trim());
      return;
    }

    // Handle extract media reply
    if (replyText.includes('Extract Media') || replyText.includes('Paste a URL')) {
      if (!config.EXTRACT_ENABLED) {
        await replyFeatureDisabled(ctx, 'Extract');
        return;
      }
      await showExtractMenu(ctx, text.trim());
      return;
    }
  }

  const vRedditUrl = getAutoVRedditUrl(text);
  if (vRedditUrl) {
    await executeVReddit(ctx, vRedditUrl);
    return;
  }

  // Auto-detect YouTube / TikTok / Instagram URLs sent as bare links → show extract menu
  const trimmedText = text.trim();
  if (config.EXTRACT_ENABLED && isValidUrl(trimmedText) && detectPlatform(trimmedText) !== 'unknown') {
    await showExtractMenu(ctx, trimmedText);
    return;
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

  // If CANCEL_ON_NEW_MESSAGE is enabled, auto-cancel the running query;
  // otherwise queue the new message behind it and show the queue position.
  if (isProcessing(sessionKey)) {
    if (config.CANCEL_ON_NEW_MESSAGE) {
      await cancelRequest(sessionKey);
      clearQueue(sessionKey);
    } else {
      const position = getQueuePosition(sessionKey) + 1;
      await ctx.reply(`⏳ Queued \\(position ${position}\\)`, { parse_mode: 'MarkdownV2' });
    }
  }

  fireAutoTopic(ctx, sessionKey, text);

  // Queue the request - process one at a time per session
  await runQueuedTurn(ctx, sessionKey, text, 'Message', () =>
    runTurn(ctx, sessionKey, chatId, text),
  );
}
