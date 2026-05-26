/**
 * Scrape Claude Code's "prompt suggestion" ghost text from the rendered
 * xterm buffer.
 *
 * When `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=1` is set at spawn time (and
 * Anthropic's growthbook flag for it is on for the account), Claude Code
 * generates a speculative next-prompt after each turn and renders it as
 * ghost text inside the input box. The user would press Tab to accept; we
 * scrape it and offer it as an inline button instead.
 *
 * Detection approach:
 *   The live input box always renders as three consecutive rows:
 *     ─────────────── (top border, U+2500 run)
 *     ❯ <content>     (prompt row, may be empty / have a suggestion)
 *     ─────────────── (bottom border)
 *   Walking bottom-up for that signature uniquely identifies the live box
 *   (vs. earlier `❯ ` rows belonging to submitted prompts that have
 *   scrolled into the conversation history).
 *
 *   Within the prompt row, anything past col 2 is either user-typed input,
 *   the suggestion ghost text, or claude's deterministic placeholder
 *   ("Try \"how does X work?\""). We rely on the fact that we just finished
 *   a turn (so the user hasn't typed anything yet) and filter out the
 *   placeholder by prefix.
 *
 *   Styling-based detection (dim/inverse flags) was tried first but proved
 *   unreliable — the flags are present at the moment the suggestion is
 *   written but can be cleared by subsequent attribute resets before the
 *   scrape window.
 */

import type headless from '@xterm/headless';

const PLACEHOLDER_PREFIXES = ['Try '] as const;
// U+2500 BOX DRAWINGS LIGHT HORIZONTAL — Claude Code uses this run for the
// input box top/bottom borders.
const BORDER_CHAR = '─';

function isBorderRow(line: headless.IBufferLine): boolean {
  // The border is a long run of U+2500; check the first ~10 cells.
  for (let c = 0; c < Math.min(10, line.length); c++) {
    const cell = line.getCell(c);
    if (!cell) return false;
    if (cell.getChars() !== BORDER_CHAR) return false;
  }
  return true;
}

function readPromptRowText(line: headless.IBufferLine): string {
  let text = '';
  for (let c = 2; c < line.length; c++) {
    const cell = line.getCell(c);
    if (!cell) break;
    const ch = cell.getChars();
    text += ch === '' || ch == null ? ' ' : ch;
  }
  return text.replace(/\s+$/u, '');
}

/**
 * Return the ghost-text prompt suggestion currently rendered in the input
 * box, or null when none is present (input is empty, user is mid-typing, or
 * what's shown is the deterministic placeholder).
 */
export function scrapePromptSuggestion(xterm: headless.Terminal): string | null {
  const buf = xterm.buffer.active;
  for (let i = buf.length - 1; i >= 1; i--) {
    const line = buf.getLine(i);
    if (!line) continue;
    const cell0 = line.getCell(0);
    if (!cell0 || cell0.getChars() !== '❯') continue;

    // The live input box sits between two U+2500 border rows. Earlier `❯ `
    // rows in the conversation history (submitted prompts) won't satisfy
    // this — they're bare lines with no surrounding borders.
    const above = buf.getLine(i - 1);
    const below = buf.getLine(i + 1);
    if (!above || !below) continue;
    if (!isBorderRow(above) || !isBorderRow(below)) continue;

    const text = readPromptRowText(line);
    if (!text) return null;
    if (PLACEHOLDER_PREFIXES.some((p) => text.startsWith(p))) return null;
    return text;
  }
  return null;
}
