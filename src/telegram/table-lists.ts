/**
 * Markdown tables rewritten as bullet lists, for a report made of narrow
 * label-and-number tables.
 *
 * Telegram has no tables, so markdown.ts draws each row as a block of
 * `Header: cell` lines. That suits the prose tables Claude writes in a reply,
 * but Claude Code's `/context` report is three tables of short rows, and drawn
 * that way it runs past a hundred lines. Here each row is one line, its first
 * cell in bold and the rest after it, and the other column headers go above
 * the list in italics so the numbers keep their names:
 *
 *     _Tokens · Percentage_
 *     - **System prompt:** 3.8k · 0.4%
 *
 * Everything that isn't a table passes through unchanged.
 */
export function tablesToLists(markdown: string): string {
  const lines = markdown.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const header = cells(lines[i]);
    if (!header || !SEPARATOR_RE.test(lines[i + 1] ?? '')) {
      out.push(lines[i]);
      i++;
      continue;
    }
    i += 2;
    const names = header.slice(1).filter(Boolean);
    if (names.length > 0) out.push(`_${names.join(' · ')}_`);
    for (let row = cells(lines[i] ?? ''); row; row = cells(lines[++i] ?? '')) {
      const [first, ...rest] = row;
      const values = rest.filter(Boolean).join(' · ');
      if (first && values) out.push(`- **${first}:** ${values}`);
      else if (first || values) out.push(`- ${first || values}`);
    }
  }
  return out.join('\n');
}

/** A table's header rule: `|---|:--:|---|`, outer pipes optional. */
const SEPARATOR_RE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** A table row's cells, trimmed, or null when the line isn't a row. */
function cells(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith('|')) return null;
  return t
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());
}
