/**
 * Scrape Claude Code's `/tasks` overlay out of the rendered xterm buffer.
 *
 * `/tasks` (alias `/bashes`, "View and manage everything running in the
 * background") is a `local-jsx` command: it draws an Ink overlay pinned to the
 * bottom of the TUI and writes nothing to the session JSONL. It is the live
 * process's own view of its background work, so it sees things our arm-time
 * tracker cannot — shells claude backgrounded on its own, and anything that
 * predates a bot restart.
 *
 * Two shapes, decided by claude, not by us. With several tasks it opens on the
 * list (2.1.311 shown; up to 2.1.226 the rows read `sleep 500 (running)` with
 * no bullet or status column):
 *
 *     ────────────────────────────────────────────────────────────
 *       Background
 *       3 active shells
 *
 *       ❯ ● sleep 100                                   running
 *         ● sleep 150                                   running
 *         ● for i in $(seq 1 40); do echo "line $i";…   running
 *
 *           Earlier in this session (0)
 *
 *       ↑/↓ to select · Enter to view · x to stop · Esc to close
 *
 * With exactly one it opens that task's detail instead, which Enter on a row
 * opens too:
 *
 *       Shell details
 *
 *       Status:   running
 *       Runtime:  22s
 *       Command:  for i in $(seq 1 40); do echo "line $i"; sleep 2; done
 *
 *       Output:
 *       ╭──────────────────────────────────────────────────────────╮
 *       │ line 4                                                   │
 *       │ line 5                                                   │
 *       ╰──────────────────────────────────────────────────────────╯
 *       Showing 9 lines
 *
 *       ← to go back · Esc/Enter/Space to close · x to stop
 *
 * Anchor: the overlay sits under a full-width rule, and while it is open the
 * input box (two rules around a `❯` row) is not drawn, so the lowest rule in
 * the buffer is the overlay's — with everything above it being scrollback. Up
 * to 2.1.226 that rule was `▔` (U+2594), a glyph nothing else used; 2.1.311
 * draws it with the same `─` (U+2500) as the input box, so the body under the
 * lowest rule has to identify itself: it opens with `Background` or a `…
 * details` title. Returns null when no overlay is found, which callers
 * surface as "couldn't read it" rather than guessing.
 */

/** The overlay's top rule. Full-width in practice; 10 is a safe floor. */
const OVERLAY_RULE_RE = /^(?:▔{10,}|─{10,})$/;

/**
 * What the overlay's body opens with. `Background` is the list (and the idle
 * view); `Shell details`, `Agent details`, … are a task. The status lines
 * under a closed overlay's input box open with neither, which is what keeps
 * them from being read as an overlay.
 */
const HEADING_RE = /^(?:Background|\S.* details)$/;

/**
 * The trailing keyboard-hint line ("… Esc to close"). Useless over Telegram —
 * there's no keyboard attached — so it gets dropped. Both shapes end in
 * "to close" or carry on past it ("… Esc/Enter/Space to close · x to stop");
 * the leading-glyph alternatives guard against a task whose own text happens
 * to contain that phrase.
 */
const HINT_RE = /(?:↑\/↓|←|Esc|Enter)\s.*\bto close\b/;

/**
 * Selection caret on the highlighted row; meaningless in a chat transcript.
 * Replaced with its own width in spaces rather than deleted, so the selected
 * row stays aligned with its unselected siblings.
 */
const CARET_RE = /^❯\s?/;

export interface TasksOverlay {
  /** Overlay body, dedented, caret and hint line removed. */
  text: string;
  /** True when claude reported nothing running. */
  empty: boolean;
}

/** Strip the common leading indentation shared by every non-blank line. */
function dedent(lines: string[]): string[] {
  const indents = lines
    .filter((l) => l.trim().length > 0)
    .map((l) => l.length - l.trimStart().length);
  const common = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => (l.trim().length > 0 ? l.slice(common) : ''));
}

export function scrapeTasksOverlay(screenText: string): TasksOverlay | null {
  const lines = screenText.split('\n');

  // The lowest rule, and only that one: the overlay is pinned to the bottom,
  // and a rule higher up is the input box's or an earlier overlay's, still in
  // scrollback. Reading past the lowest one would hand back stale data.
  let ruleIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (OVERLAY_RULE_RE.test(lines[i].trim())) {
      ruleIndex = i;
      break;
    }
  }
  if (ruleIndex === -1) return null;

  let body = lines.slice(ruleIndex + 1);

  // Drop the trailing hint line and any blank padding around it.
  while (body.length > 0) {
    const last = body[body.length - 1];
    if (last.trim() === '' || HINT_RE.test(last)) {
      body.pop();
      continue;
    }
    break;
  }

  body = dedent(body).map((l) => l.replace(CARET_RE, (m) => ' '.repeat(m.length)));

  // Collapse runs of blank lines — the overlay pads generously for the TUI,
  // which reads as dead space in a chat message.
  const text = body
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!text) return null;
  if (!HEADING_RE.test(text.split('\n', 1)[0].trim())) return null;

  // claude's own wording for the idle case. Matched loosely so a phrasing
  // change degrades to "not empty" (we show the text) rather than a wrong
  // "nothing running".
  const empty = /\bno (?:tasks|shells|agents)\b.*\brunning\b/i.test(text);

  return { text, empty };
}

