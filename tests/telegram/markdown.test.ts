import { describe, it, expect } from 'vitest';
import { convertToTelegramMarkdown, escapeMarkdownV2, escapeMarkdownV2Code } from '../../src/telegram/markdown.js';

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
