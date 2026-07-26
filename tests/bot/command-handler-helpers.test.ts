import { describe, it, expect } from 'vitest';
import {
  truncateToBytes,
  parseContextOutput,
  resumeCommandMessage,
  btwLabel,
  formatSideAnswer,
} from '../../src/bot/handlers/command.handler.js';

describe('truncateToBytes', () => {
  it('returns the string unchanged when it fits', () => {
    expect(truncateToBytes('hello', 10)).toBe('hello');
    expect(truncateToBytes('hello', 5)).toBe('hello');
  });

  it('truncates ASCII to the byte budget', () => {
    expect(truncateToBytes('hello world', 5)).toBe('hello');
  });

  it('never splits a multi-byte codepoint', () => {
    // '😀' is 4 UTF-8 bytes. With a 5-byte budget only one fits.
    const out = truncateToBytes('😀😀', 5);
    expect(out).toBe('😀');
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(5);
  });

  it('returns empty string when even the first char overflows', () => {
    expect(truncateToBytes('😀', 2)).toBe('');
  });
});

describe('resumeCommandMessage', () => {
  it('wraps the resume command in a code span', () => {
    expect(resumeCommandMessage('abc-123')).toBe('`claude --resume abc-123`');
  });
});

describe('parseContextOutput', () => {
  it('reports a warning for empty output', () => {
    expect(parseContextOutput('   ')).toBe('⚠️ No context output received.');
  });

  it('falls back to a fenced raw block when nothing parses', () => {
    const out = parseContextOutput('some random text\nwith no recognizable fields');
    expect(out).toContain('## 🧠 Context Usage');
    expect(out).toContain('```');
    expect(out).toContain('some random text');
  });

  it('extracts model and tokens lines', () => {
    const raw = 'Model: claude-opus-4\nTokens: 5000/200000';
    const out = parseContextOutput(raw);
    expect(out).toContain('**Model:** claude-opus-4');
    expect(out).toContain('**Tokens:** 5000/200000');
  });

  it('parses the category table into a bullet list', () => {
    const raw = [
      'Model: opus',
      'Tokens: 10k/200k',
      'Estimated usage by category',
      'Category        Tokens   Percent',
      '----------------------------------',
      'System prompt   2.5k     1.2%',
      'Messages        7.5k     3.8%',
    ].join('\n');
    const out = parseContextOutput(raw);
    expect(out).toContain('### Estimated usage by category');
    expect(out).toContain('**System prompt:** 2.5k (1.2%)');
    expect(out).toContain('**Messages:** 7.5k (3.8%)');
  });
});

describe('btwLabel', () => {
  it('leaves a short question intact', () => {
    expect(btwLabel('what about the RAG plans?')).toBe('what about the RAG plans?');
  });

  it('collapses newlines and runs of whitespace', () => {
    expect(btwLabel('what about\n\n  the   plans?  ')).toBe('what about the plans?');
  });

  it('strips formatting characters that would unbalance the italic run', () => {
    expect(btwLabel('what about *this* and _that_ and `code` and [links]'))
      .toBe('what about this and that and code and links');
  });

  it('truncates to 80 characters with an ellipsis', () => {
    const out = btwLabel('x'.repeat(200));
    expect(out).toHaveLength(80);
    expect(out.endsWith('…')).toBe(true);
  });

  it('does not truncate a question exactly at the limit', () => {
    const exact = 'y'.repeat(80);
    expect(btwLabel(exact)).toBe(exact);
  });
});

describe('formatSideAnswer', () => {
  it('labels the answer so it cannot be mistaken for the running turn', () => {
    const out = formatSideAnswer('what about the RAG plans?', 'Looks solid.');
    expect(out).toBe('💬 **/btw** — _what about the RAG plans?_\n\nLooks solid.');
  });

  it('sanitizes the echoed question inside the italic run', () => {
    const out = formatSideAnswer('why *this* way?', 'Because.');
    expect(out).toBe('💬 **/btw** — _why this way?_\n\nBecause.');
  });
});
