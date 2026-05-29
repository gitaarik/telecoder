import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  isStaleMessage,
  getUptimeSeconds,
  getUptimeFormatted,
} from '../../src/bot/middleware/stale-filter.js';

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

describe('uptime formatting', () => {
  afterEach(() => vi.restoreAllMocks());

  // BOT_START_TIME was captured at import; derive it (floored to the second)
  // so we can drive Date.now() to exact offsets past it.
  const startMs = Date.now() - getUptimeSeconds() * 1000;

  const at = (offsetSec: number) => {
    vi.spyOn(Date, 'now').mockReturnValue(startMs + offsetSec * 1000);
  };

  it('formats sub-minute uptime as seconds', () => {
    at(5);
    expect(getUptimeFormatted()).toBe('5s');
  });

  it('formats minutes and seconds', () => {
    at(90);
    expect(getUptimeFormatted()).toBe('1m 30s');
  });

  it('formats hours and minutes', () => {
    at(3 * 3600 + 15 * 60 + 4);
    expect(getUptimeFormatted()).toBe('3h 15m');
  });

  it('formats days and hours', () => {
    at(2 * 86400 + 5 * 3600 + 30 * 60);
    expect(getUptimeFormatted()).toBe('2d 5h');
  });
});
