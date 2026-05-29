import { describe, it, expect } from 'vitest';
import {
  truncateToBytes,
  parseContextOutput,
  resumeCommandMessage,
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
