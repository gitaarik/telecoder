/**
 * Pure display formatters for user-facing numbers and times.
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

/**
 * Ten-cell usage bar, colour-coded green / amber / red at 60% and 80%. Pass
 * `color` to colour it by something other than the fill, as the context bar
 * does with `contextHealthColor`.
 */
export function getProgressBar(pct: number, color?: string): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round(clamped / 10);
  const empty = 10 - filled;
  const shade = color ?? (clamped >= 80 ? '🔴' : clamped >= 60 ? '🟡' : '🟢');
  return shade + ' [' + '█'.repeat(filled) + '░'.repeat(empty) + ']';
}

/** Context size from which answers get slower, costlier and less sharp. */
export const CONTEXT_WARN_TOKENS = 150_000;
/** Context size from which it's time to /clear, fork or /compact. */
export const CONTEXT_HIGH_TOKENS = 300_000;

/**
 * How healthy a context of `used` tokens is, as 🟢 / 🟡 / 🔴.
 *
 * The share of the window alone doesn't say it: with the 1M window a context
 * at 30% is already 300k tokens, where every turn costs more and recall gets
 * patchier, long before auto-compact would step in. So whichever comes first
 * counts — the absolute size, or 60% / 80% of the window.
 */
export function contextHealthColor(used: number, contextWindow: number): '🟢' | '🟡' | '🔴' {
  const pct = contextWindow > 0 ? (used / contextWindow) * 100 : 0;
  if (used >= CONTEXT_HIGH_TOKENS || pct >= 80) return '🔴';
  if (used >= CONTEXT_WARN_TOKENS || pct >= 60) return '🟡';
  return '🟢';
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
