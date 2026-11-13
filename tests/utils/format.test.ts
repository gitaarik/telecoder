import { describe, it, expect } from 'vitest';
import { contextHealthColor, fmtTokens, formatCompactionConfirmation, getProgressBar } from '../../src/utils/format.js';

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

describe('contextHealthColor', () => {
  it('goes by absolute size in a large window', () => {
    expect(contextHealthColor(100_000, 1_000_000)).toBe('🟢');
    expect(contextHealthColor(150_000, 1_000_000)).toBe('🟡');
    expect(contextHealthColor(300_000, 1_000_000)).toBe('🔴');
  });

  it('goes by share of the window when that comes first', () => {
    expect(contextHealthColor(100_000, 200_000)).toBe('🟢');
    expect(contextHealthColor(120_000, 200_000)).toBe('🟡');
    expect(contextHealthColor(160_000, 200_000)).toBe('🔴');
  });

  it('copes with an unknown window', () => {
    expect(contextHealthColor(50_000, 0)).toBe('🟢');
    expect(contextHealthColor(400_000, 0)).toBe('🔴');
  });
});

describe('getProgressBar colour override', () => {
  it('keeps the fill but takes the given colour', () => {
    expect(getProgressBar(20, '🔴')).toBe('🔴 [' + '█'.repeat(2) + '░'.repeat(8) + ']');
  });
});
