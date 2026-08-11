import { describe, it, expect } from 'vitest';
import { parseClaudeVersion, isAtLeast } from '../../src/utils/claude-version.js';

describe('parseClaudeVersion', () => {
  it('reads the version out of the CLI banner', () => {
    expect(parseClaudeVersion('2.1.226 (Claude Code)\n')).toMatchObject({
      major: 2,
      minor: 1,
      patch: 226,
      raw: '2.1.226',
    });
  });

  it('returns undefined when the output carries no version', () => {
    expect(parseClaudeVersion('command not found')).toBeUndefined();
    expect(parseClaudeVersion('')).toBeUndefined();
  });
});

describe('isAtLeast', () => {
  const MIN = [2, 1, 220] as const;
  const v = (raw: string) => parseClaudeVersion(raw);

  it('accepts the exact minimum and anything above it', () => {
    expect(isAtLeast(v('2.1.220'), MIN)).toBe(true);
    expect(isAtLeast(v('2.1.226'), MIN)).toBe(true);
    expect(isAtLeast(v('2.2.0'), MIN)).toBe(true);
    expect(isAtLeast(v('3.0.0'), MIN)).toBe(true);
  });

  it('rejects anything below it', () => {
    expect(isAtLeast(v('2.1.140'), MIN)).toBe(false);
    expect(isAtLeast(v('2.0.999'), MIN)).toBe(false);
    expect(isAtLeast(v('1.9.9'), MIN)).toBe(false);
  });

  it('compares numerically, not lexically', () => {
    // "2.1.99" > "2.1.220" as strings; the point of parsing is that it isn't.
    expect(isAtLeast(v('2.1.99'), MIN)).toBe(false);
  });

  it('treats an unreadable version as too old', () => {
    expect(isAtLeast(undefined, MIN)).toBe(false);
  });
});
