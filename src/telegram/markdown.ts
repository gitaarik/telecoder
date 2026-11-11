/**
 * Markdown, as Claude writes it, turned into a Telegram message: plain text
 * with the formatting carried as entities. See ./entities.ts for why nothing
 * goes out with a parse mode.
 *
 * The markdown is parsed into a syntax tree (CommonMark plus GitHub's tables,
 * strikethrough and bare-URL links) and the tree is walked into an
 * {@link EntityText}. Markdown that doesn't parse as formatting — an unclosed
 * `**`, a half-written link while a reply is still streaming — comes out as the
 * literal characters, never as an error.
 *
 * What it renders, kept as the earlier MarkdownV2 conversion showed it:
 * headings in bold, `•` and `1.` list markers, `———` for a thematic break, and
 * a table as one block of `**Header**: cell` lines per row, since Telegram has
 * no tables. `<expandable>…</expandable>` becomes a quote collapsed to its
 * first lines.
 */

import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import type { Nodes, Parents, PhrasingContent, RootContent, Table, List, ListItem } from 'mdast';
import type { MessageEntity } from 'grammy/types';
import {
  EntityText,
  indentMessage,
  isHighSurrogate,
  isLinkableUrl,
  sliceMessage,
  trimMessage,
  type EntityMessage,
} from './entities.js';

/** Telegram's cap on a message's text, in UTF-16 code units. */
export const MAX_MESSAGE_LENGTH = 4096;

/** Telegram applies at most this many entities to a message. */
export const MAX_ENTITIES = 100;

/** Room kept free in every part of a split message for its `[2/3]` marker. */
const PART_MARKER_RESERVE = 16;

// ---------------------------------------------------------------------------
// Markdown → entities
// ---------------------------------------------------------------------------

const EXPANDABLE_TAG_RE = /<expandable>([\s\S]*?)<\/expandable>/g;
const expandablePlaceholder = (i: number) => `XCGEXPANDABLEBLOCK${i}ENDX`;
const EXPANDABLE_PLACEHOLDER_RE = /^XCGEXPANDABLEBLOCK(\d+)ENDX$/;

/**
 * Pull `<expandable>` regions out before parsing, outside fenced code, so a
 * markdown parser that reads them as raw HTML can't split them across nodes.
 * Each leaves a placeholder paragraph of its own.
 */
function extractExpandableBlocks(text: string): { text: string; blocks: string[] } {
  const blocks: string[] = [];
  const parts = text.split(/(```[\s\S]*?```)/g);
  const processed = parts.map((segment, i) => {
    if (i % 2 === 1) return segment;
    return segment.replace(EXPANDABLE_TAG_RE, (_, body: string) => {
      blocks.push(body.replace(/^\n+|\n+$/g, ''));
      return `\n\n${expandablePlaceholder(blocks.length - 1)}\n\n`;
    });
  });
  return { text: processed.join(''), blocks };
}

interface RenderContext {
  /** Inside a quote already: Telegram can't nest another one. */
  inQuote: boolean;
  /** Bodies of the `<expandable>` regions, by placeholder number. */
  expandables: string[];
}

/** Convert markdown to a Telegram message: plain text plus entities. */
export function markdownToEntities(markdown: string): EntityMessage {
  const { text, blocks } = extractExpandableBlocks(markdown);
  return trimMessage(renderMarkdown(text, { inQuote: false, expandables: blocks }));
}

function renderMarkdown(markdown: string, ctx: RenderContext): EntityMessage {
  let tree;
  try {
    tree = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  } catch (error) {
    // The parser accepts any string; this is belt and braces. Plain text is
    // the one rendering that can't be refused.
    console.error('[Markdown] Parse failed, sending as plain text:', error);
    return { text: markdown, entities: [] };
  }
  return renderBlocks(tree.children, ctx, '\n\n');
}

function renderBlocks(nodes: RootContent[], ctx: RenderContext, separator: string): EntityMessage {
  const b = new EntityText();
  let first = true;
  for (const node of nodes) {
    const rendered = renderBlock(node, ctx);
    if (rendered === null) continue;
    if (!first) b.add(separator);
    b.append(rendered);
    first = false;
  }
  return b.build();
}