// ---------------------------------------------------------------------------
// The list's rows and a task's detail, for driving the overlay
// ---------------------------------------------------------------------------

/** One selectable row of the list view, in screen order. */
export interface TaskRow {
  /**
   * The row's label as drawn: a command, or a description for a monitor. The
   * column is narrow, so a long one ends in `…` — see `truncated`.
   */
  label: string;
  /** The status column (`running`, `completed`, …); empty when there is none. */
  status: string;
  /** True when the label was cut to fit, and so is a prefix of the real one. */
  truncated: boolean;
}

/**
 * A row: a `●` bullet, the label, and (2.1.311) two or more spaces before
 * the status word. The `Earlier in this session (0)` section heading carries
 * no bullet, so it isn't one.
 */
const ROW_RE = /^\s*●\s+(.+?)(?:\s{2,}(\S+))?\s*$/;

/**
 * The list's rows, top to bottom. Cursor position `i` in the TUI is `i`
 * presses of ↓ from the top, which is what makes the index worth having.
 * Empty for a detail view, the idle view, or a layout without bullets.
 */
export function parseTaskRows(overlayText: string): TaskRow[] {
  const rows: TaskRow[] = [];
  for (const line of overlayText.split('\n')) {
    const m = ROW_RE.exec(line);
    if (!m) continue;
    const raw = m[1].trim();
    const truncated = /(?:…|\.\.\.)$/.test(raw);
    rows.push({
      label: truncated ? raw.replace(/(?:…|\.\.\.)$/, '').trimEnd() : raw,
      status: m[2] ?? '',
      truncated,
    });
  }
  return rows;
}

export interface TaskDetail {
  /** `Shell details`, `Agent details`, … */
  title: string;
  /** `Status`, `Runtime`, `Command` and whatever else the view lists, in order. */
  fields: { label: string; value: string }[];
  /**
   * The output pane's lines with the box chrome stripped, trailing blanks
   * removed. Null when claude says there is none yet.
   */
  output: string | null;
  /** The line under the box, if any: `Showing 9 lines`. */
  note?: string;
}

const DETAIL_TITLE_RE = /^\S.* details$/;
const FIELD_RE = /^([A-Z][\w ]*):\s+(.*)$/;
const OUTPUT_HEADING_RE = /^Output:\s*$/;
/** The output box's top and bottom edges. */
const BOX_EDGE_RE = /^[╭╰]─*[╮╯]\s*$/;
/** A line inside the box: `│ text   │`. */
const BOX_LINE_RE = /^│ ?(.*?)\s*│?\s*$/;
const NO_OUTPUT_RE = /^no output available$/i;

/**
 * A task's detail view, or null when the overlay text is the list. The
 * fields are kept as drawn rather than mapped to known names, so a field
 * added in a later release shows up instead of vanishing.
 */
export function parseTaskDetail(overlayText: string): TaskDetail | null {
  const lines = overlayText.split('\n');
  const title = lines[0]?.trim() ?? '';
  if (!DETAIL_TITLE_RE.test(title)) return null;

  const fields: TaskDetail['fields'] = [];
  const outputLines: string[] = [];
  let note: string | undefined;
  let inOutput = false;
  let inBox = false;

  for (const line of lines.slice(1)) {
    if (!inOutput) {
      if (OUTPUT_HEADING_RE.test(line.trim())) {
        inOutput = true;
        continue;
      }
      const m = FIELD_RE.exec(line.trim());
      if (m) fields.push({ label: m[1], value: m[2].trim() });
      continue;
    }
    const trimmed = line.trim();
    if (BOX_EDGE_RE.test(trimmed)) {
      inBox = !inBox;
      continue;
    }
    if (inBox) {
      const m = BOX_LINE_RE.exec(trimmed);
      outputLines.push(m ? m[1] : trimmed);
      continue;
    }
    if (trimmed === '') continue;
    if (NO_OUTPUT_RE.test(trimmed)) continue;
    // Under the box: `Showing 9 lines`. Before any box: output drawn bare.
    if (outputLines.length > 0) note = trimmed;
    else outputLines.push(trimmed);
  }

  while (outputLines.length > 0 && outputLines[outputLines.length - 1].trim() === '') {
    outputLines.pop();
  }

  return {
    title,
    fields,
    output: outputLines.length > 0 ? outputLines.join('\n') : null,
    ...(note !== undefined ? { note } : {}),
  };
}
