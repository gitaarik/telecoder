/**
 * Scrape the Session totals out of Claude Code's `/cost` overlay.
 *
 * `/cost` in the TUI is not a transcript message — it opens the settings panel
 * on its Usage tab, behind the same full-width `▔` rule the `/tasks` overlay
 * uses:
 *
 *     ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔
 *        Settings  Status   Config   Usage   Stats
 *
 *        Session
 *
 *        Total cost:            $0.0246
 *        Total duration (API):  3s
 *        Total duration (wall): 8s
 *        Total code changes:    0 lines added, 0 lines removed
 *        Usage by model:
 *            claude-haiku-4-5:  1.8k input, 63 output, 26.3k cache read …
 *        Prompt cache (main):   1 request · 73% of input tokens from cache …
 *
 *        Current session
 *        █████████                        18% used
 *        …
 *
 * Only the Session block is taken. Everything below it is the account-wide
 * limits view, which `claude -p /cost` prints too — more compactly, and from
 * any mode — so /cost reads that from the probe and comes here only for the
 * part a probe can never have: the totals belong to the process that spent
 * them, and a freshly spawned one has spent nothing.
 *
 * The panel scrolls, so only its first screenful is rendered. That is where
 * the Session block lives, which is why this scrapes it and leaves the rest.
 */

/** The overlay's top rule. Full-width in practice; 10 is a safe floor. */
const OVERLAY_RULE_RE = /^▔{10,}$/;

/** The block's heading, on its own line. */
const SESSION_HEADING_RE = /^Session$/;

/**
 * `Total cost:  $0.0246`, and the per-model rows, which have the same shape.
 * The label is deliberately narrow — letters, digits and the few punctuation
 * marks real labels use — so that a wrapped continuation line ("35m, next turn
 * re-caches ~426.3k tokens") can't be mistaken for the start of a new field.
 */
const FIELD_RE = /^([A-Za-z][\w .()/-]*?):\s*(.*)$/;

/**
 * Where the Session block ends and the account-wide limits view begins. The
 * panel always renders one of these next, so this doubles as the block's
 * terminator when the screen is tall enough to show more.
 */
const BLOCK_END_RE = /^(?:Current session|Current week|What's contributing)/i;

/**
 * How far below the rule the `Session` heading may sit. The real layout puts
 * it on the fourth line (rule, tab bar, blank, heading); the allowance is for
 * a release that adds a line, not for finding the word somewhere in
 * scrollback. Without a ceiling, a stale overlay left in the buffer could pass
 * off last hour's numbers as this moment's.
 */
const HEADING_SEARCH_LINES = 8;

export interface CostSessionRow {
  /** Field name with its colon stripped — `Total cost`, `Prompt cache (main)`. */
  label: string;
  /** Everything after the colon, with any wrapped continuation joined back on. */
  value: string;
  /** True for the per-model rows indented under `Usage by model:`. */
  nested: boolean;
}

export interface CostSession {
  rows: CostSessionRow[];
}

/** Leading spaces on a line; 0 for a blank one. */
function indentOf(line: string): number {
  return line.trim() === '' ? 0 : line.length - line.trimStart().length;
}

/**
 * The Session block of the `/cost` overlay, or null when the screen doesn't
 * hold one — no overlay, a different tab, or a layout we no longer recognise.
 * Callers show the limits view alone rather than guessing at the numbers.
 */
export function scrapeCostSession(screenText: string): CostSession | null {
  const lines = screenText.split('\n');

  // Bottom-up: the panel is pinned to the bottom of the screen, and an earlier
  // rule can survive in scrollback from a previous overlay.
  let ruleIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (OVERLAY_RULE_RE.test(lines[i].trim())) {
      ruleIndex = i;
      break;
    }
  }
  if (ruleIndex === -1) return null;

  const limit = Math.min(lines.length, ruleIndex + 1 + HEADING_SEARCH_LINES);
  let headingIndex = -1;
  for (let i = ruleIndex + 1; i < limit; i++) {
    if (SESSION_HEADING_RE.test(lines[i].trim())) {
      headingIndex = i;
      break;
    }
  }
  if (headingIndex === -1) return null;

  const body: string[] = [];
  for (let i = headingIndex + 1; i < lines.length; i++) {
    if (BLOCK_END_RE.test(lines[i].trim())) break;
    body.push(lines[i]);
  }

  // The heading sets the block's baseline indent; the per-model rows sit four
  // columns further in. Two is the smallest gap that can't be indent jitter.
  const baseline = indentOf(lines[headingIndex]);
  const nestedFrom = baseline + 2;

  const rows: CostSessionRow[] = [];
  for (const line of body) {
    const text = line.trim();
    if (!text) continue;

    const field = text.match(FIELD_RE);
    if (field) {
      rows.push({
        label: field[1],
        value: field[2].trim(),
        nested: indentOf(line) >= nestedFrom,
      });
      continue;
    }

    // No label, so this is the tail of a value the panel wrapped. Rejoin it —
    // the prompt-cache line is long enough to wrap on most terminals, and
    // dropping the remainder would truncate it mid-sentence.
    const previous = rows[rows.length - 1];
    if (previous) previous.value = `${previous.value} ${text}`.trim();
  }

  // A panel showing no dollar or duration total isn't the Usage tab, whatever
  // else matched. Better to fall back to the limits view than to relay rows
  // scraped out of something else.
  if (!rows.some((row) => /^Total /.test(row.label))) return null;

  return { rows };
}
