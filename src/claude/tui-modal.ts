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
 * there are. WebFetch's permission prompt is the odd one out the other way: a
 * numbered list and no footer at all, so there the list has to mark where the
 * dialog ends ({@link findListEnd}).
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
  /** The row's text, glyph and number stripped, clipped to fit a button. */
  label: string;
  /** The row's text in full, for the message body — the button clips it. */
  text: string;
  /**
   * What the dialog says about the row, when it says anything: the column
   * `/model` prints beside it, or the sentence auto hangs underneath it.
   */
  detail?: string;
  /** Index into {@link TuiModal.options} — the arrow-key distance travels this. */
  index: number;
}

/**
 * One stretch of a dialog's body, read for showing in a chat rather than for
 * pressing. The screen's layout does not survive the trip on its own: a phone
 * rewraps every line of it, and in a proportional font the indentation that
 * tells a command from the prose around it means nothing.
 */
export type ModalPart =
  /** Prose, with claude's wraps at the terminal edge undone — each line is a real break. */
  | { kind: 'text'; lines: string[]; gapBefore: boolean }
  /**
   * Drawn content, exactly as drawn: the command in its `│` gutter, the diff
   * between an edit's dashed fences. Rewrapping either would change what it says.
   */
  | { kind: 'verbatim'; lines: string[]; gapBefore: boolean }
  /** Where the selectable rows sit. Their text is on {@link TuiModal.options}. */
  | { kind: 'options'; gapBefore: boolean };

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
  /** The body read into prose, drawn blocks and the option list, in screen order. */
  parts: ModalPart[];
}

/** The seam rule between the transcript and a dialog's body. */
const RULE = /^\s*─{10,}\s*$/u;
/**
 * The dashed rules an edit prompt draws above and below its diff. What sits
 * between a pair is file content, and is shown exactly as drawn.
 */
const FENCE = /^\s*╌{10,}\s*$/u;
/** A row in claude's quote gutter — how a Bash prompt draws its command. */
const GUTTER = /^\s*│ ?(.*)$/u;
/**
 * How far short of the terminal's edge claude's prose wraps. Dialogs are
 * padded, so a row breaks a column or two early: `/model`'s blurb broke at a
 * row its next word would only have taken to column 119 of 120.
 */
const WRAP_SLACK = 4;
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
 * How many lines of chrome may sit *below* the footer.
 *
 * The footer is not reliably the last thing on screen. Claude draws its status
 * bar under a dialog — `⏵⏵ bypass permissions on (shift+tab to cycle)` — and
 * adds notices there too, and every one of those pushed the hints off the last
 * line and made this parser answer null. The caller reads null as "a screen we
 * cannot drive", so a trust dialog with a status bar under it timed out after
 * 180 seconds instead of being offered as two buttons.
 *
 * Bounded rather than open-ended: the footer has to still be near the bottom,
 * or a hint line from the transcript scrolled above could pose as one.
 */
const MAX_FOOTER_CHROME = 3;
/**
 * Longest option label we keep. Telegram caps a button at 64 bytes and the
 * ask-user contract at 60 chars; claude pads its rows out to the full 120
 * columns with a trailing description, so most need clipping.
 */
const MAX_LABEL = 48;

/**
 * The screen's non-blank rows, the bottom {@link MAX_BODY_ROWS} of them, and
 * for each whether a blank row sat above it. The parse reads only the rows;
 * the gaps are for showing the result, since they are how claude splits a
 * dialog into its title, command, reason and question.
 */
function bodyLines(screenText: string): { lines: string[]; gaps: boolean[] } {
  const lines: string[] = [];
  const gaps: boolean[] = [];
  let gap = false;
  for (const raw of screenText.split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      gap = true;
      continue;
    }
    lines.push(line);
    gaps.push(gap);
    gap = false;
  }
  return { lines: lines.slice(-MAX_BODY_ROWS), gaps: gaps.slice(-MAX_BODY_ROWS) };
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clip(text: string, max: number): string {
  const collapsed = collapse(text);
  // trimEnd after slicing: a cut that lands on a space would otherwise render
  // the gap before the ellipsis, which reads as a missing word.
  return collapsed.length > max ? `${collapsed.slice(0, max - 1).trimEnd()}…` : collapsed;
}

