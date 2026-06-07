import { describe, it, expect } from 'vitest';
import { isForeignThinkingSignature } from '../../src/claude/session-jsonl.js';

describe('isForeignThinkingSignature', () => {
  it('flags an empty signature (CCR placeholder for a missing one)', () => {
    expect(isForeignThinkingSignature('')).toBe(true);
  });

  it('flags a bare Unix-ms timestamp (CCR fabricated for DeepSeek reasoning)', () => {
    expect(isForeignThinkingSignature('1780826242641')).toBe(true);
  });

  it('accepts a genuine Anthropic base64 signature', () => {
    // Real signatures are long and contain non-digit base64 characters.
    const real =
      'CiIBDDnWx+Osf/cod7mpd27bkFpK+dJ2TV5kwbdJjqHIWhYvCmQBDDnWx2/kyacGt/hNXjfOY35PGHTg';
    expect(isForeignThinkingSignature(real)).toBe(false);
  });

  it('accepts any signature containing non-digit characters', () => {
    expect(isForeignThinkingSignature('abc123')).toBe(false);
  });
});
