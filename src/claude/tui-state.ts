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

function tailLines(screenText: string, rows: number): string[] {
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
 * `❯` appears in claude's input box. We use includes() rather than
 * startsWith() because the box-drawing chrome wraps the line as
 * `│ ❯ <typed text> │`, which trims to a string that doesn't *start* with ❯.
 * claude's own assistant output uses ● for bullets, not ❯, so false positives
 * are unlikely.
 */
export function isPromptVisible(screenText: string): boolean {
  return screenText.includes('❯');
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