/**
 * Find the footer: the lowest line that reads as key hints, allowing for the
 * status chrome claude draws beneath a dialog. Returns null when the bottom of
 * the screen holds no hints at all.
 */
function findFooter(lines: string[]): { index: number; hints: ModalKeyHint[] } | null {
  const floor = Math.max(0, lines.length - 1 - MAX_FOOTER_CHROME);
  for (let i = lines.length - 1; i >= floor; i--) {
    const hints = parseKeyHints(lines[i]);
    if (hints.length > 0) return { index: i, hints };
  }
  return null;
}

/**
 * Where a dialog with no footer ends, standing in for {@link findFooter}.
 *
 * WebFetch's permission prompt has none. It ends on its last row, and the one
 * key it names is written into that row — `3. No, and tell Claude what to do
 * differently (esc)` — so a parser that insisted on a footer never saw it,
 * and a turn that asked to fetch a page sat on the dialog, unrelayed, until
 * the hard ceiling. What marks the end instead is the list itself: numbered
 * rows with the cursor on one, under the seam, reaching the bottom of the
 * screen. The glyph's other haunts don't fit that shape — echoed prompts sit
 * above the seam, and the input box has a rule of its own beneath it.
 *
 * Numbered rows only, because that is how claude draws a list meant for
 * picking from, and it keeps this to the shape that was measured. The index is
 * just past the list, where a footer would be; there are no hints to go with it.
 */
function findListEnd(lines: string[], width: number): { index: number; hints: ModalKeyHint[] } | null {
  const seam = lastRuleBefore(lines, lines.length);
  if (seam < 0) return null;
  const { options, list } = extractOptions(lines.slice(seam + 1), width);
  if (!list || options.length < 2 || options.some((o) => o.number === undefined)) return null;
  const index = seam + 1 + list.end + 1;
  return lines.length - index <= MAX_FOOTER_CHROME ? { index, hints: [] } : null;
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
  const { lines, gaps } = bodyLines(screenText);
  if (lines.length === 0) return null;
  // The terminal's width, near enough: the seam is drawn edge to edge.
  const width = Math.max(...lines.map((l) => l.length));

  const footer = findFooter(lines) ?? findListEnd(lines, width);
  if (!footer) return null;
  const { hints, index: footerIndex } = footer;

  // Body starts below the seam rule when there is one; a dialog that redrew
  // the whole screen has no seam, and everything we kept is its body.
  let seam = lastRuleBefore(lines, footerIndex);
  let body = lines.slice(seam + 1, footerIndex);

  // A rule can also sit *inside* a dialog. Auto mode draws one between its
  // numbered choices and a trailing "Chat about this", which left a body of a
  // single line with no cursor in it — five options parsed as none, and the
  // only button on offer was a bare `Enter to select` committing the row
  // nobody had been shown. Reach back past a rule like that.
  //
  // Only when what's left below it is numbered, though. The transcript above
  // a dialog carries the echoed command wearing this same glyph (`❯ /tasks`),
  // and reaching past the real seam would swallow it as an option. Claude
  // numbers a list exactly when its rows are selectable, so that is the line
  // between a continued list and a dialog that simply has no rows.
  if (seam > 0 && body.length > 0
    && !body.some((line) => CURSOR_ROW.test(line))
    && body.every((line) => ROW_NUMBER.test(line.trimStart()))) {
    const outer = lastRuleBefore(lines, seam);
    const extended = lines.slice(outer + 1, footerIndex);
    if (extended.some((line) => CURSOR_ROW.test(line))) {
      seam = outer;
      body = extended;
    }
  }
  if (body.length === 0) return null;

  const { options, highlighted, rows, list } = extractOptions(body, width);
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
    parts: readParts(body, gaps.slice(seam + 1, footerIndex), list, width),
  };
}

