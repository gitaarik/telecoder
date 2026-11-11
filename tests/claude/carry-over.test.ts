import { describe, it, expect } from 'vitest';
import { setPendingCarryOver, withPendingCarryOver } from '../../src/claude/carry-over.js';

describe('withPendingCarryOver', () => {
  it('puts the recap in front of the next prompt, once', () => {
    setPendingCarryOver('k1', 'RECAP');
    expect(withPendingCarryOver('k1', 'hello')).toBe('RECAP\n\nhello');
    expect(withPendingCarryOver('k1', 'again')).toBe('again');
  });

  it('lets a slash command through and keeps the recap for the prompt after it', () => {
    setPendingCarryOver('k2', 'RECAP');
    expect(withPendingCarryOver('k2', '/model opus')).toBe('/model opus');
    expect(withPendingCarryOver('k2', 'hello')).toBe('RECAP\n\nhello');
  });
});
