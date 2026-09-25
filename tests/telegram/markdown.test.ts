import { describe, it, expect } from 'vitest';
import {
  convertToTelegramMarkdown,
  escapeMarkdownV2,
  escapeMarkdownV2Code,
  processMessageForTelegram,
  splitMessage,
} from '../../src/telegram/markdown.js';

describe('convertToTelegramMarkdown — blockquotes', () => {
  // Regression: the telegram-markdown-v2 library escapes the `>` marker and
  // double-escapes blockquote content, so quotes used to render as literal
  // `\.`/`\-`/`*bold*` garbage. We extract and re-emit quotes ourselves.

  it('keeps the > marker unescaped (a real Telegram blockquote)', () => {
    const out = convertToTelegramMarkdown('> hello world');
    expect(out.startsWith('>')).toBe(true);
    expect(out).not.toContain('\\>');
  });

  it('single-escapes punctuation inside a quote (no double-escaping)', () => {
    const out = convertToTelegramMarkdown('> release v0.5.72 (safe) - go.');
    // Single escapes render as the literal char; no `\\` literal backslashes leak.
    expect(out).toContain('v0\\.5\\.72');
    expect(out).toContain('\\(safe\\)');
    expect(out).not.toContain('\\\\'); // no literal backslash would reach the user
  });

  it('preserves bold/italic formatting inside a quote', () => {
    const out = convertToTelegramMarkdown('> **bold** and _italic_ text');
    expect(out).toContain('*bold*');
    expect(out).toContain('_italic_');
    expect(out).not.toContain('\\*');
    expect(out).not.toContain('\\_');
  });

  it('prefixes every line of a multi-line quote with >', () => {
    const out = convertToTelegramMarkdown('> first line\n> second line\n> third line');
    const lines = out.trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines.every((l) => l.startsWith('>'))).toBe(true);
  });

  it('leaves surrounding non-quote text intact', () => {
    const out = convertToTelegramMarkdown('Intro.\n\n> quoted line\n\nOutro at v2.0.');
    expect(out).toContain('Intro\\.');
    expect(out).toContain('>quoted line');
    expect(out).toContain('Outro at v2\\.0\\.');
  });

  it('does not treat > inside a fenced code block as a quote', () => {
    const out = convertToTelegramMarkdown('```\n> not a quote\n```');
    expect(out).toContain('```\n> not a quote\n```');
  });

  it('matches a quote line with up to 3 leading spaces', () => {
    const out = convertToTelegramMarkdown('   > indented quote');
    expect(out).toContain('>indented quote');
    expect(out).not.toContain('\\>');
  });

  it('puts a quote under a list item at the start of its line', () => {
    // Regression: convert() indents the quote as the list item's continuation,
    // and Telegram rejects a `>` anywhere but the start of a line — so the
    // whole message went out as plain text.
    const out = convertToTelegramMarkdown('1. **No need to reply.** One line is enough:\n   > Hi Rodrigo, thanks.\n2. Next.');
    expect(out).toMatch(/^>Hi Rodrigo, thanks\\\.$/m);
    expect(out).not.toMatch(/^[ \t]+>/m);
  });

  it('puts every line of a multi-line quote under a list item at the start of its line', () => {
    const out = convertToTelegramMarkdown('- Intro:\n  > line one\n  > line two\n- Next.');
    expect(out).toMatch(/^>line one\n>line two$/m);
    expect(out).not.toMatch(/^[ \t]+>/m);
  });
});

describe('convertToTelegramMarkdown — expandable quotes', () => {
  it('puts a collapsible quote on a list item line at the start of its line', () => {
    const out = convertToTelegramMarkdown('1. Intro: <expandable>hidden\nmore</expandable>\n2. Next.');
    expect(out).toMatch(/^\*\*>hidden\n>more\|\|$/m);
  });

  it('keeps a $ in the quote as written', () => {
    const out = convertToTelegramMarkdown("<expandable>costs $$5, or $' more</expandable>");
    expect(out).toContain("costs $$5, or $' more");
  });
});

describe('splitMessage — a code block cut across parts', () => {
  // Regression: the part after a cut inside a code block ended with a stray
  // fence. Telegram rejected it ("Can't find end of Pre entity") and the part
  // went out as plain text — which is why the last message of a long reply
  // lost its formatting.

  const fences = (part: string) => (part.match(/```/g) ?? []).length;
  const prose = 'A line of prose\\.\n'.repeat(190); // 3420 chars of MarkdownV2
  const codeBlock = '```bash\n' + Array.from({ length: 60 }, (_, i) => `    echo line ${i}`).join('\n') + '\n```\n';

  it('closes the block in one part and reopens it in the next', () => {
    const parts = splitMessage(`${prose}\n${codeBlock}\n*Done\\.*`, 4000);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatch(/\n```$/);
    expect(parts[1].startsWith('```bash\n')).toBe(true);
  });

  it('leaves the last part with balanced fences', () => {
    const parts = splitMessage(`${prose}\n${codeBlock}\n*Done\\.*`, 4000);
    expect(fences(parts[1]) % 2).toBe(0);
    expect(parts[1]).toMatch(/\*Done\\\.\*\n\n_\\\[2\/2\\\]_$/);
  });

  it('keeps every part balanced when more than one cut lands in a code block', () => {
    // The part after the first cut used to read its own reopening fence as a
    // closer, so every fence after it was counted the wrong way round.
    const parts = splitMessage(`${prose}${codeBlock}${prose}${codeBlock}*Done\\.*`, 4000);
    expect(parts).toHaveLength(3);
    expect(parts.slice(1).every((p) => p.startsWith('```bash\n'))).toBe(true);
    for (const part of parts) expect(fences(part) % 2).toBe(0);
  });

  it('keeps the indentation of the first line of code after the cut', () => {
    const parts = splitMessage(`${prose}\n${codeBlock}`, 4000);
    expect(parts[1]).toMatch(/^```bash\n {4}echo line \d+\n/);
  });

  it('holds end to end, from markdown to the parts that are sent', () => {
    const markdown = 'A line of prose.\n\n'.repeat(190) + codeBlock + '\n**Done.**';
    const parts = processMessageForTelegram(markdown, 4000);
    expect(parts).toHaveLength(2);
    expect(parts[1].startsWith('```\n')).toBe(true); // the cut landed in the code block
    for (const part of parts) expect(fences(part) % 2).toBe(0);
  });
});

describe('escapeMarkdownV2Code', () => {
  it('leaves the characters a code span renders literally alone', () => {
    expect(escapeMarkdownV2Code('/code-review')).toBe('/code-review');
    expect(escapeMarkdownV2Code('/model [name]')).toBe('/model [name]');
    expect(escapeMarkdownV2Code('.claude/commands/')).toBe('.claude/commands/');
  });

  it('escapes only the two characters that carry meaning inside a code span', () => {
    expect(escapeMarkdownV2Code('a`b')).toBe('a\\`b');
    expect(escapeMarkdownV2Code('a\\b')).toBe('a\\\\b');
  });

  it('differs from the general escaper, which would add visible backslashes', () => {
    expect(escapeMarkdownV2('/code-review')).toBe('/code\\-review');
    expect(escapeMarkdownV2Code('/code-review')).toBe('/code-review');
  });
});
