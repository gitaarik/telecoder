/**
 * Coverage for the Telegraph hand-off after it stopped replacing replies.
 *
 * The old behaviour swapped any reply over 2500 chars — or one merely
 * containing a markdown table — for `text.substring(0, 200) + '...'` plus an
 * Instant View link. The answer itself never reached the chat, and the only way
 * back to it was `/recap`. Telegraph is now additive: the reply goes out in
 * full and the page URL rides underneath it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// The repo's own .env turns Telegraph off, so force the global switch on —
// the per-chat toggle below is what these tests are actually exercising.
vi.mock('../../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config.js')>();
  return { ...actual, config: { ...actual.config, TELEGRAPH_ENABLED: true } };
});

const telegraphEnabledForChat = vi.fn(() => true);
vi.mock('../../src/telegram/telegraph-settings.js', () => ({
  isTelegraphEnabled: (key: string) => telegraphEnabledForChat(key as never),
}));

const { shouldPublishTelegraph } = await import('../../src/telegram/telegraph.js');
const { withTelegraphFooter } = await import('../../src/telegram/message-sender.js');

const long = (n: number) => 'x'.repeat(n);

describe('shouldPublishTelegraph', () => {
  beforeEach(() => {
    telegraphEnabledForChat.mockReturnValue(true);
  });

  it('publishes a page for a reply past the length threshold', () => {
    expect(shouldPublishTelegraph(long(2501), '111')).toBe(true);
  });

  it('leaves a short reply alone', () => {
    expect(shouldPublishTelegraph(long(2500), '111')).toBe(false);
  });

  it('does not publish just because the reply contains a table', () => {
    const withTable = 'Here you go:\n\n| col | col |\n| --- | --- |\n| a | b |\n';
    expect(withTable.length).toBeLessThan(2500);
    expect(shouldPublishTelegraph(withTable, '111')).toBe(false);
  });

  it('honours the per-chat toggle', () => {
    telegraphEnabledForChat.mockReturnValue(false);
    expect(shouldPublishTelegraph(long(5000), '111')).toBe(false);
  });
});

describe('withTelegraphFooter', () => {
  const footer = '📄 [Open in Instant View](https://telegra\\.ph/abc)';

  it('returns the chunks untouched when there is no page', () => {
    const parts = ['one', 'two'];
    expect(withTelegraphFooter(parts, null)).toEqual(parts);
  });

  it('hangs the footer under the last chunk', () => {
    expect(withTelegraphFooter(['one', 'two'], footer)).toEqual([
      'one',
      `two\n\n${footer}`,
    ]);
  });

  it('gives the footer its own chunk rather than overflowing the last one', () => {
    const last = long(4096);
    const result = withTelegraphFooter(['first', last], footer);
    expect(result).toEqual(['first', last, footer]);
    expect(result.every((p) => p.length <= 4096)).toBe(true);
  });

  it('never drops a chunk of the reply', () => {
    const parts = ['a', 'b', long(4090)];
    const result = withTelegraphFooter(parts, footer);
    for (const part of parts) {
      expect(result.some((r) => r.startsWith(part))).toBe(true);
    }
  });
});
