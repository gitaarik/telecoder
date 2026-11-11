/**
 * Live prose for a PTY turn: what the model has written so far, for the
 * streaming message to show while the turn is still running.
 *
 * The shape is the final reply's: the turn's assistant text records joined
 * the way readLastAssistantTurnText joins them, minus what an ask_user flush
 * already sent (turn-prose.ts). The live message then grows into the final
 * one instead of being replaced by something else at the end.
 *
 * Two sources, because neither is enough alone.
 *
 * The session log is the trustworthy one. Claude Code writes an assistant
 * record per content block, as the block completes, in the Markdown the model
 * wrote; the end-of-turn read uses the very same records. But a block lands
 * only once it is whole, so a turn that is one long answer would show nothing
 * until it was over.
 *
 * The screen fills that gap. Measured on claude 2.1.311–2.1.322 at 120x40: a
 * text block is drawn as it streams, a finished line at a time (`  12.` sits
 * alone until its line is done), and its record is written when the last line
 * is. While text streams the live spinner is gone — it comes back for thinking
 * and for every tool call — and the block is the last thing above the input
 * box. The TUI runs in the alternate screen, so there is no scrollback: a block
 * taller than the screen scrolls its `●` head off the top.
 *
 * The screen is also where everything that must never be streamed lives: tool
 * calls, their output, the spinner, hook output, notices. Some of it is drawn
 * in shapes prose has too — a call's description row (`● Printing hello to
 * stdout`), and with a running call's `●` blinking off, a row indented like a
 * text block's — so the screen is only read under every one of these:
 *
 *  - the input box is drawn (a dialog replaces it), and nothing between it
 *    and the block's `●` head sits at column 0 but blank rows — a spinner, the
 *    turn's `✻` summary, a prompt echo, any notice claude draws as its own row;
 *  - nothing in the block is a tool's: no `⎿` row, no collapsed-call hint, no
 *    head shaped like a call or an agent's notice;
 *  - the block has been seen to grow, its rows extending the ones before.
 *    Streaming text grows; a notice is drawn whole and stays as it is;
 *  - its head first showed after the turn's prompt reached the log, and no
 *    record of the turn has landed with its text. Once one has, the block is
 *    read from the log, and anything the screen then draws under it — a
 *    collapsed call's row, which carries no `●` — is not read at all.
 *
 * What comes off the screen is drawn text, not Markdown: emphasis markers and
 * `#`s are gone and a table is box drawing. That is the price of seeing a block
 * before it lands, and it lasts only until the block's record replaces it.
 * Once a block's head scrolls off, the screen can no longer say which rows are
 * the block's, so it stops growing on the live message until its record lands.
 */

import * as fs from 'fs';
import { turnRecordIn } from './session-jsonl.js';
import { stripDeliveredPrefix } from './turn-prose.js';

/** How readLastAssistantTurnText joins a turn's text records. */
const RECORD_SEPARATOR = '\n\n';

/**
 * A turn's text records, read from the session log as they land.
 *
 * Reads only what was appended since the last poll, starting where the log
 * ended at submit, and only whole lines: claude appends a record in more than
 * one write, and half a line doesn't parse. Records are classified by
 * turnRecordIn, the end-of-turn read's own rule, so the two cannot disagree on
 * what the turn's prose is.
 */
export class TurnProseReader {
  private cursor: number;
  private pending: Buffer = Buffer.alloc(0);
  private texts: string[] = [];
  private promptSeen = false;

  /**
   * `commandMode` is for a slash command, which is answered by every text
   * record it writes, with no prompt boundary (see commandReplyIn).
   */
  constructor(private readonly filePath: string, fromByte: number, private readonly commandMode = false) {
    this.cursor = fromByte;
  }

  /** The turn's text records so far, oldest first. */
  get records(): readonly string[] { return this.texts; }

  /** Whether the turn's prompt is in the log, which is when its prose can start. */
  get started(): boolean { return this.promptSeen; }

  /** Read whatever has been appended since the last poll. */
  poll(): void {
    let size: number;
    try { size = fs.statSync(this.filePath).size; }
    catch { return; }
    // A log shorter than our cursor was rewritten underneath us; nothing in it
    // is this turn's any more. Keep what we have, the end-of-turn read decides.
    if (size <= this.cursor) return;

    const chunk = Buffer.alloc(size - this.cursor);
    try {
      const fd = fs.openSync(this.filePath, 'r');
      try { fs.readSync(fd, chunk, 0, chunk.length, this.cursor); }
      finally { fs.closeSync(fd); }
    } catch {
      return;
    }
    this.cursor = size;
    this.consume(chunk);
  }

