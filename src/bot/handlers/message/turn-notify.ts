/**
 * Everything posted to the chat *after* a turn's main response: the catch-up
 * relay that recovers prose the extractors dropped, the context-visibility
 * notices (compaction, new-agent-session), and the status line that comes
 * last. The usage footer isn't a message of its own: it goes out at the bottom
 * of the status line, see `sendStatusLine`.
 *
 * Each notice consults the chat's verbosity settings itself, and the status
 * line the chat's /statusline ones, so callers fire them unconditionally via
 * `closeTurn`.
 */

import { Context } from 'grammy';
import { sessionManager } from '../../../claude/session-manager.js';
import { readLastAssistantTurnText } from '../../../claude/session-jsonl.js';
import { getPtyProvider } from '../../../providers/claude-provider.js';
import { getCachedUsage } from '../../../providers/provider-router.js';
import type { AgentResponse } from '../../../providers/types.js';
import { messageSender } from '../../../telegram/message-sender.js';
import { escapeMarkdownV2 as esc } from '../../../telegram/markdown.js';
import { resolveVerbosityFlags } from '../../../utils/verbosity.js';
import { fmtTokens } from '../../../utils/format.js';
import { stripReasoningSummary } from '../../../utils/reasoning-summary.js';
import { sendStatusLine, type StatusLineOptions } from '../command/settings.js';

/**
 * After a turn's main response has been sent to Telegram, compare what we
 * relayed against the canonical assistant text in Claude Code's session JSONL.
 * If the JSONL has more prose than we sent — typical for the lossy extractor
 * paths (pure tool-call turns that returned empty, multi-block screen-scrape
 * dropping earlier blocks, early end-of-turn before JSONL flush) — post the
 * missing content as a follow-up. Updates the per-session tracker either way.
 *
 * Best-effort: any failure logs and swallows so a catch-up bug can never
 * break the primary relay path. Skips silently when the session has no
 * claudeSessionId (e.g. SDK mode), since the JSONL doesn't exist there.
 */
export async function relayCatchUpIfMissed(
  ctx: Context,
  sessionKey: string,
  relayedText: string,
): Promise<void> {
  try {
    const session = sessionManager.getSession(sessionKey);
    if (!session?.claudeSessionId) {
      sessionManager.setLastRelayedAssistantText(sessionKey, relayedText);
      return;
    }

    // The relayed text went out without its reasoning summary; the log still
    // has it. Compared as is, the summary alone counts as missing prose, and
    // a turn with a tool call in it gets the whole reply posted again.
    const jsonlText = stripReasoningSummary(
      readLastAssistantTurnText(session.workingDirectory, session.claudeSessionId) ?? '',
    );
    if (!jsonlText) {
      sessionManager.setLastRelayedAssistantText(sessionKey, relayedText);
      return;
    }

    // 20-char slack absorbs trailing-whitespace / trim differences between
    // the screen-scrape and JSONL forms. Below that, treat as in sync.
    if (jsonlText.length <= relayedText.length + 20) {
      sessionManager.setLastRelayedAssistantText(sessionKey, jsonlText);
      return;
    }

    // If what we sent is a prefix of the canonical text (PTY happy path that
    // truncated mid-stream), post only the suffix. Otherwise post the full
    // canonical version — the texts come from different extractors and any
    // mid-string diff would risk dropping the actually-missing content.
    const missing = jsonlText.startsWith(relayedText) && relayedText.length > 0
      ? jsonlText.slice(relayedText.length).trim()
      : jsonlText;
    if (!missing) {
      sessionManager.setLastRelayedAssistantText(sessionKey, jsonlText);
      return;
    }

    await ctx.reply('📨 *Catch\\-up* — recovered from session log', { parse_mode: 'MarkdownV2' });
    await messageSender.sendMessage(ctx, missing);
    sessionManager.setLastRelayedAssistantText(sessionKey, jsonlText);
  } catch (err) {
    console.error('[CatchUp] post-relay check failed:', err instanceof Error ? err.message : err);
  }
}

