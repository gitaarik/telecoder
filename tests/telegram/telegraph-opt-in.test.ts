/**
 * Telegraph is opt-in: every page is public on telegra.ph, so with
 * TELEGRAPH_ENABLED unset nothing is published and long replies go out as
 * chunked messages. The suite's env (vitest.config.ts) leaves it unset, so
 * these run against the real default.
 */

import { describe, it, expect } from 'vitest';

const { config } = await import('../../src/config.js');
const { shouldPublishTelegraph } = await import('../../src/telegram/telegraph.js');
const { isTelegraphEnabled, setTelegraphEnabled } = await import('../../src/telegram/telegraph-settings.js');
const { formatMarkdown } = await import('../../src/telegram/markdown.js');

describe('Telegraph default', () => {
  it('is off when TELEGRAPH_ENABLED is unset', () => {
    expect(config.TELEGRAPH_ENABLED).toBe(false);
  });

  it('publishes nothing, however long the reply', () => {
    expect(shouldPublishTelegraph('x'.repeat(20_000))).toBe(false);
    expect(shouldPublishTelegraph('x'.repeat(20_000), 'opt-in-test')).toBe(false);
  });

  it('keeps a chat that turned it on from publishing while the global switch is off', () => {
    setTelegraphEnabled('opt-in-test', true);
    expect(isTelegraphEnabled('opt-in-test')).toBe(false);
  });

  it('still delivers a long reply in full, as chunked messages', () => {
    const paragraph = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. ';
    const reply = Array.from({ length: 200 }, (_, i) => `Paragraph ${i}: ${paragraph}`).join('\n\n');
    const parts = formatMarkdown(reply, config.MAX_MESSAGE_LENGTH);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.text.length).toBeLessThanOrEqual(config.MAX_MESSAGE_LENGTH);
    const joined = parts.map((p) => p.text).join('\n\n');
    expect(joined).toContain("Paragraph 0: Lorem");
    expect(joined).toContain("Paragraph 199: Lorem");
  });
});
