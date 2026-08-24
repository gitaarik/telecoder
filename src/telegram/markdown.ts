import { convert } from 'telegram-markdown-v2';

// Telegram limits
const MAX_MESSAGE_LENGTH = 4096;

/**
 * Convert standard markdown to Telegram MarkdownV2 format
 */
export function convertToTelegramMarkdown(text: string): string {
  try {
    // Pre-process outside fenced code blocks:
    // - Extract <expandable>...</expandable> blocks so convert() can't escape
    //   their special MarkdownV2 markers (**> and ||). Restored after conversion.
    // - Rewrite pipe-style markdown tables as bullet lists (Telegram has no monospace
    //   table rendering in MarkdownV2, so unconverted tables look ugly).
    // - Convert thematic breaks (---, ***, ___) to a unicode separator, since the
    //   telegram-markdown-v2 library leaves *** intact and Telegram then misinterprets
    //   it as an unterminated bold/italic entity.
    const { text: stripped, blocks } = extractExpandableBlocks(text);
    // Pull out `>` blockquote regions too — the telegram-markdown-v2 library
    // doesn't understand them: it escapes the `>` marker and double-escapes the
    // line content, so quotes render as raw escaped markdown. We convert their
    // inner markdown ourselves and re-emit proper `>`-prefixed lines afterward.
    const { text: noQuotes, blocks: quoteBlocks } = extractBlockquotes(stripped);
    const preprocessed = preprocessOutsideCode(noQuotes);
    const converted = convert(preprocessed, 'escape');
    const withQuotes = restoreBlockquotes(converted, quoteBlocks);
    return restoreExpandableBlocks(withQuotes, blocks);
  } catch (error) {
    console.error('Markdown conversion error:', error);
    // Fallback: escape special characters manually
    return escapeMarkdownV2(text);
  }
}

// ---------------------------------------------------------------------------
// Expandable blockquotes
// ---------------------------------------------------------------------------
//
// Telegram MarkdownV2 supports collapsible quotes (Bot API 7.0):
//   **>First line
//   >Second line
//   >Third line||
//
// The telegram-markdown-v2 library has no concept of these — it would escape
// the * | > markers. We work around it by pulling <expandable>...</expandable>
// regions out of the text before conversion, leaving an alphanumeric placeholder
// that convert() won't touch, then re-emitting the proper syntax afterwards.
// Plain-text content only; markdown formatting inside is not interpreted.

const EXPANDABLE_TAG_RE = /<expandable>([\s\S]*?)<\/expandable>/g;
const expandablePlaceholder = (i: number) => `XCGEXPANDABLEBLOCK${i}ENDX`;

function extractExpandableBlocks(text: string): { text: string; blocks: string[] } {
  const blocks: string[] = [];
  // Only extract outside fenced code so triple-backtick examples remain literal.
  const parts = text.split(/(```[\s\S]*?```)/g);
  const processed = parts.map((segment, i) => {
    if (i % 2 === 1) return segment;
    return segment.replace(EXPANDABLE_TAG_RE, (_, body) => {
      const idx = blocks.length;
      blocks.push(body);
      // Force placeholder onto its own line — Telegram only recognizes **> at
      // the start of a line, so the expanded block must not end up mid-paragraph.
      return `\n${expandablePlaceholder(idx)}\n`;
    });
  });
  return { text: processed.join(''), blocks };
}

function buildExpandableSyntax(body: string): string {
  const trimmed = body.replace(/^\n+|\n+$/g, '');
  if (!trimmed) return '';
  const escaped = trimmed.split('\n').map(escapeMarkdownV2);
  if (escaped.length === 1) return `**>${escaped[0]}||`;
  const head = `**>${escaped[0]}`;
  const middle = escaped.slice(1, -1).map(l => `>${l}`);
  const tail = `>${escaped[escaped.length - 1]}||`;
  return [head, ...middle, tail].join('\n');
}

