/**
 * Session topic and Telegram bot display name.
 *
 * The topic is ephemeral per-session state (persisted only through
 * sessionHistory) that several other command domains read and reset — project
 * switches, /clear, and resume all touch it — so it lives in its own module
 * rather than inside any one of them.
 */

import { Context } from 'grammy';
import * as path from 'path';
import { config } from '../../../config.js';
import { sessionManager } from '../../../claude/session-manager.js';
import { sessionHistory } from '../../../claude/session-history.js';
import { readLastAiTitle } from '../../../claude/session-jsonl.js';
import { escapeMarkdownV2 as esc } from '../../../telegram/markdown.js';
import {
  getBotNameSettings,
  setBotNameEnabled,
  isBotNameEnabled,
  rateLimitedSetMyName,
  notifyBotNameBlock,
} from '../../../telegram/botname-settings.js';
import { getSessionKeyFromCtx } from '../../../utils/session-key.js';
import { replyMd, parseCallback } from './shared.js';


// Per-session topic (ephemeral — not persisted across restarts)
const sessionTopics: Map<string, string> = new Map();
// Per-session timestamp of last setSessionTopic call. Used by the auto-topic
// reminder hook to skip the per-turn nudge when the topic was just updated.
const lastTopicSetAt: Map<string, number> = new Map();

/** Build the bot display name from base name and project. Topic now lives in the status line. */
export function buildBotDisplayName(sessionKey: string): string {
  const session = sessionManager.getSession(sessionKey);
  const project = session?.workingDirectory ? path.basename(session.workingDirectory) : '';
  const parts: string[] = [config.BOT_NAME];
  if (project) parts.push(project);
  return parts.join(' — ').slice(0, 64);
}

/**
 * Push a display name to Telegram (rate-limited) and surface any block notice.
 * Swallows errors — a failed name update should never break the calling flow.
 * `context` is used only for the debug log so failures are attributable.
 */
export async function pushBotName(ctx: Context, name: string, context: string): Promise<void> {
  try {
    const result = await rateLimitedSetMyName(ctx.api, (n) => ctx.api.setMyName(n), name);
    await notifyBotNameBlock(ctx, result);
  } catch (err) {
    console.debug(`[Bot] Failed to set bot name (${context}):`, err instanceof Error ? err.message : err);
  }
}

/** Update the Telegram bot display name to reflect the active project and topic. */
export async function updateBotName(ctx: Context, sessionKey: string, projectPath: string): Promise<void> {
  if (!isBotNameEnabled(sessionKey)) return;
  await pushBotName(ctx, buildBotDisplayName(sessionKey), 'update');
}

/**
 * Clear the session topic and refresh the bot display name accordingly.
 * Called whenever the conversation context is wiped (clear, reset, project switch).
 */
export async function clearTopicAndRefreshBotName(ctx: Context, sessionKey: string): Promise<void> {
  setSessionTopic(sessionKey, '');
  if (!isBotNameEnabled(sessionKey)) return;
  await pushBotName(ctx, buildBotDisplayName(sessionKey), 'topic clear');
}

/**
 * Restore the session topic from the saved value (or clear if absent) and refresh
 * the bot display name. Called when resuming/continuing a previous conversation.
 *
 * When no persisted topic exists, fall back to Claude Code's `aiTitle` from the
 * session JSONL — better a stale session label than a blank topic line on resume.
 */
export async function restoreTopicAndRefreshBotName(ctx: Context, sessionKey: string, topic: string | undefined): Promise<void> {
  if (!topic) {
    const session = sessionManager.getSession(sessionKey);
    if (session?.claudeSessionId) {
      topic = readLastAiTitle(session.workingDirectory, session.claudeSessionId);
    }
  }
  setSessionTopic(sessionKey, topic || '');
  if (!isBotNameEnabled(sessionKey)) return;
  await pushBotName(ctx, buildBotDisplayName(sessionKey), 'topic restore');
}

/**
 * Set the session topic programmatically (used by MCP tool and auto-resume).
 * Returns the new display name string.
 */
export function setSessionTopic(sessionKey: string, topic: string): string {
  if (topic) {
    sessionTopics.set(sessionKey, topic);
  } else {
    sessionTopics.delete(sessionKey);
  }
  lastTopicSetAt.set(sessionKey, Date.now());
  // Persist so topic survives restarts
  sessionHistory.updateTopic(sessionKey, topic || undefined);
  return buildBotDisplayName(sessionKey);
}

/** Get the current session topic. */
export function getSessionTopic(sessionKey: string): string | undefined {
  return sessionTopics.get(sessionKey);
}

/** Milliseconds since the last setSessionTopic call (or undefined if never). */
export function getMsSinceTopicSet(sessionKey: string): number | undefined {
  const at = lastTopicSetAt.get(sessionKey);
  return at !== undefined ? Date.now() - at : undefined;
}

export async function handleTopic(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const text = ctx.message?.text || '';
  const topic = text.split(' ').slice(1).join(' ').trim();

  // Topic lives in the status line, not the Telegram bot name —
  // setSessionTopic updates in-memory + persistent state but the bot's
  // Telegram-side display name doesn't change, so no setMyName call.
  setSessionTopic(sessionKey, topic);
  await replyMd(ctx, topic ? `✅ Topic: *${esc(topic)}*` : '✅ Topic cleared');
}

export async function handleBotName(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const settings = getBotNameSettings(sessionKey);
  const currentStatus = settings.enabled ? 'ON' : 'OFF';

  const keyboard = [
    [
      {
        text: settings.enabled ? '✓ On' : 'On',
        callback_data: 'botname:on'
      },
      {
        text: !settings.enabled ? '✓ Off' : 'Off',
        callback_data: 'botname:off'
      },
    ],
  ];

  const description = settings.enabled
    ? '_Bot name updates to include the active project when switching_'
    : '_Bot name stays as configured in BOT\\_NAME_';

  await ctx.reply(
    `✏️ *Dynamic Bot Name*\n\nCurrent: *${currentStatus}*\n${description}`,
    {
      parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: keyboard },
    }
  );
}

export async function handleBotNameCallback(ctx: Context): Promise<void> {
  const cb = parseCallback(ctx, 'botname:');
  if (!cb) return;
  const { sessionKey, data } = cb;

  const newState = data.replace('botname:', '') === 'on';
  setBotNameEnabled(sessionKey, newState);

  const statusText = newState ? 'ON' : 'OFF';
  const description = newState
    ? '_Bot name updates to include the active project when switching_'
    : '_Bot name stays as configured in BOT\\_NAME_';

  await ctx.answerCallbackQuery({ text: `Dynamic bot name ${statusText}!` });
  await ctx.editMessageText(
    `✅ Dynamic Bot Name *${statusText}*\n\n${description}`,
    { parse_mode: 'MarkdownV2' }
  );

  // Reset bot name to base when disabling
  if (!newState) {
    await pushBotName(ctx, config.BOT_NAME, 'disable reset');
  }
}

