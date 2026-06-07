/**
 * Scrape Claude Code's spinner "Tip:" line from the rendered xterm buffer.
 *
 * While a turn is running, Claude Code draws a status block at the bottom of
 * the TUI that occasionally carries a contextual tip, e.g.:
 *
 *     ✶ Percolating… (29s)
 *       ⎿  Tip: Working with HTML/CSS? Install the frontend-design plugin:
 *          /plugin install frontend-design@claude-plugins-official
 *
 * These tips are bundled into the CLI (with client-side relevance + per-session
 * cooldown logic) and never surface through the SDK event stream — they exist
 * only in the live render. In PTY mode we already feed that render into an
 * @xterm/headless buffer, so we can pull the tip back out and mirror it in the
 * Telegram status indicator, exactly as Claude Code shows it.
 *
 * Detection: the spinner tip is rendered with a `⎿` tree connector preceding
 * `Tip:`. That connector is the discriminator that distinguishes it from the
 * startup "Update available" banner tip (which has no connector and lives in
 * scrollback, not the live bottom rows). The tip can wrap onto a continuation
 * line (the `/plugin install …` command), indented to align under `Tip: `.
 *
 * We scan the buffer bottom-up and return the lowest (most recent) match. The
 * `⎿` connector is what makes this safe: the spinner block is redrawn in place
 * and overwritten by committed output rather than scrolled into history, so a
 * connector-prefixed tip only ever exists in the live block — there's no stale
 * copy in scrollback to mismatch. (A fixed bottom-window scan can't be used: in
 * an early session the live block sits near the top with empty viewport rows
 * below it, pushing it outside any fixed window.)
 */

import type headless from '@xterm/headless';

// Tip line signature: a `⎿` tree connector followed by `Tip:`.
const TIP_RE = /⎿\s*Tip:\s*(.+)$/u;
const MAX_TIP_LEN = 220;

function isContinuation(line: string): boolean {
  if (!line) return false;
  const trimmed = line.trim();
  if (!trimmed) return false;
  // Stop at TUI chrome: input-box borders/body, prompt glyph, another tree
  // connector, separators, or the spinner status line itself.
  if (/^[╭╰╮╯│─━═⎿●]/u.test(trimmed)) return false;
  if (trimmed.includes('❯')) return false;
  // A continuation is indented under "Tip: " — bail if the raw line isn't.
  return /^\s/u.test(line);
}

/**
 * Return the spinner tip currently rendered (tip text plus any wrapped
 * continuation, joined with a space), or null when none is on screen.
 */
export function scrapeTip(xterm: headless.Terminal): string | null {
  const buf = xterm.buffer.active;

  for (let i = buf.length - 1; i >= 0; i--) {
    const line = buf.getLine(i);
    if (!line) continue;
    const raw = line.translateToString(true);
    const m = TIP_RE.exec(raw);
    if (!m) continue;

    let tip = m[1].trim();
    // Pull in wrapped continuation lines (e.g. the `/plugin install …` command).
    for (let j = i + 1; j < buf.length && j <= i + 3; j++) {
      const contRaw = buf.getLine(j)?.translateToString(true) ?? '';
      if (!isContinuation(contRaw)) break;
      tip += ' ' + contRaw.trim();
    }

    tip = tip.replace(/\s+/gu, ' ').trim();
    if (!tip) return null;
    return tip.length > MAX_TIP_LEN ? tip.slice(0, MAX_TIP_LEN - 1).trimEnd() + '…' : tip;
  }
  return null;
}