/** One block-level node, or null for one that renders nothing (a link definition). */
function renderBlock(node: RootContent, ctx: RenderContext): EntityMessage | null {
  const b = new EntityText();
  switch (node.type) {
    case 'paragraph': {
      const placeholder = paragraphPlaceholder(node.children);
      if (placeholder !== null) return renderExpandable(ctx.expandables[placeholder] ?? '', ctx);
      renderInline(b, node.children);
      return b.build();
    }
    case 'heading':
      b.wrap('bold', (inner) => renderInline(inner, node.children));
      return b.build();
    case 'thematicBreak':
      return b.add('———').build();
    case 'code':
      // An empty block has nothing to show, and a `pre` over nothing is refused.
      if (!node.value) return null;
      return b.pre(node.value, node.lang ?? undefined).build();
    case 'blockquote': {
      const inner = renderBlocks(node.children, { ...ctx, inQuote: true }, '\n');
      if (ctx.inQuote) return inner;
      return b.quote(inner).build();
    }
    case 'list':
      return renderList(node, ctx);
    case 'table':
      return renderTable(node);
    case 'html':
      return b.add(node.value).build();
    case 'definition':
      return null;
    case 'footnoteDefinition': {
      b.add(`[^${node.identifier}]: `);
      b.append(indentMessage(renderBlocks(node.children, ctx, '\n'), '  ', true));
      return b.build();
    }
    default:
      // Anything phrasing-level that turns up at block level.
      renderInline(b, [node as PhrasingContent]);
      return b.build();
  }
}

function paragraphPlaceholder(children: PhrasingContent[]): number | null {
  if (children.length !== 1 || children[0].type !== 'text') return null;
  const match = EXPANDABLE_PLACEHOLDER_RE.exec(children[0].value.trim());
  return match ? Number(match[1]) : null;
}

function renderExpandable(body: string, ctx: RenderContext): EntityMessage | null {
  const inner = trimMessage(renderMarkdown(body, { ...ctx, inQuote: true }));
  if (!inner.text) return null;
  if (ctx.inQuote) return inner;
  return new EntityText().quote(inner, true).build();
}

function renderList(list: List, ctx: RenderContext): EntityMessage {
  const b = new EntityText();
  const start = list.start ?? 1;
  list.children.forEach((item, i) => {
    if (i > 0) b.newline();
    b.append(renderListItem(item, list.ordered ? `${start + i}.  ` : '•   ', ctx));
  });
  return b.build();
}

function renderListItem(item: ListItem, marker: string, ctx: RenderContext): EntityMessage {
  const b = new EntityText().add(marker);
  if (item.checked === true) b.add('☑ ');
  else if (item.checked === false) b.add('☐ ');
  const body = renderBlocks(item.children, ctx, '\n');
  // Continuation lines — a second paragraph, a nested list — sit indented
  // under the item rather than flush with the margin.
  return b.append(indentMessage(body, '  ', true)).build();
}

/**
 * A table as one block per data row, each cell on a line of its own under its
 * column's header in bold. A table with a header row only lists the headers.
 */
function renderTable(table: Table): EntityMessage {
  const [headerRow, ...rows] = table.children;
  const headers = headerRow?.children ?? [];
  const b = new EntityText();
  if (rows.length === 0) {
    headers.forEach((cell, i) => {
      if (i > 0) b.newline();
      b.add('- ');
      renderInline(b, cell.children);
    });
    return b.build();
  }
  rows.forEach((row, r) => {
    if (r > 0) b.newline(2);
    let firstLine = true;
    row.children.forEach((cell, c) => {
      if (cell.children.length === 0) return;
      if (!firstLine) b.newline();
      firstLine = false;
      const header = headers[c];
      if (header && header.children.length > 0) {
        // The label is bold already, so a header that is bold in the markdown
        // too doesn't need a second bold inside the first.
        b.wrap('bold', (inner) => renderInline(inner, withoutStrong(header.children)));
        b.add(': ');
      }
      renderInline(b, cell.children);
    });
  });
  return b.build();
}

function withoutStrong(nodes: PhrasingContent[]): PhrasingContent[] {
  return nodes.flatMap((n) => (n.type === 'strong' ? withoutStrong(n.children) : [n]));
}

function renderInline(b: EntityText, nodes: PhrasingContent[]): void {
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        b.add(node.value);
        break;
      case 'strong':
        b.wrap('bold', (inner) => renderInline(inner, node.children));
        break;
      case 'emphasis':
        b.wrap('italic', (inner) => renderInline(inner, node.children));
        break;
      case 'delete':
        b.wrap('strikethrough', (inner) => renderInline(inner, node.children));
        break;
      case 'inlineCode':
        b.code(node.value);
        break;
      case 'break':
        b.newline();
        break;
      case 'link':
        renderLink(b, node.url, node.children);
        break;
      case 'image':
        b.link(node.alt || node.url, node.url);
        break;
      case 'linkReference':
      case 'imageReference':
        // An unresolved reference: what the model typed, minus the brackets.
        if ('children' in node) renderInline(b, node.children);
        else b.add(node.alt ?? '');
        break;
      case 'footnoteReference':
        b.add(`[^${node.identifier}]`);
        break;
      case 'html':
        b.add(node.value);
        break;
      default:
        b.add(textOf(node));
    }
  }
}