function restoreExpandableBlocks(text: string, blocks: string[]): string {
  let result = text;
  blocks.forEach((body, idx) => {
    result = result.replace(expandablePlaceholder(idx), buildExpandableSyntax(body));
  });
  return result;
}

// ---------------------------------------------------------------------------
// Blockquotes
// ---------------------------------------------------------------------------
//
// Telegram MarkdownV2 blockquotes are lines prefixed with an unescaped `>`:
//   >First line
//   >Second line
// The telegram-markdown-v2 library treats `>` as a character to escape and
// double-escapes the line's content (escaping the backslashes its own escaping
// already added), so a quote renders as literal `\.`/`\-`/`*bold*` garbage.
// We extract contiguous `>` regions before convert(), recursively convert their
// inner markdown through the normal pipeline (so bold/italic/links/escaping all
// work), then re-prefix each resulting line with `>`.

const BLOCKQUOTE_LINE_RE = /^ {0,3}>/;
const blockquotePlaceholder = (i: number) => `XCGBLOCKQUOTEBLOCK${i}ENDX`;

function extractBlockquotes(text: string): { text: string; blocks: string[] } {
  const blocks: string[] = [];
  // Only extract outside fenced code so `>` inside code examples stays literal.
  const parts = text.split(/(```[\s\S]*?```)/g);
  const processed = parts.map((segment, idx) => {
    if (idx % 2 === 1) return segment;
    const lines = segment.split('\n');
    const out: string[] = [];
    let i = 0;
    while (i < lines.length) {
      if (BLOCKQUOTE_LINE_RE.test(lines[i])) {
        const inner: string[] = [];
        while (i < lines.length && BLOCKQUOTE_LINE_RE.test(lines[i])) {
          // Strip up to 3 leading spaces, the `>`, and one optional space.
          inner.push(lines[i].replace(/^ {0,3}>[ ]?/, ''));
          i++;
        }
        const blockIdx = blocks.length;
        blocks.push(inner.join('\n'));
        out.push(blockquotePlaceholder(blockIdx));
      } else {
        out.push(lines[i]);
        i++;
      }
    }
    return out.join('\n');
  });
  return { text: processed.join(''), blocks };
}

function restoreBlockquotes(text: string, blocks: string[]): string {
  let result = text;
  blocks.forEach((inner, idx) => {
    // Recursively convert the inner markdown (terminates: the `>` prefixes are
    // already stripped, so no blockquote region is re-extracted at this level).
    const convertedInner = convertToTelegramMarkdown(inner).replace(/\n+$/, '');
    const quoted = convertedInner.split('\n').map((l) => `>${l}`).join('\n');
    // Function replacer so `$` in the quoted content isn't treated as a
    // replacement pattern.
    result = result.replace(blockquotePlaceholder(idx), () => quoted);
  });
  return result;
}

/**
 * Apply non-code-block transformations: table rewriting and thematic-break replacement.
 * Splits on ``` boundaries so fenced code is left untouched.
 */
function preprocessOutsideCode(text: string): string {
  const parts = text.split(/(```[\s\S]*?```)/g);
  return parts.map((segment, i) => {
    // Odd indices are the fenced code blocks captured by the regex
    if (i % 2 === 1) return segment;
    let s = convertTablesToBulletLists(segment);
    s = s.replace(/^[ \t]*([\*\-_]){3,}[ \t]*$/gm, '———');
    return s;
  }).join('');
}

/**
 * Detect pipe-style markdown tables and rewrite each data row as bold-labeled lines.
 * Tables in Telegram MarkdownV2 have no monospace rendering, so raw `| a | b |` lines
 * just look like garbled text. We convert to a format that matches the system prompt's
 * preferred bullet-with-bold-labels layout.
 *
 * A "table region" is 2+ consecutive lines matching `|...|...|`. The first such line
 * is the header; an optional `|---|---|` separator row directly after is skipped.
 * Each data row becomes a block of `**Header**: Cell` lines, separated by a blank
 * line between rows. Standalone pipe lines (1 line) are left untouched to avoid
 * mangling code-like text.
 */