async function sendCompactionNotification(
  ctx: Context,
  compaction: { trigger: 'manual' | 'auto'; preTokens: number } | undefined,
): Promise<void> {
  if (!compaction) return;
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  if (!resolveVerbosityFlags(chatId).notifyCompaction) return;
  const c = compaction;
  console.log(`[Compaction] Sending notification: trigger=${c.trigger}, preTokens=${c.preTokens}`);
  const emoji = c.trigger === 'auto' ? '⚠️' : 'ℹ️';
  const triggerLabel = c.trigger === 'auto' ? 'Auto-compacted' : 'Manually compacted';
  try {
    const msg = `${emoji} *Context Compacted*\n\n`
      + `${esc(triggerLabel)} — previous context was ${esc(fmtTokens(c.preTokens))} tokens\\.\n`
      + `The agent now has a summarized version of your conversation\\.\n\n`
      + `_Tip: Use /handoff before compaction to save a detailed context document\\._`;
    await ctx.reply(msg, { parse_mode: 'MarkdownV2' });
  } catch (err) {
    console.error('[Compaction] Failed to send notification:', err);
    // Fallback to plain text if MarkdownV2 fails
    try {
      await ctx.reply(
        `${emoji} Context Compacted\n\n`
        + `${triggerLabel} — previous context was ${fmtTokens(c.preTokens)} tokens.\n`
        + `The agent now has a summarized version of your conversation.`,
        { parse_mode: undefined }
      );
    } catch (fallbackErr) {
      console.error('[Compaction] Fallback notification also failed:', fallbackErr);
    }
  }
}

async function sendSessionInitNotification(
  ctx: Context,
  sessionKey: string,
  sessionInit: { model: string; sessionId: string } | undefined,
): Promise<void> {
  if (!sessionInit) return;
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  if (!resolveVerbosityFlags(chatId).notifyCompaction) return;
  const previousSessionId = sessionManager.getSession(sessionKey)?.claudeSessionId;
  if (previousSessionId && sessionInit.sessionId !== previousSessionId) {
    const msg = `🔄 *New Agent Session*\n\n`
      + `A new agent session has started \\(previous context may be summarized\\)\\.\n`
      + `Model: \`${esc(sessionInit.model)}\`\n\n`
      + `_The agent may not remember earlier details\\. Consider sharing context\\._`;
    await ctx.reply(msg, { parse_mode: 'MarkdownV2' });
  }
}

/**
 * The context-visibility notices every finished turn posts, in the order the
 * user expects to read them. Each one decides for itself whether the chat's
 * verbosity settings want it, so callers just fire both.
 */
export async function sendTurnNotifications(
  ctx: Context,
  sessionKey: string,
  response: {
    compaction?: { trigger: 'manual' | 'auto'; preTokens: number };
    sessionInit?: { model: string; sessionId: string };
  },
): Promise<void> {
  await sendCompactionNotification(ctx, response.compaction);
  await sendSessionInitNotification(ctx, sessionKey, response.sessionInit);
}

/**
 * What closes a turn, however it started: the context notices, then the status
 * line. A typed message, a voice note, an upload, /plan, /explore, /loop and a
 * scheduled fire all end here. Each used to write its own ending, and only the
 * typed message's had the status line, so a turn started any other way left
 * the chat on the tail of its reply with nothing to say where things stood.
 *
 * `prompt` is what the turn was sent, for a session whose log has no prompts
 * for the status line to list.
 */
export async function closeTurn(
  ctx: Context,
  sessionKey: string,
  response: Pick<AgentResponse, 'usage' | 'compaction' | 'sessionInit'>,
  prompt: string,
  options?: StatusLineOptions,
): Promise<void> {
  await sendTurnNotifications(ctx, sessionKey, response);
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  // Not every response carries a usage: a /loop's doesn't, though each of its
  // iterations left one behind, and neither does a cancelled turn's. The line
  // then shows what the session last had, rather than no model and no context.
  const usage = response.usage ?? getCachedUsage(sessionKey);
  await sendStatusLine(ctx, chatId, sessionKey, usage, prompt, options);
}

/**
 * The close of a turn claude started itself, when a background task reported
 * back. Its reply is often the answer the exchange was for, it tends to land
 * while the user is elsewhere, and no prompt of theirs sits above it, so it
 * closes with the status line like any other.
 *
 * Nothing ran that turn for us: there's no response to take the usage from,
 * and the cached figure is the one the turn before it left. The session log
 * has what this one left. The prompts come from the log as well, which lists
 * what the user sent and not what a task reported.
 */
export async function closeSelfStartedTurn(ctx: Context, sessionKey: string): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  await sendStatusLine(ctx, chatId, sessionKey, getPtyProvider().refreshUsage(sessionKey));
}
