/**
 * Pure display formatters for user-facing numbers.
 *
 * These live in `utils/` rather than next to their first caller because both
 * the bot handler layer and the provider layer need them, and the providers
 * cannot import from the handlers — the handlers import the providers back.
 * `pty-provider.ts` used to keep its own copy of `fmtTokens` for exactly that
 * reason; a leaf module with no imports of its own removes the cycle instead
 * of working around it.
 */

/** Compact token count for user-facing messages: `999`, `12.5k`, `1.2M`. */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

/** Ten-cell context-usage bar, colour-coded green / amber / red at 60% and 80%. */
export function getProgressBar(pct: number): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round(clamped / 10);
  const empty = 10 - filled;
  const color = clamped >= 80 ? '🔴' : clamped >= 60 ? '🟡' : '🟢';
  return color + ' [' + '█'.repeat(filled) + '░'.repeat(empty) + ']';
}

/**
 * One-line manual `/compact` confirmation with the token reduction.
 *
 * Shared by both providers: the PTY provider reads the numbers back out of the
 * session JSONL, the SDK provider gets them on the `compact_boundary` message.
 * Same command, same wording, whichever transport ran it.
 */
export function formatCompactionConfirmation(c: { preTokens: number; postTokens?: number }): string {
  const before = fmtTokens(c.preTokens);
  // postTokens is absent on older Claude Code builds — omit the arrow then.
  return c.postTokens && c.postTokens > 0
    ? `🗜️ Context compacted — ${before} → ${fmtTokens(c.postTokens)} tokens.`
    : `🗜️ Context compacted — was ${before} tokens.`;
}