function convertTablesToBulletLists(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (isTableRow(lines[i])) {
      let j = i;
      while (j < lines.length && isTableRow(lines[j])) j++;
      const tableLines = lines.slice(i, j);
      if (tableLines.length >= 2) {
        result.push(...convertTable(tableLines));
      } else {
        result.push(...tableLines);
      }
      i = j;
    } else {
      result.push(lines[i]);
      i++;
    }
  }
  return result.join('\n');
}

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return /^\|.*\|.*\|$/.test(trimmed);
}

function isSeparatorRow(line: string): boolean {
  const cells = parseRow(line);
  return cells.length > 0 && cells.every(c => /^:?-{2,}:?$/.test(c));
}

function parseRow(line: string): string[] {
  const trimmed = line.trim();
  const inner = trimmed.slice(1, -1);
  return inner.split('|').map(c => c.trim());
}

function convertTable(tableLines: string[]): string[] {
  const headers = parseRow(tableLines[0]);
  const dataStart = (tableLines.length > 1 && isSeparatorRow(tableLines[1])) ? 2 : 1;
  const dataRows = tableLines.slice(dataStart).map(parseRow);

  if (dataRows.length === 0) {
    return headers.filter(h => h.length > 0).map(h => `- ${h}`);
  }

  const out: string[] = [];
  for (let r = 0; r < dataRows.length; r++) {
    if (r > 0) out.push('');
    const row = dataRows[r];
    const numCols = Math.max(headers.length, row.length);
    for (let c = 0; c < numCols; c++) {
      const header = headers[c] || '';
      const cell = row[c] || '';
      if (!cell) continue;
      out.push(header ? `**${header}**: ${cell}` : cell);
    }
  }
  return out;
}

/**
 * Escape special characters for MarkdownV2 (fallback)
 */
export function escapeMarkdownV2(text: string): string {
  // IMPORTANT: Backslash MUST be first to avoid double-escaping
  // Otherwise: `-` becomes `\-`, then `\` gets escaped to `\\-`
  const specialChars = ['\\', '_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'];
  let result = text;
  for (const char of specialChars) {
    result = result.replace(new RegExp(`\\${char}`, 'g'), `\\${char}`);
  }
  return result;
}

/**
 * Escape for use *inside* a MarkdownV2 code span or block, where the rules are
 * narrower: only a backtick and a backslash carry meaning, and a backslash
 * before anything else renders literally rather than escaping it. Running the
 * general escaper over a code span is what puts a visible backslash in the
 * middle of names like `/code-review`.
 */