  /** Feed raw log bytes. Split out from poll for tests. */
  consume(chunk: Buffer): void {
    const buf = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const lastNewline = buf.lastIndexOf(0x0a);
    if (lastNewline === -1) {
      this.pending = buf;
      return;
    }
    this.pending = Buffer.from(buf.subarray(lastNewline + 1));
    for (const line of buf.subarray(0, lastNewline).toString('utf-8').split('\n')) {
      const rec = turnRecordIn(line);
      if (rec?.kind === 'prompt') {
        this.promptSeen = true;
        // Another real prompt is another turn. Not ours to stream, but the
        // end-of-turn read slices from the last one, so do as it does.
        if (!this.commandMode) this.texts = [];
      } else if (rec?.kind === 'text') {
        if (this.commandMode) this.promptSeen = true;
        if (this.promptSeen) this.texts.push(rec.text);
      }
    }
  }
}

// ---- Reading the in-flight block off the screen -----------------------------

/** The input box's borders: a full-width rule. Same rule as tui-state.ts. */
const RULE = /^\s*─{10,}\s*$/u;
/** The input box's own row. */
const INPUT_ROW = /^\s*(?:│\s*)?❯/u;
const SIDE_BORDERED_INPUT = /│\s*❯/u;
/** A transcript block's head row: claude's output bullet at column 0. */
const HEAD_ROW = /^●(?:\s|$)/u;
/**
 * The rows right above the input box that hold chrome drawn flush right:
 * `◐ medium · /effort`, and notices like `✔ Update installed · /restart to
 * apply` in the same spot. No row of a text block starts this far in.
 */
const RIGHT_ALIGNED_INDENT = 40;
/** Hangs under a tool call: its output, hook output, `Interrupted`. */
const TOOL_RESULT_ROW = /^\s*⎿/u;
/** A collapsed run of calls: `Read 1 file (ctrl+o to expand)`. */
const COLLAPSED_CALL_ROW = /\(ctrl\+o to expand\)\s*$/u;
/** A call's own head: `Bash(npm test)`, `mcp__x__y(…)`, cut off or not. */
const TOOL_CALL_HEAD = /^[A-Za-z][\w:-]*\(/u;
/** A background agent reporting in: `Agent "Run the checks" finished · 4s`. */
const AGENT_NOTICE_HEAD = /^Agent\s+".*"\s+\w+\s+·/u;
/** A call still running reads `Running 1 shell command…`, `Reading 1 file…`. */
const RUNNING_HEAD = /…\s*$/u;

/**
 * The rows of the text block claude is streaming, as drawn: the `●` head's text
 * first, each row's two-column indent removed, trailing blank rows dropped.
 * Undefined when the screen shows no such block, or shows anything that makes
 * it unsafe to read one — see the module comment for the rules.
 */
export function inflightBlockRows(screenText: string): string[] | undefined {
  const lines = screenText.split('\n');

  let boxTop = -1;
  for (let i = lines.length - 1; i > 0; i--) {
    if (SIDE_BORDERED_INPUT.test(lines[i]!)) { boxTop = i; break; }
    if (INPUT_ROW.test(lines[i]!) && RULE.test(lines[i - 1]!)) { boxTop = i - 1; break; }
  }
  if (boxTop === -1) return undefined;

  let end = boxTop;
  while (end > 0 && isBlankOrRightAligned(lines[end - 1]!)) end--;
  if (end === 0) return undefined;

  let head = -1;
  for (let i = end - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (HEAD_ROW.test(line)) { head = i; break; }
    if (!line.trim()) continue;
    // Everything of a text block below its head is indented. A row that isn't
    // is something else's — the spinner, the turn summary, a prompt, a notice.
    if (!line.startsWith('  ')) return undefined;
    if (TOOL_RESULT_ROW.test(line) || COLLAPSED_CALL_ROW.test(line)) return undefined;
  }
  // No head on screen: either it scrolled off or there is no block. The rows
  // left can't be told apart, so neither is read.
  if (head === -1) return undefined;

  const headText = lines[head]!.replace(/^●\s*/u, '').trimEnd();
  if (!headText.trim()) return undefined;
  if (TOOL_CALL_HEAD.test(headText) || AGENT_NOTICE_HEAD.test(headText)
    || RUNNING_HEAD.test(headText) || COLLAPSED_CALL_ROW.test(headText)) {
    return undefined;
  }

  const body = lines.slice(head + 1, end).map((line) => line.slice(2).trimEnd());
  while (body.length && !body[body.length - 1]!.trim()) body.pop();
  return [headText, ...body];
}

function isBlankOrRightAligned(line: string): boolean {
  if (!line.trim()) return true;
  return line.length - line.trimStart().length >= RIGHT_ALIGNED_INDENT;
}

/** A list item, table row or other row that starts a line of its own. */
const LINE_START = /^\s*(?:\d+[.)]\s|[-*+•]\s|[│┌├└╭╰])/u;
/** Rows of a table drawn in box drawing, which fill the width without wrapping. */
const BOX_DRAWING = /[│┌┐└┘├┤┬┴┼─]/u;

