/**
 * Reading a blocking dialog off Claude Code's TUI.
 *
 * A pty has no one at the keyboard, so every dialog claude opens is a dead
 * end: the input box is gone, the prompt we paste is swallowed by a list that
 * ignores it, and whatever we press next lands on whichever option happens to
 * be highlighted. The bot's answer is to put the dialog in the chat and let a
 * person tap — which needs the dialog read off the screen first.
 *
 * What follows is a parser for the two shapes claude actually draws, measured
 * against a live 120x40 pty:
 *
 *   ❯ /model                          ← the command that opened it, scrolled up
 *   ──────────────────────────────    ← the seam between transcript and body
 *     Select model                    ← title
 *     Switch between Claude models…   ← blurb
 *     ❯ 1. Default (recommended) ✔    ← options, the glyph marking the cursor
 *       2. Opus (1M context)
 *     Enter to set as default · s to use this session only · Esc to cancel
 *
 * the same list without the numbers, which is how the trust dialog draws its
 * `No, exit` / `Yes, I trust this folder`, and dialogs with no list at all
 * (`/tasks`, `/config`) where the footer's key hints are the only affordances
 * there are.
 *
 * The footer is parsed rather than assumed, because the keys do not mean the
 * same thing twice. `/model` closes on Esc; `/tasks` closes on Esc; `/config`
 * reads `Esc to clear`, where Esc empties the filter box and leaves the dialog
 * open — pressing it there on the belief that Esc always cancels is how a
 * probe session silently turned off auto-compact. Offer what the dialog says
 * it offers, and nothing else.
 */

/** One selectable row of a numbered dialog. */
export interface ModalOption {
  /** The number claude printed, when it numbered its rows at all. */
  number?: number;
  /** The row's text, glyph and number stripped. */
  label: string;
  /** Index into {@link TuiModal.options} — the arrow-key distance travels this. */
  index: number;
}

/** One `<key> to <action>` affordance from the footer. */
export interface ModalKeyHint {
  /** The literal key, as claude names it: `Enter`, `Esc`, `s`, … */
  key: string;
  /** What claude says it does: `cancel`, `use this session only`, … */
  action: string;
}

export interface TuiModal {
  /** The dialog's heading, or the first body line when it has no heading. */
  title: string;
  /** Numbered rows, empty for a dialog that offers none. */
  options: ModalOption[];
  /** Index of the row the cursor sits on, or -1 when nothing is marked. */
  highlighted: number;
  /** Affordances parsed from the footer, in the order claude listed them. */
  hints: ModalKeyHint[];
  /** The body as rendered, for relaying a dialog we could not fully parse. */
  body: string;
}

/** The seam rule between the transcript and a dialog's body. */
const RULE = /^\s*─{10,}\s*$/u;
/**
 * The cursor's row: indent, the glyph, a gap, then the label. The capture
 * groups give the column its label starts at, which is what finds the rows
 * beside it.
 */
const CURSOR_ROW = /^(\s*)❯(\s+)(\S.*)$/u;
/** A leading `1. `, when the dialog numbers its rows. Many do not. */
const ROW_NUMBER = /^(\d{1,2})\.\s+(\S.*)$/u;
/**
 * A footer hint. Claude writes these as `Enter to confirm`, `Esc to cancel`,
 * `↑/↓ to select`, `s to use this session only` — a key, the word "to", and a
 * verb phrase. Keys are matched narrowly so a sentence in the body that
 * happens to contain " to " cannot pose as one.
 */
const KEY_HINT = /^(Enter(?:\/[^\s]+)?|Esc|Tab|Space|[a-z]|↑\/↓|←\/→|\/)\s+to\s+(.+)$/u;
/** How far up from the footer a dialog's body can reach. */
const MAX_BODY_ROWS = 30;
/**
 * Longest option label we keep. Telegram caps a button at 64 bytes and the
 * ask-user contract at 60 chars; claude pads its rows out to the full 120
 * columns with a trailing description, so most need clipping.
 */
const MAX_LABEL = 48;

function bodyLines(screenText: string): string[] {
  return screenText.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim()).slice(-MAX_BODY_ROWS);
}

function clip(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  // trimEnd after slicing: a cut that lands on a space would otherwise render
  // the gap before the ellipsis, which reads as a missing word.
  return collapsed.length > max ? `${collapsed.slice(0, max - 1).trimEnd()}…` : collapsed;
}

/**
 * Split the footer into its hints. Returns [] for a line that is prose rather
 * than chrome, which is what keeps a dialog we cannot drive from being offered
 * buttons that do nothing.
 */
export function parseKeyHints(footer: string): ModalKeyHint[] {
  const hints: ModalKeyHint[] = [];
  for (const part of footer.split('·')) {
    const match = KEY_HINT.exec(part.trim());
    if (match) hints.push({ key: match[1], action: clip(match[2], 40) });
  }
  return hints;
}

