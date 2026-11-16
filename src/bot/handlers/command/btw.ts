/**
 * /btw — ask a side question without disturbing the main conversation.
 *
 * Runs the question against a fork of the current session, streaming a
 * progress line while it works, so the answer lands without the main turn
 * losing its place.
 */

import { Context } from 'grammy';
import { sessionManager } from '../../../claude/session-manager.js';
import { askForkedSideQuestion, type SideQuestionProgress } from '../../../claude/side-question.js';
import { messageSender } from '../../../telegram/message-sender.js';
import { getActiveProviderName } from '../../../providers/provider-router.js';
import { getCcrShimPath } from '../../../claude/ccr-shim.js';
import { sanitizeError } from '../../../utils/sanitize.js';
import { getSessionKeyFromCtx } from '../../../utils/session-key.js';

// ── /btw ─────────────────────────────────────────────────────────

export async function handleBtw(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const text = ctx.message?.text || '';
  const question = text.replace(/^\/btw\s*/i, '').trim();

  if (!question) {
    await ctx.reply('Usage: /btw <your question>\n\nAsk a side question without interrupting the current task.');
    return;
  }

  await askBtw(ctx, sessionKey, question);
}

/**
 * Answer `question` alongside the running turn, without it reaching the main
 * conversation. Also what "Ask as /btw" on a queued message calls, with the
 * context of the tap rather than of a typed command.
 */
export async function askBtw(ctx: Context, sessionKey: string, question: string): Promise<void> {
  const session = sessionManager.getSession(sessionKey);
  if (!session?.claudeSessionId) {
    await ctx.reply(
      'No conversation to ask about yet. Send a message first, then /btw can answer alongside it.'
    );
    return;
  }

  const chatId = ctx.chat!.id;
  const headline = `💬 /btw — ${btwLabel(question)}`;

  // Labelled ack: this sits alongside the main turn's live status message, so
  // it has to be obvious which one belongs to the side question. It then
  // doubles as the progress line, and finally as a one-line receipt.
  const ack = await ctx.reply(`${headline}\nasking on the side… (main task keeps running)`);

  const progress = new BtwProgressLine(ctx, chatId, ack.message_id, headline);

  try {
    const result = await askForkedSideQuestion({
      question,
      sessionId: session.claudeSessionId,
      cwd: session.workingDirectory,
      // A CCR session's thinking blocks only replay through CCR.
      executable: getActiveProviderName(sessionKey) === 'ccr' ? getCcrShimPath() : undefined,
      onProgress: (p) => progress.update(p),
    });
    await progress.finish(result.toolCount ?? 0, result.elapsedMs ?? 0);

    if (!result.response) {
      await ctx.reply("I don't have enough context to answer that.");
      return;
    }
    await messageSender.sendMessage(ctx, formatSideAnswer(question, result.response));
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[btw] Fork error:', sanitizeError(error));
    await progress.fail();
    await ctx.reply(`Failed to answer side question: ${msg}`);
  }
}

/** Longest slice of the question echoed back in /btw labels. */
const BTW_LABEL_MAX = 80;

/**
 * One-line echo of the question, for labels that sit next to live turn output.
 * Formatting characters are dropped — the label is interpolated inside an
 * italic run, and a stray `_` or `*` would unbalance it and fail the parse.
 */
export function btwLabel(question: string): string {
  const flat = question.replace(/[_*`[\]]/g, '').replace(/\s+/g, ' ').trim();
  return flat.length > BTW_LABEL_MAX ? `${flat.slice(0, BTW_LABEL_MAX - 1)}…` : flat;
}

/**
 * A /btw answer lands in the middle of a running turn's output, so it has to
 * announce itself — otherwise it reads as something the main task said. The
 * echoed question also tells two concurrent side questions apart.
 */
export function formatSideAnswer(question: string, response: string): string {
  return `💬 **/btw** — _${btwLabel(question)}_\n\n${response}`;
}

/** Minimum gap between /btw progress edits — Telegram rate-limits edits hard. */
const BTW_EDIT_INTERVAL_MS = 2000;
/** How often the elapsed counter ticks while a single slow tool runs. */
const BTW_TICK_MS = 5000;

/**
 * Owns the single `/btw` message across its three lives: ack → live progress →
 * one-line receipt. Keeping it as one message is the point — a side question
 * shouldn't add a second log competing with the running turn's own output.
 */
class BtwProgressLine {
  private latest: SideQuestionProgress | null = null;
  private lastRendered = '';
  private lastEditAt = 0;
  private ticker: NodeJS.Timeout | null;
  private done = false;

  constructor(
    private readonly ctx: Context,
    private readonly chatId: number,
    private readonly messageId: number,
    private readonly headline: string,
  ) {
    // Repaint on a timer too, so elapsed keeps moving during a long tool call.
    this.ticker = setInterval(() => { void this.render(); }, BTW_TICK_MS);
  }

  update(p: SideQuestionProgress): void {
    this.latest = p;
    void this.render();
  }

  /** Collapse to a receipt: what the side question did, in one line. */
  async finish(toolCount: number, elapsedMs: number): Promise<void> {
    this.stop();
    const detail = toolCount > 0
      ? `${toolCount} ${toolCount === 1 ? 'tool' : 'tools'} · ${formatBtwElapsed(elapsedMs)}`
      : formatBtwElapsed(elapsedMs);
    await this.edit(`${this.headline} · ${detail}`);
  }

  async fail(): Promise<void> {
    this.stop();
    await this.edit(`${this.headline} · failed`);
  }

  private stop(): void {
    this.done = true;
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  private async render(): Promise<void> {
    if (this.done) return;
    const now = Date.now();
    if (now - this.lastEditAt < BTW_EDIT_INTERVAL_MS) return;

    const p = this.latest;
    const elapsed = formatBtwElapsed(p ? p.elapsedMs : 0);
    const activity = p?.currentTool
      ? `🔧 ${p.currentTool}${p.currentHint ? `: ${btwLabel(p.currentHint)}` : ''}`
      : 'thinking…';
    const counter = p && p.toolCount > 0
      ? ` · ${p.toolCount} ${p.toolCount === 1 ? 'tool' : 'tools'} · ${elapsed}`
      : ` · ${elapsed}`;

    await this.edit(`${this.headline}\n${activity}${counter}`);
  }

  private async edit(text: string): Promise<void> {
    // Telegram rejects an edit that changes nothing, so skip those outright.
    if (text === this.lastRendered) return;
    this.lastEditAt = Date.now();
    this.lastRendered = text;
    try {
      await this.ctx.api.editMessageText(this.chatId, this.messageId, text);
    } catch (err) {
      console.debug('[btw] progress edit failed:', err instanceof Error ? err.message : err);
    }
  }
}

function formatBtwElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}
