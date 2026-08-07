import { describe, it, expect, afterEach, vi } from 'vitest';
import { fmtTokens, getProgressBar } from '../../src/utils/format.js';
import {
  extractRedditUrl,
  getAutoVRedditUrl,
  formatResetIn,
} from '../../src/bot/handlers/message.handler.js';

describe('fmtTokens', () => {
  it('renders small counts verbatim', () => {
    expect(fmtTokens(0)).toBe('0');
    expect(fmtTokens(999)).toBe('999');
  });

  it('renders thousands with a k suffix', () => {
    expect(fmtTokens(1_000)).toBe('1.0k');
    expect(fmtTokens(12_500)).toBe('12.5k');
  });

  it('renders millions with an M suffix', () => {
    expect(fmtTokens(1_000_000)).toBe('1.0M');
    expect(fmtTokens(2_350_000)).toBe('2.4M');
  });
});

describe('getProgressBar', () => {
  it('uses green below 60%, yellow 60-79%, red at/above 80%', () => {
    expect(getProgressBar(10).startsWith('🟢')).toBe(true);
    expect(getProgressBar(65).startsWith('🟡')).toBe(true);
    expect(getProgressBar(85).startsWith('🔴')).toBe(true);
  });

  it('renders ten cells, filled proportionally', () => {
    expect(getProgressBar(0)).toBe('🟢 [' + '░'.repeat(10) + ']');
    expect(getProgressBar(50)).toBe('🟢 [' + '█'.repeat(5) + '░'.repeat(5) + ']');
    expect(getProgressBar(100)).toBe('🔴 [' + '█'.repeat(10) + ']');
  });

  it('clamps out-of-range percentages', () => {
    expect(getProgressBar(-20)).toBe(getProgressBar(0));
    expect(getProgressBar(150)).toBe(getProgressBar(100));
  });
});

describe('extractRedditUrl', () => {
  it('finds reddit.com / subdomain / short-link / video hosts', () => {
    expect(extractRedditUrl('see https://reddit.com/r/x')).toBe('https://reddit.com/r/x');
    expect(extractRedditUrl('https://www.reddit.com/r/x/comments/1')).toBe(
      'https://www.reddit.com/r/x/comments/1',
    );
    expect(extractRedditUrl('https://redd.it/abc')).toBe('https://redd.it/abc');
    expect(extractRedditUrl('https://v.redd.it/xyz')).toBe('https://v.redd.it/xyz');
  });

  it('returns null when there is no reddit url', () => {
    expect(extractRedditUrl('just text')).toBeNull();
    expect(extractRedditUrl('https://example.com/r/x')).toBeNull();
  });

  it('does not match a lookalike host (notreddit.com)', () => {
    expect(extractRedditUrl('https://notreddit.com/r/x')).toBeNull();
  });
});

describe('getAutoVRedditUrl', () => {
  // VREDDIT_ENABLED defaults to true in the test env.
  it('returns the url for a solo reddit link', () => {
    expect(getAutoVRedditUrl('https://v.redd.it/abc')).toBe('https://v.redd.it/abc');
  });

  it('returns the url when the message explicitly asks for vreddit', () => {
    expect(getAutoVRedditUrl('vreddit https://reddit.com/r/x/comments/1')).toBe(
      'https://reddit.com/r/x/comments/1',
    );
  });

  it('returns null for a reddit link buried in a longer non-vreddit message', () => {
    expect(getAutoVRedditUrl('look at this https://reddit.com/r/x and tell me about it')).toBeNull();
  });

  it('ignores slash commands and empty input', () => {
    expect(getAutoVRedditUrl('/reddit https://v.redd.it/abc')).toBeNull();
    expect(getAutoVRedditUrl('   ')).toBeNull();
  });
});

describe('formatResetIn', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns empty string when no reset time or already passed', () => {
    expect(formatResetIn(undefined)).toBe('');
    expect(formatResetIn(Date.now() - 1000)).toBe('');
  });

  it('formats sub-hour resets in minutes', () => {
    const now = 1_000_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    expect(formatResetIn(now + 30 * 60_000)).toBe(' Resets in \\~30 min\\.');
  });

  it('formats multi-hour resets as hours and minutes', () => {
    const now = 1_000_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    expect(formatResetIn(now + (2 * 60 + 15) * 60_000)).toBe(' Resets in \\~2h 15m\\.');
  });

  it('omits the minute part on a whole-hour reset', () => {
    const now = 1_000_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    expect(formatResetIn(now + 3 * 60 * 60_000)).toBe(' Resets in \\~3h\\.');
  });
});
