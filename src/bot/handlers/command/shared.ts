/**
 * Helpers shared across the command handlers.
 *
 * These are the pieces that several unrelated command domains all reach for —
 * the MarkdownV2 reply shorthand, the callback-query preamble, the project
 * status block. They live here so the domain modules depend on one small
 * shared surface instead of on each other.
 */

import { Context } from 'grammy';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { sessionManager } from '../../../claude/session-manager.js';
import {
  getModel,
  getEffort,
  isDangerousMode,
  getActiveProviderName,
  type EffortLevel,
} from '../../../providers/provider-router.js';
import { escapeMarkdownV2 as esc } from '../../../telegram/markdown.js';
import { userPreferences } from '../../../providers/user-preferences.js';
import { getPtyProvider } from '../../../providers/claude-provider.js';
import { getSessionKeyFromCtx, parseSessionKey } from '../../../utils/session-key.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Repo root — four levels up from `src/bot/handlers/command/`. */
export const PROJECT_ROOT = path.resolve(__dirname, '../../../..');
export const BOTCTL_PATH = path.join(PROJECT_ROOT, 'scripts', 'telecoder-botctl.sh');

export function botctlExists(): boolean {
  return fs.existsSync(BOTCTL_PATH);
}

/** Helper for consistent MarkdownV2 replies */
export async function replyMd(ctx: Context, text: string): Promise<void> {
  await ctx.reply(text, { parse_mode: 'MarkdownV2' });
}

/**
 * Resolve the session-key info and callback-data for a callback-query handler,
 * gated on the data starting with `prefix`. Returns null (so the caller can
 * early-return) when there is no session key, no callback data, or the data
 * doesn't match the prefix. Folds the repeated keyInfo + data guard preamble
 * that every prefix-scoped callback handler shares.
 */
export function parseCallback(
  ctx: Context,
  prefix: string,
): { chatId: number; threadId?: number; sessionKey: string; data: string } | null {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return null;
  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith(prefix)) return null;
  return { ...keyInfo, data };
}

export function buildFeatureDisabledMessage(feature: string): string {
  return `⚠️ ${feature} feature is disabled in configuration.`;
}

export async function replyFeatureDisabled(ctx: Context, feature: string): Promise<void> {
  await ctx.reply(buildFeatureDisabledMessage(feature), { parse_mode: undefined });
}

export const EFFORT_LEVELS: { id: EffortLevel; label: string; description: string }[] = [
  { id: 'low', label: '🐇 Low', description: 'Minimal thinking, fastest' },
  { id: 'medium', label: '⚖️ Medium', description: 'Balanced speed/quality' },
  { id: 'high', label: '🧠 High', description: 'Deep reasoning' },
  { id: 'xhigh', label: '🔬 XHigh', description: 'Deeper than high (default on current models)' },
  { id: 'max', label: '🚀 Max', description: 'Maximum effort' },
];

/** Get the full label (e.g. "🐇 Low") for a chat's current effort level. */
export function getEffortLabel(chatId: number): string | undefined {
  const effort = getEffort(chatId);
  if (!effort) return undefined;
  return EFFORT_LEVELS.find((l) => l.id === effort)?.label;
}

/** Build status lines appended to project confirmation messages. */
export function projectStatusSuffix(sessionKey: string): string {
  const { chatId } = parseSessionKey(sessionKey);
  const model = getModel(chatId);
  const provider = getActiveProviderName(chatId);
  const dangerous = isDangerousMode() ? '⚠️ ENABLED' : 'Disabled';
  const session = sessionManager.getSession(sessionKey);
  const created = session?.createdAt
    ? new Date(session.createdAt).toLocaleString()
    : new Date().toLocaleString();
  const sessionId = session?.claudeSessionId;

  const effortLabel = getEffortLabel(chatId) ?? 'Default';
  let suffix = `\n• *Provider:* ${esc(provider)}\n• *Model:* ${esc(model)}\n• *Effort:* ${esc(effortLabel)}\n• *Created:* ${esc(created)}\n• *Dangerous Mode:* ${esc(dangerous)}`;
  if (sessionId) {
    suffix += `\n• *Session ID:* \`${esc(sessionId)}\``;
    suffix += `\n\n💡 To continue this session from the terminal, copy the command below\\.`;
  } else {
    suffix += `\n• *Session ID:* _pending — send a message to start_`;
  }
  return suffix;
}

/** The copyable command sent as a separate message. */
export function resumeCommandMessage(sessionId: string): string {
  return `\`claude --resume ${sessionId}\``;
}

/** Truncate a string to fit within `maxBytes` UTF-8 bytes without splitting a codepoint. */
export function truncateToBytes(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  let out = '';
  for (const ch of s) {
    if (Buffer.byteLength(out + ch, 'utf8') > maxBytes) break;
    out += ch;
  }
  return out;
}

export function formatTimeAgo(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

/**
 * One-tap "Back to previous" inline keyboard, reusing the /resume callback.
 * Skips the entry whose conversationId matches `excludeConversationId` so we
 * don't offer to return to the session you're already in.
 */
export function buildBackToPreviousButton(
  sessionKey: string,
  excludeConversationId?: string,
): { text: string; callback_data: string }[][] | undefined {
  const history = sessionManager.getSessionHistory(sessionKey, 5);
  const entry = history.find(
    (e) => e.claudeSessionId && e.conversationId !== excludeConversationId,
  );
  if (!entry) return undefined;

  const timeAgo = formatTimeAgo(new Date(entry.lastActivity));
  const detail = entry.topic ? `${entry.projectName}: ${entry.topic}` : entry.projectName;
  const trimmed = detail.length > 45 ? `${detail.slice(0, 44)}…` : detail;
  return [[{ text: `↩️ Back to ${trimmed} (${timeAgo})`, callback_data: `resume:${entry.conversationId}` }]];
}

/**
 * Settings that are read at PTY spawn time only take effect on a fresh spawn.
 * Clearing the conversation makes the next message respawn with the new value,
 * keeping the conversation itself intact. No-op for non-PTY providers.
 */
export function restartPtyForSettingChange(chatId: number, sessionKey: string): boolean {
  if (getActiveProviderName(chatId) !== 'claude') return false;
  if (userPreferences.getMethod(chatId) !== 'pty') return false;
  getPtyProvider().clearConversation(sessionKey);
  return true;
}

/** Escaped MarkdownV2 note appended when a pty restart is pending. */
export const PTY_RESTART_NOTE = '\n\n_Claude Code restarts on your next message to pick this up \\(the conversation is kept\\)\\._';
