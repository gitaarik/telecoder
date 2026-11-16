/**
 * Helpers shared across the command handlers.
 *
 * These are the pieces that several unrelated command domains all reach for —
 * the markdown reply shorthand, the callback-query preamble, the project
 * status block. They live here so the domain modules depend on one small
 * shared surface instead of on each other.
 */

import { Context } from 'grammy';
import { sessionManager } from '../../../claude/session-manager.js';
import { envFilePath } from '../../../config.js';
import {
  getModel,
  getEffort,
  getActiveProviderName,
  type EffortLevel,
} from '../../../providers/provider-router.js';
import { EntityText, type EntityMessage } from '../../../telegram/entities.js';
import { replyMarkdown } from '../../../telegram/send.js';
import { fitsOnButton } from '../../../telegram/button-text.js';
import { getPtyProvider } from '../../../providers/claude-provider.js';
import { getSessionKeyFromCtx, parseSessionKey, type SettingsScope } from '../../../utils/session-key.js';
import { formatTimeAgo } from '../../../utils/format.js';
import { PACKAGE_ROOT } from '../../../utils/install-mode.js';

/** Repo root (the package root, in an npm install). */
export const PROJECT_ROOT = PACKAGE_ROOT;

/**
 * Reply with standard markdown, sent as entities. For static text only: a
 * dynamic part (a path, a name, an error) goes through an {@link EntityText}
 * instead, since nothing escapes it here.
 */
export async function replyMd(ctx: Context, markdown: string): Promise<void> {
  await replyMarkdown(ctx, markdown);
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
  await ctx.reply(buildFeatureDisabledMessage(feature));
}

/**
 * What a voice note or /transcribe gets when no Groq key is set: how to turn
 * transcription on, instead of a "Transcribing..." ack followed by a raw
 * "GROQ_API_KEY not configured" error. Declining voice in `telecoder init` is
 * the common case, so this is where most people learn how to add it later.
 */
export function buildVoiceNotSetUpMessage(): string {
  return [
    '🎤 Voice transcription is off: no Groq API key is set.',
    '',
    'To turn it on, get a key at https://console.groq.com/keys (Groq has a free tier), then either:',
    '• run `telecoder init` again — it keeps your other answers and asks for the key, or',
    `• add GROQ_API_KEY=gsk_... to ${envFilePath} and /restartbot.`,
  ].join('\n');
}

export async function replyVoiceNotSetUp(ctx: Context): Promise<void> {
  await ctx.reply(buildVoiceNotSetUpMessage());
}

export const EFFORT_LEVELS: { id: EffortLevel; label: string; description: string }[] = [
  { id: 'low', label: '🐇 Low', description: 'Minimal thinking, fastest' },
  { id: 'medium', label: '⚖️ Medium', description: 'Balanced speed/quality' },
  { id: 'high', label: '🧠 High', description: 'Deep reasoning' },
  { id: 'xhigh', label: '🔬 XHigh', description: 'Deeper than high (default on current models)' },
  { id: 'max', label: '🚀 Max', description: 'Maximum effort' },
];

/** Get the full label (e.g. "🐇 Low") for a thread's or chat's current effort level. */
export function getEffortLabel(scope: SettingsScope): string | undefined {
  const effort = getEffort(scope);
  if (!effort) return undefined;
  return EFFORT_LEVELS.find((l) => l.id === effort)?.label;
}

/** Build status lines appended to project confirmation messages. */
export function projectStatusSuffix(sessionKey: string): EntityMessage {
  const { chatId } = parseSessionKey(sessionKey);
  const model = getModel(sessionKey);
  const provider = getActiveProviderName(sessionKey);
  const session = sessionManager.getSession(sessionKey);
  const created = session?.createdAt
    ? new Date(session.createdAt).toLocaleString()
    : new Date().toLocaleString();
  const sessionId = session?.claudeSessionId;

  const effortLabel = getEffortLabel(sessionKey) ?? 'Default';
  const suffix = new EntityText()
    .add('\n• ').bold('Provider:').add(` ${provider}`)
    .add('\n• ').bold('Model:').add(` ${model}`)
    .add('\n• ').bold('Effort:').add(` ${effortLabel}`)
    .add('\n• ').bold('Created:').add(` ${created}`)
    .add('\n• ').bold('Session ID:').add(' ');
  if (sessionId) {
    suffix.code(sessionId);
    suffix.add('\n\n💡 To continue this session from the terminal, copy the command below.');
  } else {
    suffix.italic('pending — send a message to start');
  }
  return suffix.build();
}

