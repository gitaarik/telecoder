import { describe, it, expect } from 'vitest';
import { fmtTokens, formatCompactionConfirmation } from '../../src/utils/format.js';

describe('fmtTokens', () => {
  it('formats by magnitude', () => {
    expect(fmtTokens(999)).toBe('999');
    expect(fmtTokens(23_044)).toBe('23.0k');
    expect(fmtTokens(1_500_000)).toBe('1.5M');
  });
});

describe('formatCompactionConfirmation', () => {
  it('reports the reduction when both sizes are known', () => {
    expect(formatCompactionConfirmation({ preTokens: 23_044, postTokens: 1_919 }))
      .toBe('🗜️ Context compacted — 23.0k → 1.9k tokens.');
  });

  it('omits the arrow when the build reported no post-compaction size', () => {
    expect(formatCompactionConfirmation({ preTokens: 23_044 }))
      .toBe('🗜️ Context compacted — was 23.0k tokens.');
    expect(formatCompactionConfirmation({ preTokens: 23_044, postTokens: 0 }))
      .toBe('🗜️ Context compacted — was 23.0k tokens.');
  });
});