/**
 * Join rows the TUI wrapped back into the lines the model wrote.
 *
 * Claude wraps at word boundaries one column short of the terminal's width,
 * so a row ends a wrapped line when the next row's first word would not have
 * fit after it. A row that ends a real line early is left alone, and so is a
 * row that opens a list item or belongs to a table. Getting one wrong costs a
 * line break in the live message, until the record replaces it.
 */
export function unwrapRows(rows: string[], cols: number): string {
  const out: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const prev = out.length ? out[out.length - 1]! : undefined;
    const prevRow = i > 0 ? rows[i - 1]! : undefined;
    if (prev !== undefined && prevRow !== undefined && wraps(prevRow, row, cols)) {
      out[out.length - 1] = `${prev} ${row.trim()}`;
    } else {
      out.push(row);
    }
  }
  return out.join('\n');
}

function wraps(row: string, next: string, cols: number): boolean {
  if (!row.trim() || !next.trim()) return false;
  if (LINE_START.test(next) || BOX_DRAWING.test(row) || BOX_DRAWING.test(next)) return false;
  const firstWord = next.trim().split(/\s/u)[0]!;
  // Rows here have lost the two-column indent the screen drew them with.
  return row.length + 2 + 1 + firstWord.length > cols - 1;
}

/**
 * Text reduced to its letters and digits, for asking whether a drawn block and
 * a Markdown record hold the same words. The drawing drops `**`, `#`, fences
 * and link brackets and turns a table into box drawing; none of that is a
 * letter or a digit.
 */
export function comparable(text: string): string {
  return text.replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
}

interface InflightBlock {
  rows: string[];
  /** Records of the turn already landed when the block's head first showed. */
  recordsAtSighting: number;
  /** Seen to grow: a later frame extended its rows. */
  grown: boolean;
}

/** Does `next` continue `prev`: the same rows, the last one perhaps finished since, and more? */
function grewFrom(prev: string[], next: string[]): boolean {
  if (next.length < prev.length) return false;
  const last = prev.length - 1;
  for (let i = 0; i < last; i++) if (prev[i] !== next[i]) return false;
  if (!next[last]!.startsWith(prev[last]!)) return false;
  return next.length > prev.length || next[last]!.length > prev[last]!.length;
}

/**
 * One PTY turn's live prose. The provider calls tick() on a timer while the
 * turn runs; it calls `emit` with the turn's prose whenever that changed.
 */
export class PtyTurnStream {
  private block: InflightBlock | undefined;
  private lastEmitted = '';

  constructor(
    private readonly reader: TurnProseReader,
    private readonly emit: (text: string) => void,
    /** What an ask_user flush has already sent this turn (turn-prose.ts). */
    private readonly delivered: () => string | undefined,
  ) {}

  /**
   * Bring the live prose up to date. `screenText` is the screen as it stands,
   * or undefined when the caller knows it can't hold streaming text (a dialog
   * is being answered, the turn has stopped).
   */
  tick(screenText: string | undefined, cols: number): void {
    this.reader.poll();
    if (screenText !== undefined && this.reader.started) this.observe(inflightBlockRows(screenText));

    const text = this.compose(cols);
    // Nothing yet is not news. Once something went out, every change is,
    // including to empty: an ask_user flush just moved it all above the question.
    if (text === this.lastEmitted) return;
    this.lastEmitted = text;
    this.emit(text);
  }

  private observe(rows: string[] | undefined): void {
    // Nothing safe to read this time: keep what was read before. The block is
    // either still there behind a frame we refused, or has scrolled its head
    // away, and either way the log will bring the rest.
    if (!rows) return;
    const block = this.block;
    if (block && rows[0] === block.rows[0]) {
      if (grewFrom(block.rows, rows)) block.grown = true;
      block.rows = rows;
      return;
    }
    this.block = { rows, recordsAtSighting: this.reader.records.length, grown: false };
  }

  /** The turn's prose: its records, then the block still streaming, if it may be shown. */
  compose(cols: number): string {
    const records = this.reader.records;
    const parts = [...records];
    const inflight = this.inflightText(cols);
    if (inflight) parts.push(inflight);
    return stripDeliveredPrefix(parts.join(RECORD_SEPARATOR), this.delivered());
  }

  private inflightText(cols: number): string | undefined {
    const block = this.block;
    if (!block?.grown) return undefined;
    const text = unwrapRows(block.rows, cols).trim();
    const drawn = comparable(text);
    if (!drawn) return undefined;
    // The block's own record, once it lands, holds the same words. Only records
    // from around its sighting are compared: one landed just before it showed
    // (it streamed and finished between two ticks), and any since.
    const landed = this.reader.records
      .slice(Math.max(0, block.recordsAtSighting - 1))
      .some((record) => {
        const written = comparable(record);
        return !!written && (written.startsWith(drawn) || drawn.startsWith(written));
      });
    return landed ? undefined : text;
  }
}