/** Index of the last rule strictly above `before`, or -1 when there is none. */
function lastRuleBefore(lines: string[], before: number): number {
  for (let i = before - 1; i >= 0; i--) {
    if (RULE.test(lines[i])) return i;
  }
  return -1;
}

/**
 * What `line` is, to a list whose rows begin at `col`.
 *
 * The three answers are the shape of every list claude draws. A row starts
 * exactly at the column its siblings do. Anything starting *deeper* hangs off
 * the row above — auto mode gives each choice a sentence of explanation
 * underneath, and a walk that stopped at the first of those found one option
 * where there were five. A rule can sit inside a list too, so it is stepped
 * over rather than treated as the end. Anything starting *shallower* is the
 * title, the blurb or prose, and that really is the end of the list.
 */
function rowRole(line: string, col: number): 'row' | 'skip' | 'end' {
  if (RULE.test(line)) return 'skip';
  const at = line.search(/\S/);
  if (at < 0) return 'skip';
  if (at === col) return 'row';
  return at > col ? 'skip' : 'end';
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
  width: number,
): { options: ModalOption[]; highlighted: number; rows: Set<number>; list: BodySpan | null } {
  const none = { options: [], highlighted: -1, rows: new Set<number>(), list: null };

  const cursor = body.findIndex((l) => CURSOR_ROW.test(l));
  if (cursor < 0) return none;
  const match = CURSOR_ROW.exec(body[cursor])!;
  const labelCol = match[1].length + 1 + match[2].length;

  const indexes: number[] = [];
  for (let i = cursor - 1; i >= 0; i--) {
    const role = rowRole(body[i], labelCol);
    if (role === 'end') break;
    if (role === 'row') indexes.unshift(i);
  }
  // However many rows sit above it is where the cursor is — the arrow walk
  // counts rows, not screen lines, and the two differ wherever a description
  // or a rule sits between them.
  const highlighted = indexes.length;
  indexes.push(cursor);
  // Where this walk stops is where the list ends: what hangs under its last
  // row still belongs to that row.
  let stop = cursor + 1;
  for (; stop < body.length; stop++) {
    const role = rowRole(body[stop], labelCol);
    if (role === 'end') break;
    if (role === 'row') indexes.push(stop);
  }

  const options: ModalOption[] = [];
  const rows = new Set<number>();
  indexes.forEach((i, k) => {
    rows.add(i);
    const text = i === cursor ? match[3] : body[i].slice(labelCol);
    const numbered = ROW_NUMBER.exec(text);
    const own = numbered ? numbered[2] : text;
    const under = body.slice(i + 1, indexes[k + 1] ?? stop).filter((l) => !RULE.test(l));
    options.push({
      ...(numbered ? { number: Number(numbered[1]) } : {}),
      label: clip(own, MAX_LABEL),
      ...readRow(body[i], own, under, width),
      index: options.length,
    });
  });
  return { options, highlighted, rows, list: { start: indexes[0], end: stop - 1 } };
}

/** A run of body rows, first and last inclusive. */
interface BodySpan {
  start: number;
  end: number;
}

/**
 * A row's full text, and what the dialog says about it.
 *
 * `under` is whatever hangs beneath the row before the next one: the rest of
 * a label claude wrapped at the edge, then any description — auto writes a
 * sentence under each choice. `/model` puts its description beside the row
 * instead, a wide gap away, which is what splitting on a run of spaces finds.
 */
function readRow(
  row: string, own: string, under: string[], width: number,
): { text: string; detail?: string } {
  let text = own;
  let last = row;
  let n = 0;
  while (n < under.length && wrapsOnto(last, under[n], width)) {
    text += ` ${under[n].trim()}`;
    last = under[n++];
  }
  const [label, ...beside] = text.trim().split(/\s{2,}/);
  const detail = collapse([...beside, ...under.slice(n)].join(' '));
  return { text: collapse(label), ...(detail ? { detail } : {}) };
}

/**
 * Read the body into what a chat can show, in the order claude drew it.
 *
 * Blank rows split it into parts, as they split the dialog on screen, and so
 * does any change between prose and drawn content — a Bash prompt's command
 * sits straight under its title, with nothing but its gutter to set it off.
 */
