import { describe, it, expect } from 'vitest';
import * as os from 'os';
import { sanitizePath, sanitizeError } from '../../src/utils/sanitize.js';

describe('sanitizePath', () => {
  it('replaces the home directory with ~', () => {
    const home = os.homedir();
    const input = `${home}/dev/secret/file.ts`;
    expect(sanitizePath(input)).toBe('~/dev/secret/file.ts');
  });

  it('replaces multiple occurrences of the home directory', () => {
    const home = os.homedir();
    const input = `${home}/a and ${home}/b`;
    expect(sanitizePath(input)).toBe('~/a and ~/b');
  });

  it('returns falsy input unchanged', () => {
    expect(sanitizePath('')).toBe('');
  });

  it('leaves unrelated strings untouched', () => {
    expect(sanitizePath('no paths here')).toBe('no paths here');
  });
});

describe('sanitizeError', () => {
  it('extracts and sanitizes an Error message', () => {
    const home = os.homedir();
    const err = new Error(`failed at ${home}/x.ts`);
    expect(sanitizeError(err)).toBe('failed at ~/x.ts');
  });

  it('sanitizes a raw string error', () => {
    const home = os.homedir();
    expect(sanitizeError(`${home}/y`)).toBe('~/y');
  });

  it('returns a generic message for unknown error shapes', () => {
    expect(sanitizeError({ weird: true })).toBe('Unknown error');
    expect(sanitizeError(null)).toBe('Unknown error');
    expect(sanitizeError(42)).toBe('Unknown error');
  });
});
