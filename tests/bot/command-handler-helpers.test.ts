import { describe, it, expect } from 'vitest';
import {
  truncateToBytes,
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
    expect(resumeCommandMessage('abc-123')).toEqual({
      text: 'claude --resume abc-123',
      entities: [{ type: 'code', offset: 0, length: 23 }],
    });
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