function readParts(body: string[], gaps: boolean[], list: BodySpan | null, width: number): ModalPart[] {
  const parts: ModalPart[] = [];
  let open: { kind: 'text' | 'verbatim'; lines: string[]; gapBefore: boolean } | null = null;
  let fenced = false;

  for (let i = 0; i < body.length; i++) {
    const line = body[i];
    if (list && i >= list.start && i <= list.end) {
      if (i === list.start) parts.push({ kind: 'options', gapBefore: gaps[i] });
      open = null;
      continue;
    }
    if (FENCE.test(line)) {
      fenced = !fenced;
      open = null;
      continue;
    }
    if (RULE.test(line)) {
      open = null;
      continue;
    }

    const gutter = fenced ? null : GUTTER.exec(line);
    const kind = fenced || gutter ? 'verbatim' : 'text';
    if (open?.kind === 'verbatim' && kind === 'verbatim' && gaps[i]) {
      // A blank row inside drawn content is part of the content.
      open.lines.push('');
    } else if (!open || open.kind !== kind || gaps[i]) {
      open = { kind, lines: [], gapBefore: gaps[i] };
      parts.push(open);
    }
    open.lines.push(gutter ? gutter[1] : line);
  }

  // The dialog's own prose sits at one indent; what it quotes — a one-line
  // command, a URL — is indented under it. Only the prose gets rejoined: a
  // command whose last row ends near the edge would otherwise swallow the
  // description under it, and show the user a command they aren't approving.
  const base = Math.min(...parts.flatMap((p) => (p.kind === 'text' ? p.lines.map(indentOf) : [])));

  return parts.map((part) => {
    if (part.kind === 'text') return { ...part, lines: unwrap(part.lines, width, base) };
    if (part.kind === 'verbatim') return { ...part, lines: dedent(part.lines) };
    return part;
  });
}

/**
 * Undo claude's wraps at the terminal edge. It breaks prose where the width
 * runs out, and a phone then wraps both halves again, stranding the odd word
 * on a line of its own. A row carries on into the next exactly when the next
 * one's first word would not have fitted on it.
 */
function unwrap(lines: string[], width: number, indent: number): string[] {
  const out: string[] = [];
  lines.forEach((line, i) => {
    const prose = i > 0 && indentOf(lines[i - 1]) === indent && indentOf(line) === indent;
    if (prose && wrapsOnto(lines[i - 1], line, width)) out[out.length - 1] += ` ${line.trim()}`;
    else out.push(line.trim());
  });
  return out;
}

function indentOf(line: string): number {
  return line.search(/\S/);
}

/** True when claude broke `row` at the edge and `next` is the rest of it. */
function wrapsOnto(row: string, next: string, width: number): boolean {
  const word = next.trim().split(/\s/, 1)[0];
  return row.length + 1 + word.length > width - WRAP_SLACK;
}

/** Strip the indentation every line shares — the dialog's, not the content's. */
function dedent(lines: string[]): string[] {
  const depth = Math.min(...lines.filter((l) => l.trim()).map(indentOf));
  return Number.isFinite(depth) ? lines.map((l) => l.slice(depth)) : lines;
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

/**
 * The byte a footer hint's key sends. Null for keys that don't answer the
 * dialog, which are no use as a button.
 *
 * Tab is one of those, though claude's footers name it. A permission prompt's
 * `Tab to amend` turns the highlighted row into a text field — `Yes, and tell
 * Claude what to do next` — and waits for a note there, which a button cannot
 * type. Pressing it only ever changed the dialog without closing it, and the
 * turn then failed on a dialog that was still open.
 */
export function keystrokeFor(key: string): string | null {
  if (/^Enter/.test(key)) return '\r';
  if (key === 'Esc') return '\x1b';
  if (key === 'Space') return ' ';
  if (/^[a-z]$/.test(key)) return key;
  // ↑/↓, ←/→ and / are navigation or search affordances, not answers.
  return null;
}
