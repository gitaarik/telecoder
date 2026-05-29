import { describe, it, expect } from 'vitest';
import { stripJsonComments, expandName } from '../../src/utils/instance-config.js';

describe('stripJsonComments', () => {
  it('removes full-line // comments', () => {
    const input = '// header comment\n{\n  "a": 1\n}';
    const out = stripJsonComments(input);
    expect(out).not.toContain('header comment');
    expect(JSON.parse(out)).toEqual({ a: 1 });
  });

  it('removes indented comment lines', () => {
    const input = '{\n    // note\n  "a": 1\n}';
    expect(JSON.parse(stripJsonComments(input))).toEqual({ a: 1 });
  });

  it('does not strip // inside string values (not a full-line comment)', () => {
    const input = '{ "url": "http://example.com" }';
    expect(stripJsonComments(input)).toBe(input);
  });
});

describe('expandName', () => {
  it('substitutes {n} with the raw index', () => {
    expect(expandName('bot-{n}', 3, 10)).toBe('bot-3');
  });

  it('pads {N} to the width of the total count', () => {
    expect(expandName('bot-{N}', 3, 10)).toBe('bot-03');
    expect(expandName('bot-{N}', 3, 100)).toBe('bot-003');
    expect(expandName('bot-{N}', 7, 9)).toBe('bot-7');
  });

  it('replaces all occurrences of both placeholders', () => {
    expect(expandName('{n}-{N}-{n}', 2, 10)).toBe('2-02-2');
  });

  it('leaves templates without placeholders unchanged', () => {
    expect(expandName('static', 1, 1)).toBe('static');
  });
});