export function escapeMarkdownV2Code(text: string): string {
  return text.replace(/([\\`])/g, '\\$1');
}

/**
 * Smart message splitter that respects code blocks and markdown formatting
 */
export function splitMessage(text: string, maxLength: number = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const parts: string[] = [];
  let remaining = text;
  let inCodeBlock = false;
  let codeBlockLang = '';

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      // If we're in a code block, close it properly
      if (inCodeBlock) {
        remaining = remaining + '\n```';
      }
      parts.push(remaining);
      break;
    }

    // Find the chunk to split
    let chunk = remaining.substring(0, maxLength);
    let splitIndex = maxLength;

    // Track code block state in this chunk
    const codeBlockMatches = chunk.matchAll(/```(\w*)?/g);
    let lastCodeBlockIndex: number = -1;
    let tempInCodeBlock: boolean = inCodeBlock;
    let tempLang: string = codeBlockLang;

    for (const match of codeBlockMatches) {
      lastCodeBlockIndex = match.index!;
      if (tempInCodeBlock) {
        // Closing a code block
        tempInCodeBlock = false;
        tempLang = '';
      } else {
        // Opening a code block
        tempInCodeBlock = true;
        tempLang = match[1] || '';
      }
    }

    // If we're ending mid-code-block, we need to handle it carefully
    if (tempInCodeBlock) {
      // Try to find a good split point before the last code block start
      // or at a newline within the code block

      // First, try to split at a newline
      let newlineSplit = chunk.lastIndexOf('\n');

      // If the newline is too early (less than half), look for the last complete line
      if (newlineSplit > maxLength / 2) {
        splitIndex = newlineSplit + 1;
        chunk = remaining.substring(0, splitIndex);

        // Recount code blocks in the adjusted chunk
        const adjustedMatches = chunk.matchAll(/```(\w*)?/g);
        tempInCodeBlock = inCodeBlock;
        tempLang = codeBlockLang;

        for (const match of adjustedMatches) {
          if (tempInCodeBlock) {
            tempInCodeBlock = false;
            tempLang = '';
          } else {
            tempInCodeBlock = true;
            tempLang = match[1] || '';
          }
        }
      }
    } else {
      // Not in a code block - try to split at natural boundaries
      // Priority: paragraph break > newline > space

      const paragraphBreak = chunk.lastIndexOf('\n\n');
      if (paragraphBreak > maxLength / 2) {
        splitIndex = paragraphBreak + 2;
      } else {
        const newlineBreak = chunk.lastIndexOf('\n');
        if (newlineBreak > maxLength / 2) {
          splitIndex = newlineBreak + 1;
        } else {
          const spaceBreak = chunk.lastIndexOf(' ');
          if (spaceBreak > maxLength / 2) {
            splitIndex = spaceBreak + 1;
          }
        }
      }

      chunk = remaining.substring(0, splitIndex);

      // Recount code blocks
      const adjustedMatches = chunk.matchAll(/```(\w*)?/g);
      tempInCodeBlock = inCodeBlock;
      tempLang = codeBlockLang;

      for (const match of adjustedMatches) {
        if (tempInCodeBlock) {
          tempInCodeBlock = false;
          tempLang = '';
        } else {
          tempInCodeBlock = true;
          tempLang = match[1] || '';
        }
      }
    }

    // If we end in a code block, close it and note to reopen
    if (tempInCodeBlock) {
      chunk = chunk.trimEnd() + '\n```';
      inCodeBlock = true;
      codeBlockLang = tempLang;
    } else {
      inCodeBlock = tempInCodeBlock;
      codeBlockLang = tempLang;
    }

    parts.push(chunk);

    // Prepare remaining text
    remaining = remaining.substring(splitIndex).trimStart();

    // If we were in a code block, reopen it
    if (inCodeBlock && remaining.length > 0) {
      remaining = '```' + codeBlockLang + '\n' + remaining;
    }
  }

  // Add part indicators if multiple parts
  if (parts.length > 1) {
    return parts.map((part, index) => {
      const indicator = `\n\n_\\[${index + 1}/${parts.length}\\]_`;
      // Make sure indicator fits
      if (part.length + indicator.length <= maxLength) {
        return part + indicator;
      }
      return part;
    });
  }

  return parts;
}

/**
 * Process and split a message for Telegram
 * Converts markdown and splits into chunks
 */
export function processMessageForTelegram(text: string, maxLength: number = MAX_MESSAGE_LENGTH): string[] {
  // First convert to Telegram markdown format
  const converted = convertToTelegramMarkdown(text);

  // Then split if needed
  return splitMessage(converted, maxLength);
}

// Legacy exports for backwards compatibility
export function escapeMarkdown(text: string): string {
  return escapeMarkdownV2(text);
}

export function formatCodeBlock(code: string, language?: string): string {
  const escaped = code.replace(/`/g, '\\`');
  if (language) {
    return `\`\`\`${language}\n${escaped}\n\`\`\``;
  }
  return `\`\`\`\n${escaped}\n\`\`\``;
}
