import { describe, it, expect } from 'vitest';
import type { MessageEntity } from 'grammy/types';
import { markdownToEntities, splitEntityMessage, formatMarkdown, MAX_ENTITIES } from '../../src/telegram/markdown.js';
import type { EntityMessage } from '../../src/telegram/entities.js';

/** Each entity as `type:covered text`, in order — what a reader sees formatted. */
function spans(message: EntityMessage): string[] {
  return message.entities.map((e) => `${e.type}:${message.text.slice(e.offset, e.offset + e.length)}`);
}

function find(message: EntityMessage, type: MessageEntity['type']): MessageEntity | undefined {
  return message.entities.find((e) => e.type === type);
}

/** Every entity lies inside the text, the precondition for Telegram accepting it. */
function expectValid(message: EntityMessage): void {
  for (const e of message.entities) {
    expect(e.offset).toBeGreaterThanOrEqual(0);
    expect(e.length).toBeGreaterThan(0);
    expect(e.offset + e.length).toBeLessThanOrEqual(message.text.length);
  }
}

describe('markdownToEntities — inline formatting', () => {
  it('turns markers into entities and drops them from the text', () => {
    const m = markdownToEntities('Some **bold**, *italic*, ~~gone~~ and `code`.');
    expect(m.text).toBe('Some bold, italic, gone and code.');
    expect(spans(m)).toEqual(['bold:bold', 'italic:italic', 'strikethrough:gone', 'code:code']);
  });

  it('nests formatting inside a link', () => {
    const m = markdownToEntities('[see **this**](https://example.com/a_b)');
    expect(m.text).toBe('see this');
    expect(find(m, 'text_link')).toMatchObject({ offset: 0, length: 8, url: 'https://example.com/a_b' });
    expect(spans(m)).toContain('bold:this');
  });

  it('leaves characters MarkdownV2 reserved alone', () => {
    const m = markdownToEntities('a_b (c) [d] 1.5 - x! #tag {y} a|b');
    expect(m.text).toBe('a_b (c) [d] 1.5 - x! #tag {y} a|b');
    expect(m.entities).toEqual([]);
  });

  it('shows an unclosed marker as written, as a reply still being streamed has', () => {
    const m = markdownToEntities('This is **half wri');
    expect(m.text).toBe('This is **half wri');
    expect(m.entities).toEqual([]);
  });

  it('counts offsets in UTF-16 units past an emoji', () => {
    const m = markdownToEntities('🎉 **done**');
    expect(spans(m)).toEqual(['bold:done']);
  });
});

describe('markdownToEntities — links Telegram would refuse', () => {
  it('writes a localhost link out as text instead of linking it', () => {
    const m = markdownToEntities('Open [the app](http://localhost:3000/x) now');
    expect(m.text).toBe('Open the app (http://localhost:3000/x) now');
    expect(find(m, 'text_link')).toBeUndefined();
  });

  it('leaves a bare localhost URL as plain text', () => {
    const m = markdownToEntities('Running on http://localhost:3000');
    expect(m.text).toBe('Running on http://localhost:3000');
    expect(m.entities).toEqual([]);
  });

  it('refuses a bare IP and a single-label host too', () => {
    for (const url of ['http://127.0.0.1:8080/', 'http://devbox/x']) {
      expect(find(markdownToEntities(`[x](${url})`), 'text_link')).toBeUndefined();
    }
  });

  it('still links an ordinary web address', () => {
    expect(find(markdownToEntities('[x](https://telecoder.dev)'), 'text_link')).toMatchObject({ url: 'https://telecoder.dev' });
  });
});

describe('markdownToEntities — blocks', () => {
  it('shows a heading in bold, keeping formatting inside it', () => {
    const m = markdownToEntities('## Heading **two**\n\nBody');
    expect(m.text).toBe('Heading two\n\nBody');
    expect(spans(m)).toEqual(['bold:Heading two', 'bold:two']);
  });

  it('keeps a fenced block verbatim, with its language', () => {
    const m = markdownToEntities('```ts\nconst a = `x` * 2;\n```');
    expect(m.text).toBe('const a = `x` * 2;');
    expect(find(m, 'pre')).toMatchObject({ offset: 0, length: m.text.length, language: 'ts' });
  });

  it('marks list items with bullets and numbers, nesting indented', () => {
    const m = markdownToEntities('- one\n- **two**\n  - nested\n\n1. first\n2. second');
    expect(m.text).toBe('•   one\n•   two\n  •   nested\n\n1.  first\n2.  second');
    expect(spans(m)).toEqual(['bold:two']);
  });

  it('turns a quote into a blockquote entity with its formatting inside', () => {
    const m = markdownToEntities('> quote **b**\n> line 2');
    expect(m.text).toBe('quote b\nline 2');
    expect(spans(m)).toEqual(['blockquote:quote b\nline 2', 'bold:b']);
  });

  it('puts a quote under a list item inside the item', () => {
    const m = markdownToEntities('- item\n\n  > quoted');
    expect(m.text).toBe('•   item\n  quoted');
    expect(spans(m)).toEqual(['blockquote:quoted']);
  });

  it('collapses an <expandable> region into an expandable quote', () => {
    const m = markdownToEntities('Intro\n\n<expandable>line **one**\nline $two</expandable>\n\nOutro');
    expect(m.text).toBe('Intro\n\nline one\nline $two\n\nOutro');
    expect(spans(m)).toEqual(['expandable_blockquote:line one\nline $two', 'bold:one']);
  });

  it('leaves <expandable> inside a code block alone', () => {
    const m = markdownToEntities('```\n<expandable>x</expandable>\n```');
    expect(m.text).toBe('<expandable>x</expandable>');
  });

  it('draws a thematic break as a rule', () => {
    expect(markdownToEntities('a\n\n---\n\nb').text).toBe('a\n\n———\n\nb');
  });
});

