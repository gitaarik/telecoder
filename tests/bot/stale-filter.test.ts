import { describe, it, expect } from 'vitest';
import { isStaleMessage } from '../../src/bot/middleware/stale-filter.js';

describe('isStaleMessage', () => {
  it('treats a current message as fresh', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    expect(isStaleMessage(nowSec)).toBe(false);
  });

  it('treats a long-past message as stale', () => {
    expect(isStaleMessage(1_000_000)).toBe(true); // year 1970-ish
  });

  it('treats a message within the 30s grace window as fresh', () => {
    const tenSecAgo = Math.floor((Date.now() - 10_000) / 1000);
    expect(isStaleMessage(tenSecAgo)).toBe(false);
  });
});
