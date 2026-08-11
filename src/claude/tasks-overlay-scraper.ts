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
 * list:
 *
 *     ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔
 *        Background
 *        2 active shells
 *
 *        ❯ sleep 500 (running)
 *          sleep 400 (running)
 *
 *        ↑/↓ to select · Enter to view · x to stop · Esc to close
 *
 * With exactly one it opens that task's detail instead (Status / Runtime /
 * Command / Output, ending in a `← to go back …` hint). Both are worth
 * relaying, so we take whichever we're given rather than forcing one.
 *
 * Anchor: the overlay is always preceded by a full-width run of `▔` (U+2594).
 * That glyph is specific to it — the input box and separators use `─` (U+2500)
 * — so the last such rule in the buffer marks where the overlay starts, with
 * everything above it being scrollback. Returns null when no overlay is found,
 * which callers surface as "couldn't read it" rather than guessing.
 */

/** The overlay's top rule. Full-width in practice; 10 is a safe floor. */
const OVERLAY_RULE_RE = /^▔{10,}$/;

/**
 * The trailing keyboard-hint line ("… Esc to close"). Useless over Telegram —
 * there's no keyboard attached — so it gets dropped. Both shapes end in
 * "to close"; the leading-glyph alternatives guard against a task whose own
 * text happens to contain that phrase.
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

  // Scan bottom-up: the overlay is pinned to the bottom, and an earlier rule
  // could survive in scrollback from a previous invocation.
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

  // claude's own wording for the idle case. Matched loosely so a phrasing
  // change degrades to "not empty" (we show the text) rather than a wrong
  // "nothing running".
  const empty = /\bno (?:tasks|shells|agents)\b.*\brunning\b/i.test(text);

  return { text, empty };
}
