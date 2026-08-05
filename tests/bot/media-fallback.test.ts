import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  TELEGRAM_DOWNLOAD_LIMIT_MB,
  exceedsDownloadLimit,
  replyBareAudio,
  replyTooLargeToFetch,
  replyUnsupportedVideo,
} from '../../src/bot/handlers/media-fallback.js';

const MB = 1024 * 1024;

/** Minimal grammy Context stand-in: we only assert on what reply() received. */
function makeCtx() {
  const reply = vi.fn().mockResolvedValue({ message_id: 1 });
  return { ctx: { reply } as never, reply };
}

describe('exceedsDownloadLimit', () => {
  it('accepts a file just under the cap', () => {
    expect(exceedsDownloadLimit(19 * MB)).toBe(false);
  });

  it('accepts a file exactly at the cap', () => {
    expect(exceedsDownloadLimit(TELEGRAM_DOWNLOAD_LIMIT_MB * MB)).toBe(false);
  });

  it('rejects a file over the cap', () => {
    expect(exceedsDownloadLimit(21 * MB)).toBe(true);
  });

  it('rejects the 172MB upload that started this', () => {
    expect(exceedsDownloadLimit(172 * MB)).toBe(true);
  });

  it('treats a missing size as within the limit', () => {
    // Telegram omits file_size on some updates; don't reject on absence.
    expect(exceedsDownloadLimit(undefined)).toBe(false);
  });
});

describe('replyTooLargeToFetch', () => {
  let harness: ReturnType<typeof makeCtx>;
  beforeEach(() => { harness = makeCtx(); });

  it('names the size and the limit', async () => {
    await replyTooLargeToFetch(harness.ctx, 'Audio file', 172 * MB);

    // The size arrives MarkdownV2-escaped; the escaping itself is asserted below.
    const [text, opts] = harness.reply.mock.calls[0];
    expect(text).toContain('172');
    expect(text).toContain(String(TELEGRAM_DOWNLOAD_LIMIT_MB));
    expect(opts).toEqual({ parse_mode: 'MarkdownV2' });
  });

  it('escapes the MarkdownV2 metacharacters in the size', async () => {
    await replyTooLargeToFetch(harness.ctx, 'Audio file', 172 * MB);

    // Unescaped '(' or '.' makes Telegram reject the whole message with a 400,
    // which would put us right back to sending nothing.
    const [text] = harness.reply.mock.calls[0];
    expect(text).toContain('\\(172\\.0MB\\)');
  });

  it('omits the size when Telegram did not supply one', async () => {
    await replyTooLargeToFetch(harness.ctx, 'Audio file', undefined);

    const [text] = harness.reply.mock.calls[0];
    expect(text).not.toContain('MB\\)');
  });
});

describe('replyBareAudio', () => {
  let harness: ReturnType<typeof makeCtx>;
  beforeEach(() => { harness = makeCtx(); });

  it('points at /transcribe for a file within the limit', async () => {
    await replyBareAudio(harness.ctx, 5 * MB);

    const [text] = harness.reply.mock.calls[0];
    expect(text).toContain('/transcribe');
    expect(text).not.toContain('too large');
  });

  it('reports the ceiling instead for an oversized file', async () => {
    await replyBareAudio(harness.ctx, 172 * MB);

    const [text] = harness.reply.mock.calls[0];
    expect(text).toContain('too large');
    expect(text).toContain(String(TELEGRAM_DOWNLOAD_LIMIT_MB));
  });

  it('always answers — the silent drop is the bug being fixed', async () => {
    await replyBareAudio(harness.ctx, undefined);
    expect(harness.reply).toHaveBeenCalledOnce();
  });
});

describe('replyUnsupportedVideo', () => {
  let harness: ReturnType<typeof makeCtx>;
  beforeEach(() => { harness = makeCtx(); });

  it('says video is unsupported when within the limit', async () => {
    await replyUnsupportedVideo(harness.ctx, 5 * MB);

    const [text] = harness.reply.mock.calls[0];
    expect(text).toContain('Video');
    expect(text).not.toContain('too large');
  });

  it('reports the ceiling for an oversized video', async () => {
    await replyUnsupportedVideo(harness.ctx, 500 * MB);

    const [text] = harness.reply.mock.calls[0];
    expect(text).toContain('too large');
  });
});