/** The copyable command sent as a separate message. */
export function resumeCommandMessage(sessionId: string): EntityMessage {
  return new EntityText().code(`claude --resume ${sessionId}`).build();
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

export { formatTimeAgo };

/**
 * How much of a session's name a picker spells out.
 *
 * Nothing the model writes comes close — a topic is a handful of words — but
 * `/topic` takes whatever you type, and unbounded names could push a message
 * past Telegram's 4096-char ceiling, which would 400 and deliver nothing at
 * all. Generous enough never to touch a real name, low enough that a full
 * history can't cost the whole list.
 */
const MAX_SESSION_NAME_LEN = 120;

/**
 * How a session is named wherever one is offered: the project, plus the topic
 * when it has one. Shared so /resume and the back button name the same
 * session the same way.
 */
export function sessionDisplayName(entry: { projectName: string; topic?: string }): string {
  const name = entry.topic ? `${entry.projectName} · ${entry.topic}` : entry.projectName;
  return name.length > MAX_SESSION_NAME_LEN
    ? name.slice(0, MAX_SESSION_NAME_LEN - 1) + '…'
    : name;
}

/** The message and reply options for a message carrying the back button. */
export interface BackToPreviousReply {
  text: EntityMessage;
  options: {
    reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] };
  };
}

/**
 * Attach the one-tap "back to the session you just left" affordance to a
 * message, reusing the /resume callback. Returns the text to send and the
 * options to send it with, so the six commands that offer it don't each
 * repeat the append; with no session key, or no session to go back to, that
 * is the message unchanged.
 *
 * The session's name rides on the button while it fits, which is the whole of
 * the common case — `↩️ Back to telecoder (2h ago)` is one tap and adds
 * nothing to the chat. It stops fitting as soon as the session has a topic,
 * and a button is not a place to put text that doesn't fit: Telegram gives the
 * reader no way to expand the ellipsis, so the name was simply gone and the
 * button said "back to" something you couldn't read. Past that width the
 * button keeps a fixed short label and the name goes in the body, where it
 * survives whole.
 *
 * Skips the entry whose conversationId matches `excludeConversationId` so we
 * don't offer to return to the session you're already in.
 */
export function withBackToPrevious(
  text: EntityMessage,
  sessionKey: string | undefined,
  excludeConversationId?: string,
): BackToPreviousReply {
  const plain: BackToPreviousReply = { text, options: {} };
  if (!sessionKey) return plain;

  const history = sessionManager.getSessionHistory(sessionKey, 5);
  const entry = history.find(
    (e) => e.claudeSessionId && e.conversationId !== excludeConversationId,
  );
  if (!entry) return plain;

  const timeAgo = formatTimeAgo(new Date(entry.lastActivity));
  const name = sessionDisplayName(entry);
  const label = `↩️ Back to ${name} (${timeAgo})`;
  const fits = fitsOnButton(label);

  return {
    text: fits ? text : new EntityText().append(text).add(`\n\n↩️ Previous: ${name} (${timeAgo})`).build(),
    options: {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: fits ? label : '↩️ Back to previous',
              callback_data: `resume:${entry.conversationId}`,
            },
          ],
        ],
      },
    },
  };
}

/**
 * Settings that are read at PTY spawn time only take effect on a fresh spawn.
 * Clearing the conversation makes the next message respawn with the new value,
 * keeping the conversation itself intact.
 */
export function restartPtyForSettingChange(sessionKey: string): boolean {
  if (!needsPtyRestart(sessionKey)) return false;
  getPtyProvider().clearConversation(sessionKey);
  return true;
}

/**
 * Whether a spawn-time setting change would need a pty restart here —
 * the same test restartPtyForSettingChange makes, without doing it. For
 * rebuilding a confirmation whose restart already happened.
 */
export function needsPtyRestart(_scope: SettingsScope): boolean {
  // Every chat runs in a pty, on Claude and on CCR alike. Kept as the one
  // test its callers ask, for the day a provider without a pty returns.
  return true;
}

/** Note appended when a pty restart is pending. */
export const PTY_RESTART_NOTE: EntityMessage = new EntityText()
  .add('\n\n')
  .italic('Claude Code restarts on your next message to pick this up (the conversation is kept).')
  .build();