/**
 * Read the dialog covering the input box, or null when the screen holds none.
 *
 * The caller is expected to have established that the input box is absent
 * ({@link hasInputBox}); this only answers what is there instead. A null here
 * with no input box means a screen we cannot drive — mid-render, or a dialog
 * shaped in a way this parser does not know — and the caller should relay it
 * verbatim rather than press anything.
 */
export function parseModal(screenText: string): TuiModal | null {
  const lines = bodyLines(screenText);
  if (lines.length === 0) return null;

  const hints = parseKeyHints(lines[lines.length - 1]);
  if (hints.length === 0) return null;

  // Body starts below the seam rule when there is one; a dialog that redrew
  // the whole screen has no seam, and everything we kept is its body.
  let seam = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (RULE.test(lines[i])) { seam = i; break; }
  }
  const body = lines.slice(seam + 1, -1);
  if (body.length === 0) return null;

  const { options, highlighted, rows } = extractOptions(body);
  // A cursor we could not resolve into rows is the one state that must not
  // produce buttons. The footer's `Enter to confirm` would then be the only
  // thing on offer, and Enter commits whatever the cursor is on — which is
  // exactly how the trust dialog, whose default row is `No, exit`, got
  // answered with an exit. Better to relay the screen and press nothing.
  if (options.length === 0 && body.some((l) => l.includes('❯'))) return null;

  // The title is the first body row that isn't an option — dialogs lead with
  // their heading, and one that opens straight onto its list has none.
  const title = body.find((_, i) => !rows.has(i));

  return {
    title: title ? clip(title, 120) : clip(body[0], 120),
    options,
    highlighted,
    hints,
    body: body.join('\n'),
  };
}

/** True when `line`'s text begins exactly at `col`, with only blanks before. */
function startsAt(line: string, col: number): boolean {
  return line.length > col && line[col] !== ' ' && line.slice(0, col).trim() === '';
}

/**
 * The dialog's selectable rows, found from the cursor outwards.
 *
 * Claude does not number them consistently — `/model` draws `❯ 1. Default`,
 * the trust dialog draws a bare `❯ No, exit` — so a pattern keyed on the
 * number misses the dialogs that matter most. What every list does share is
 * layout: the rows are the run of lines whose text starts in the same column
 * as the cursor's own label, and nothing else on the screen lines up there.
 * Walking out from the cursor until that alignment breaks picks up the rows
 * and stops at the blurb above and the footer below.
 */
function extractOptions(
  body: string[],
): { options: ModalOption[]; highlighted: number; rows: Set<number> } {
  const none = { options: [], highlighted: -1, rows: new Set<number>() };

  const cursor = body.findIndex((l) => CURSOR_ROW.test(l));
  if (cursor < 0) return none;
  const match = CURSOR_ROW.exec(body[cursor])!;
  const labelCol = match[1].length + 1 + match[2].length;

  let first = cursor;
  while (first > 0 && startsAt(body[first - 1], labelCol)) first--;
  let last = cursor;
  while (last < body.length - 1 && startsAt(body[last + 1], labelCol)) last++;

  const options: ModalOption[] = [];
  const rows = new Set<number>();
  for (let i = first; i <= last; i++) {
    rows.add(i);
    const text = i === cursor ? match[3] : body[i].slice(labelCol);
    const numbered = ROW_NUMBER.exec(text);
    options.push({
      ...(numbered ? { number: Number(numbered[1]) } : {}),
      label: clip(numbered ? numbered[2] : text, MAX_LABEL),
      index: options.length,
    });
  }
  return { options, highlighted: cursor - first, rows };
}

/**
 * The keystrokes that answer `modal` with the option at `index`.
 *
 * Arrow keys rather than the row's digit: not every dialog numbers its rows,
 * and the ones that do don't all take the number as a hotkey, whereas ↑/↓ move
 * the cursor in all of them. Moving is also checkable — the caller re-reads the
 * screen and confirms the glyph landed on the intended row before committing —
 * where a digit is a blind press.
 *
 * Returns null when the cursor's position is unknown, since every step from an
 * unknown start is a guess.
 */
export function arrowsTo(modal: TuiModal, index: number): string[] | null {
  if (modal.highlighted < 0) return null;
  if (index < 0 || index >= modal.options.length) return null;
  const distance = index - modal.highlighted;
  return Array.from({ length: Math.abs(distance) }, () => (distance > 0 ? '\x1b[B' : '\x1b[A'));
}

/** The byte a footer hint's key sends. Null for keys we cannot synthesise. */
export function keystrokeFor(key: string): string | null {
  if (/^Enter/.test(key)) return '\r';
  if (key === 'Esc') return '\x1b';
  if (key === 'Tab') return '\t';
  if (key === 'Space') return ' ';
  if (/^[a-z]$/.test(key)) return key;
  // ↑/↓, ←/→ and / are navigation or search affordances, not answers.
  return null;
}