/**
 * A link keeps the formatting inside its label. One Telegram won't take (see
 * {@link EntityText.link}) is written out as its label and address instead.
 */
function renderLink(b: EntityText, url: string, children: PhrasingContent[]): void {
  const label = children.map(textOf).join('');
  if (!isLinkableUrl(url)) {
    b.link(label, url);
    return;
  }
  if (!label) {
    b.link(url, url);
    return;
  }
  b.wrap('text_link', (inner) => renderInline(inner, children), { url } as Partial<MessageEntity>);
}

function textOf(node: Nodes): string {
  if ('value' in node && typeof node.value === 'string') return node.value;
  if ('children' in node) return (node as Parents).children.map((c) => textOf(c as Nodes)).join('');
  if (node.type === 'image') return node.alt ?? '';
  return '';
}

// ---------------------------------------------------------------------------
// Splitting
// ---------------------------------------------------------------------------

/**
 * Split a message into parts Telegram will take: at most `maxLength` code
 * units and {@link MAX_ENTITIES} entities each. Parts break at a paragraph, a
 * line or a word where one is near enough to the limit, and anywhere at all
 * otherwise — formatting that runs across a break continues on the other side,
 * a code block included. With more than one part, each ends in `[n/total]`.
 */
export function splitEntityMessage(
  message: EntityMessage,
  maxLength = MAX_MESSAGE_LENGTH,
  { markers = true }: { markers?: boolean } = {},
): EntityMessage[] {
  let rest = trimMessage(message);
  if (fits(rest, maxLength)) return [rest];

  const budget = Math.max(1, maxLength - (markers ? PART_MARKER_RESERVE : 0));
  // The marker is an entity too.
  const entityBudget = markers ? MAX_ENTITIES - 1 : MAX_ENTITIES;
  const parts: EntityMessage[] = [];
  while (!fits(rest, budget, entityBudget)) {
    const cut = findCut(rest, budget, entityBudget);
    const part = trimMessage(sliceMessage(rest, 0, cut));
    if (part.text) parts.push(part);
    rest = trimLeading(sliceMessage(rest, cut));
  }
  rest = trimMessage(rest);
  if (rest.text) parts.push(rest);

  if (parts.length <= 1 || !markers) return parts;
  return parts.map((part, i) => {
    const b = new EntityText().append(part).newline(2).italic(`[${i + 1}/${parts.length}]`);
    return b.length <= maxLength ? b.build() : part;
  });
}

function fits(message: EntityMessage, maxLength: number, maxEntities = MAX_ENTITIES): boolean {
  return message.text.length <= maxLength && message.entities.length <= maxEntities;
}

/**
 * Where to end the next part. Prefers the last paragraph break, then line
 * break, then space, in the back half of the window; inside a code block only
 * a line break, so no line of code is cut in two unless it has to be.
 */
function findCut(message: EntityMessage, budget: number, entityBudget: number): number {
  const { text, entities } = message;
  let limit = Math.min(budget, text.length);

  if (entities.length > entityBudget) {
    // End the part before the first entity it has no room for.
    const starts = entities.map((e) => e.offset).sort((a, b) => a - b);
    const overflowAt = starts[entityBudget];
    if (overflowAt > 0) limit = Math.min(limit, overflowAt);
  }
  if (limit >= text.length) return text.length;

  const window = text.slice(0, limit);
  const half = limit / 2;
  const inPre = entities.some((e) => e.type === 'pre' && e.offset < limit && e.offset + e.length > limit);

  let cut = limit;
  const breaks = inPre ? ['\n'] : ['\n\n', '\n', ' '];
  for (const sep of breaks) {
    const at = window.lastIndexOf(sep);
    if (at > half) {
      cut = at + sep.length;
      break;
    }
  }
  if (cut > 1 && cut < text.length && isHighSurrogate(text.charCodeAt(cut - 1))) cut--;
  return Math.max(1, cut);
}

/**
 * Drop whitespace from the front of the next part — but inside a code block
 * only newlines, since the spaces there are the code's indentation.
 */
function trimLeading(message: EntityMessage): EntityMessage {
  const startsInPre = message.entities.some((e) => e.type === 'pre' && e.offset === 0);
  const match = (startsInPre ? /^\n+/ : /^\s+/).exec(message.text);
  return match ? sliceMessage(message, match[0].length) : message;
}

/** Markdown to the message parts it is sent as. */
export function formatMarkdown(markdown: string, maxLength = MAX_MESSAGE_LENGTH): EntityMessage[] {
  return splitEntityMessage(markdownToEntities(markdown), maxLength);
}
