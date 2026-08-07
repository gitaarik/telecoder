/**
 * Everything posted to the chat *after* a turn's main response: the catch-up
 * relay that recovers prose the extractors dropped, and the context-visibility
 * notices (usage footer, compaction, new-agent-session).
 *
 * Each notice consults the chat's verbosity settings itself, so callers fire
 * them unconditionally via `sendTurnNotifications`.
 */

import { Context } from 'grammy';
import type { AgentUsage } from '../../../providers/provider-router.js';
import { sessionManager } from '../../../claude/session-manager.js';
import { readLastAssistantTurnText } from '../../../claude/session-jsonl.js';
import { messageSender } from '../../../telegram/message-sender.js';
import { escapeMarkdownV2 as esc } from '../../../telegram/markdown.js';
import { resolveVerbosityFlags } from '../../../utils/verbosity.js';
import { fmtTokens, getProgressBar } from '../../../utils/format.js';

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

    const jsonlText = readLastAssistantTurnText(session.workingDirectory, session.claudeSessionId);
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

async function sendUsageFooter(
  ctx: Context,
  usage: AgentUsage | undefined,
): Promise<void> {
  if (!usage) return;
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  if (!resolveVerbosityFlags(chatId).showUsageFooter) return;
  const u = usage;
  const pct = u.contextWindow > 0
    ? Math.round(((u.inputTokens + u.outputTokens + u.cacheReadTokens) / u.contextWindow) * 100)
    : 0;
  const bar = getProgressBar(pct);
  const footer = `${bar} ${pct}% context · ${fmtTokens(u.inputTokens + u.outputTokens + u.cacheReadTokens)}/${fmtTokens(u.contextWindow)} · $${u.totalCostUsd.toFixed(4)} · ${u.numTurns} turns`;
  await ctx.reply(footer, { parse_mode: undefined });
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
 * verbosity settings want it, so callers just fire all three.
 */
export async function sendTurnNotifications(
  ctx: Context,
  sessionKey: string,
  response: {
    usage?: AgentUsage;
    compaction?: { trigger: 'manual' | 'auto'; preTokens: number };
    sessionInit?: { model: string; sessionId: string };
  },
): Promise<void> {
  await sendUsageFooter(ctx, response.usage);
  await sendCompactionNotification(ctx, response.compaction);
  await sendSessionInitNotification(ctx, sessionKey, response.sessionInit);
}
