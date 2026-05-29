import { describe, it, expect, afterEach } from 'vitest';
import { isDuplicate, markProcessed, stopCleanup } from '../../src/telegram/deduplication.js';

describe('deduplication', () => {
  afterEach(() => {
    stopCleanup();
  });

  it('reports an unseen message as not duplicate', () => {
    expect(isDuplicate(1001)).toBe(false);
  });

  it('reports a message as duplicate once marked', () => {
    markProcessed(2002);
    expect(isDuplicate(2002)).toBe(true);
  });

  it('tracks distinct message ids independently', () => {
    markProcessed(3003);
    expect(isDuplicate(3003)).toBe(true);
    expect(isDuplicate(3004)).toBe(false);
  });

  it('stopCleanup is safe to call when no cleanup is running', () => {
    expect(() => stopCleanup()).not.toThrow();
  });
});
