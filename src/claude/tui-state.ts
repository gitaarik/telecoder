/**
 * Reading Claude Code's state off the rendered TUI.
 *
 * Two guards in the pty provider need to know whether claude is mid-turn: the
 * readiness wait that decides when a prompt can be submitted, and the idle
 * fallback that decides a turn has ended. Both inferred it from the pty going
 * quiet, and quiet doesn't carry that meaning in either direction. Measured
 * against a live 120x40 pty: a running turn redraws several times a second —
 * the longest silence inside a 27-second turn was 0.3s — so a readiness rule
 * that waits for three seconds of quiet can only ever time out on a session
 * that is working, however long it works. Once the turn ends that same screen
 * sits silent for tens of seconds, which is the only reason silence looks
 * like a signal at all. The input glyph separates nothing: claude draws `❯`
 * throughout a turn, because you can type at it while the model works.
 *
 * What does track generation is the footer hint. The TUI offers `esc to
 * interrupt` exactly while there is a generation to interrupt and drops it
 * the moment the turn ends; the live spinner (`✶ Percolating… (29s)`) carries
 * the same meaning while it's on screen. Both are read from the bottom of the
 * buffer, where the TUI's own chrome lives — a scan of the whole screen would
 * take an assistant message that merely quotes the phrase as proof that
 * claude is still working.
 */

/** Rows from the bottom that hold the TUI's chrome rather than transcript. */
const FOOTER_ROWS = 5;
/** Rows to search for the spinner, which sits above the input box. */
const SPINNER_ROWS = 12;

/** The footer's interrupt hint, offered only while a generation is running. */
const INTERRUPT_HINT = /esc to interrupt/i;
/**
 * The live spinner: a glyph, a gerund, and a running timer. The completed
 * turn's summary (`✻ Brewed for 3m 5s`) is deliberately not matched — it has
 * no ellipsis and stays on screen long after the turn ends.
 */