describe('markdownToEntities — tables', () => {
  it('writes each row as lines that start with the header in bold', () => {
    const m = markdownToEntities('| Name | Age |\n|---|---|\n| Alice | 30 |\n| Bob | 4 |');
    expect(m.text).toBe('Name: Alice\nAge: 30\n\nName: Bob\nAge: 4');
    expect(spans(m)).toEqual(['bold:Name', 'bold:Age', 'bold:Name', 'bold:Age']);
  });

  it('keeps one bold on a header that is bold already', () => {
    const m = markdownToEntities('| **Name** | x |\n|---|---|\n| A | 1 |');
    expect(spans(m)).toEqual(['bold:Name', 'bold:x']);
  });

  it('keeps a code span in a header', () => {
    const m = markdownToEntities('| `a*b` | x |\n|---|---|\n| 1 | 2 |');
    expect(m.text.startsWith('a*b: 1')).toBe(true);
    expect(spans(m)).toContain('code:a*b');
  });
});

describe('splitEntityMessage', () => {
  const para = (i: number) => `Paragraph ${i} has **bold words** and \`code\` in it.`;

  it('sends a short message whole', () => {
    const m = markdownToEntities(para(1));
    expect(splitEntityMessage(m)).toEqual([m]);
  });

  it('keeps every part within the limit and marks it [n/total]', () => {
    const parts = formatMarkdown(Array.from({ length: 200 }, (_, i) => para(i)).join('\n\n'));
    expect(parts.length).toBeGreaterThan(1);
    parts.forEach((p, i) => {
      expect(p.text.length).toBeLessThanOrEqual(4096);
      expect(p.text.endsWith(`[${i + 1}/${parts.length}]`)).toBe(true);
      expectValid(p);
    });
  });

  it('carries formatting across a cut in the middle of it', () => {
    const m = markdownToEntities(`**${'word '.repeat(300).trim()}**`);
    const parts = splitEntityMessage(m, 500, { markers: false });
    expect(parts.length).toBeGreaterThan(2);
    for (const p of parts) {
      expect(p.entities).toHaveLength(1);
      expect(p.entities[0]).toMatchObject({ type: 'bold', offset: 0, length: p.text.length });
    }
  });

  it('continues a code block in the next part with its language, cut at a line', () => {
    const code = Array.from({ length: 200 }, (_, i) => `    line ${i}`).join('\n');
    const parts = splitEntityMessage(markdownToEntities('```py\n' + code + '\n```'), 1000, { markers: false });
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.entities).toEqual([{ type: 'pre', offset: 0, length: p.text.length, language: 'py' }]);
      // Whole lines only: every part ends where a line of code ends.
      expect(p.text).toMatch(/line \d+$/);
    }
  });

  it('never cuts an emoji in half', () => {
    const m = { text: '😀'.repeat(3000), entities: [] };
    for (const p of splitEntityMessage(m, 4096, { markers: false })) {
      expect(p.text.length % 2).toBe(0);
    }
  });

  it('starts a new part before Telegram would ignore an entity', () => {
    const m = markdownToEntities(Array.from({ length: 250 }, (_, i) => `**b${i}**`).join(' '));
    const parts = splitEntityMessage(m);
    expect(parts.length).toBeGreaterThan(2);
    for (const p of parts) expect(p.entities.length).toBeLessThanOrEqual(MAX_ENTITIES);
    expect(parts.reduce((n, p) => n + p.entities.filter((e) => e.type === 'bold').length, 0)).toBe(250);
  });

  it('cuts a link and keeps its address on both sides', () => {
    const m = markdownToEntities(`[${'x'.repeat(900)}](https://example.com)`);
    const parts = splitEntityMessage(m, 500, { markers: false });
    expect(parts.length).toBe(2);
    for (const p of parts) expect(p.entities[0]).toMatchObject({ type: 'text_link', url: 'https://example.com' });
  });
});
