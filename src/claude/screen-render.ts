/**
 * A headless terminal's visible screen, as text another terminal can show.
 *
 * `telecoder watch` uses it on both ends: the bot turns a claude's screen into
 * a snapshot for a watcher that has just joined, and the watcher paints its own
 * copy of the screen row by row. Each row is written out cell by cell with its
 * colours, so nothing depends on the watching terminal being the same size as
 * claude's: a row never relies on wrapping or scrolling to land where it should.
 */

import type headless from '@xterm/headless';

type Terminal = headless.Terminal;
type Cell = NonNullable<ReturnType<NonNullable<ReturnType<Terminal['buffer']['active']['getLine']>>['getCell']>>;

const RESET = '\x1b[0m';

/** The SGR parameters for one cell's look; '' for plain text. */
function cellStyle(cell: Cell): string {
  const sgr: string[] = [];
  if (cell.isBold()) sgr.push('1');
  if (cell.isDim()) sgr.push('2');
  if (cell.isItalic()) sgr.push('3');
  if (cell.isUnderline()) sgr.push('4');
  if (cell.isInverse()) sgr.push('7');
  if (cell.isInvisible()) sgr.push('8');
  if (cell.isStrikethrough()) sgr.push('9');
  if (cell.isFgRGB()) {
    const c = cell.getFgColor();
    sgr.push(`38;2;${(c >> 16) & 0xff};${(c >> 8) & 0xff};${c & 0xff}`);
  } else if (cell.isFgPalette()) {
    sgr.push(`38;5;${cell.getFgColor()}`);
  }
  if (cell.isBgRGB()) {
    const c = cell.getBgColor();
    sgr.push(`48;2;${(c >> 16) & 0xff};${(c >> 8) & 0xff};${c & 0xff}`);
  } else if (cell.isBgPalette()) {
    sgr.push(`48;5;${cell.getBgColor()}`);
  }
  return sgr.join(';');
}

export interface RenderOptions {
  /** Show at most this many columns of each row. Default: all of them. */
  maxCols?: number;
}

/**
 * The visible rows, top to bottom, each exactly as wide as the screen (or
 * `maxCols`), ending with its colours reset.
 */
export function renderRows(term: Terminal, { maxCols }: RenderOptions = {}): string[] {
  const buffer = term.buffer.active;
  const cols = Math.min(term.cols, maxCols ?? term.cols);
  const rows: string[] = [];
  for (let y = 0; y < term.rows; y++) {
    const line = buffer.getLine(buffer.baseY + y);
    let out = '';
    let style = '';
    let cell: Cell | undefined;
    for (let x = 0; x < cols; x++) {
      cell = line?.getCell(x, cell);
      if (!cell) {
        out += ' ';
        continue;
      }
      const width = cell.getWidth();
      // The second half of a wide character: its first half already drew it.
      if (width === 0) continue;
      // A wide character that would stick out past the last column.
      if (width === 2 && x + 1 >= cols) {
        out += ' ';
        continue;
      }
      const next = cellStyle(cell);
      if (next !== style) {
        out += (style ? RESET : '') + (next ? `\x1b[${next}m` : '');
        style = next;
      }
      out += cell.getChars() || ' ';
    }
    rows.push(style ? out + RESET : out);
  }
  return rows;
}

/**
 * The screen as one string that, written to a cleared terminal at least as
 * large, shows the same picture with the cursor in the same place.
 */
export function screenSnapshot(term: Terminal): string {
  const buffer = term.buffer.active;
  const rows = renderRows(term);
  let out = '\x1b[0m\x1b[2J';
  rows.forEach((row, y) => {
    out += `\x1b[${y + 1};1H${row}`;
  });
  return `${out}\x1b[${buffer.cursorY + 1};${buffer.cursorX + 1}H`;
}