const LIVE_SPINNER = /[✶✳✻✽✢·]\s+\S+…\s*\(\d+\s*s/u;
/** Claude's own output bullet, so a quoted hint isn't read as chrome. */
const ASSISTANT_BULLET = /^\s*●/u;

export function tailLines(screenText: string, rows: number): string[] {
  return screenText.split('\n').filter((line) => line.trim()).slice(-rows);
}

/**
 * Is claude generating right now?
 *
 * True while a turn is in flight, false once it ends — including while a tool
 * the model backgrounded keeps running, which the TUI accepts input during.
 */
export function isGenerating(screenText: string): boolean {
  const footer = tailLines(screenText, FOOTER_ROWS)
    .filter((line) => !ASSISTANT_BULLET.test(line));
  if (footer.some((line) => INTERRUPT_HINT.test(line))) return true;
  return tailLines(screenText, SPINNER_ROWS).some((line) => LIVE_SPINNER.test(line));
}

/**
 * The screen reduced to what changing actually means something.
 *
 * A TUI still coming up rewrites whole rows; one sitting at the prompt rewrites
 * nothing. Between those two is the spinner, which ticks its timer once a
 * second forever — comparing raw screens would read that as a session that
 * never settles, which is the mistake byte-silence already makes. Dropping the
 * spinner's own row is enough: it is the only element that redraws on a clock.
 */
export function screenSignature(screenText: string): string {
  return screenText
    .split('\n')
    .filter((line) => !LIVE_SPINNER.test(line))
    .map((line) => line.trimEnd())
    .join('\n');
}

/**
 * A full-width horizontal rule: the input box's top and bottom border.
 * Ten is well below the 120-column render but far above anything that shows
 * up inside prose, so a model quoting `──` in a reply can't forge a border.
 */
const RULE = /^\s*─{10,}\s*$/u;
/**
 * The input box's own row. The glyph may sit inside side borders on terminals
 * that draw them (`│ ❯ typed text │`), which is a shape only the input box
 * has — no overlay draws vertical borders — so it stands on its own below.
 */
const INPUT_ROW = /^\s*(?:│\s*)?❯/u;
const SIDE_BORDERED_INPUT = /│\s*❯/u;
/** Rows from the bottom that can hold the input box and its footer. */
const INPUT_BOX_ROWS = 10;

/**
 * Is claude's input box open, as opposed to an overlay covering it?
 *
 * The distinction a bare search for `❯` cannot draw, which is what this
 * replaced. Claude's select lists mark the highlighted option with the same
 * glyph the input box uses:
 *
 *     Select model
 *     ❯ 1. Default (recommended) ✔  Opus 5 with 1M context
 *       2. Opus (1M context)        …
 *     Enter to set as default · s to use this session only · Esc to cancel
 *
 * so a bare `includes('❯')` reads a modal as a prompt. That screen is also
 * perfectly still and draws no interrupt hint, which means every other
 * readiness signal agrees — and the prompt then gets pasted into a list that
 * ignores it, with the Enter after it landing on whichever option happens to
 * be highlighted. Measured against a live pty, that is enough to change a
 * setting: pasting into `/model` and pressing Enter answered the dialog.
 *
 * What separates them is structure, not the glyph. The input box is a `❯` row
 * fenced by two rules; an overlay draws at most one rule, as the seam between
 * the transcript above it and its own body. Both are read from the bottom of
 * the buffer, where the box lives — an option list long enough to scroll would
 * otherwise offer its own `❯` row somewhere in the middle of the screen.
 */
export function hasInputBox(screenText: string): boolean {
  const lines = tailLines(screenText, INPUT_BOX_ROWS);
  return lines.some((line, i) =>
    SIDE_BORDERED_INPUT.test(line)
    || (INPUT_ROW.test(line) && RULE.test(lines[i - 1] ?? '') && RULE.test(lines[i + 1] ?? '')));
}

/**
 * Claude Code's collapsed-paste placeholder.
 *
 * Its editor does not draw a pasted block that runs past 800 characters or two
 * newlines. It mints an id for the block, keeps the text off-screen, and
 * renders `[Pasted text #3 +10 lines]` in its place — `[Pasted text #3]` when
 * the block has no newlines at all. The full text is restored on submit, so
 * this costs delivery nothing, but it means anything checking the screen for a
 * prompt's own words has to recognise the placeholder instead: every prompt we
 * build from a template (an upload note, a staged image list) clears both
 * thresholds and is therefore never on screen literally.
 */
const PASTE_PLACEHOLDER = /\[Pasted text #(\d+)(?: \+(\d+) lines)?\]/g;

export interface PastePlaceholder {
  /** The paste's id. Claude mints these in increasing order within a session. */
  id: number;
  /** Newlines in the pasted block, as claude counted them; 0 when it drew none. */
  lines: number;
}

/**
 * Every collapsed paste anywhere on the rendered screen, scrollback included.
 *
 * Submitting expands a placeholder back to the text it stood for, so a live
 * one marks a paste still held in the editor. Stale ones linger all the same:
 * the box redraws in place, and the frames it scrolls off the top keep
 * whatever they were showing at the time. Ids are minted in increasing order
 * within a session, which is what lets a caller tell a paste its own write
 * just made from one an earlier turn left behind.
 */
export function pastePlaceholders(screenText: string): PastePlaceholder[] {
  return [...screenText.matchAll(PASTE_PLACEHOLDER)].map((match) => ({
    id: Number(match[1]),
    lines: Number(match[2] ?? 0),
  }));
}

/**
 * The ids of every paste placeholder already drawn — the "before" half of the
 * only reliable proof that a write landed.
 */
export function pastePlaceholderIds(screenText: string): Set<number> {
  return new Set(pastePlaceholders(screenText).map((p) => p.id));
}

/**
 * The first placeholder on screen that `known` has not seen. Identity is the
 * id and nothing else: claude rewrites a paste before drawing it — an image
 * path becomes an `[Image #N]` chip and leaves the text shorter — so the
 * `+N lines` it reports is not the line count of what we wrote and must never
 * be matched against it.
 */
export function newPastePlaceholder(
  known: Set<number>,
  screenText: string,
): PastePlaceholder | undefined {
  return pastePlaceholders(screenText).find((p) => !known.has(p.id));
}

/**
 * The live input box's text: everything from its `❯` row down.
 *
 * The only part of the screen where a prompt of ours can still be waiting, and
 * so the only part worth searching for one. Everything above it is transcript,
 * which holds our own prompts too — claude redraws a prompt into the transcript
 * once it submits, and the frames the box scrolls off keep whatever they were
 * showing at the time — so a whole-screen search answers a different question
 * than the one the callers here are asking.
 *
 * Anchored on the box's own `❯` row rather than a count of rows from the
 * bottom, and on the last such row rather than the first: claude draws a
 * submitted prompt on a `❯` row too, so the transcript offers rows of the same
 * shape above the real one. Everything from that row down is in scope, because
 * an input long enough to wrap spills onto the rows beneath it.
 *
 * The glyph alone does not make a row the box's, for the reason hasInputBox
 * gives above: a select list marks its highlighted option with the same `❯`,
 * and reading one as an editor is how a prompt ends up pasted into `/model`
 * with an Enter behind it. So the row has to carry the box's structure too —
 * the top rule right above it, or the side borders terminals that draw them
 * use. Only the opening rule is required, not the closing one, because a
 * wrapped input pushes that several rows down.
 *
 * Undefined when no box is drawn at all — an overlay has replaced it, or the
 * TUI is still starting. That is not the same answer as an empty box, and a
 * caller about to send a keystroke needs to tell them apart.
 */
export function inputBoxText(screenText: string): string | undefined {
  const lines = tailLines(screenText, INPUT_BOX_ROWS);
  let inputRow = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (SIDE_BORDERED_INPUT.test(line)
      || (INPUT_ROW.test(line) && RULE.test(lines[i - 1] ?? ''))) inputRow = i;
  }
  if (inputRow === -1) return undefined;
  return lines.slice(inputRow).join('\n');
}

/**
 * Collapsed pastes sitting in the input box right now, as opposed to anywhere
 * on the screen. This is the reader for "did Enter take?", where the whole-
 * screen one gets the answer wrong: the box's earlier frames survive in the
 * scrollback, so a prompt that submitted cleanly still has its old placeholder
 * up there, and scanning for it never stops finding one.
 */
export function inputBoxPastePlaceholders(screenText: string): PastePlaceholder[] {
  return pastePlaceholders(inputBoxText(screenText) ?? '');
}
