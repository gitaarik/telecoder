import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Context } from 'grammy';

vi.mock('../../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config.js')>();
  return { ...actual, config: { ...actual.config, MESSAGE_BATCH_TIMEOUT_MS: 1500 } };
});

const { createBatchMiddleware, SPLIT_PART_MIN_LENGTH, wasBatched } =
  await import('../../src/bot/middleware/message-batcher.js');

function textCtx(text: string): Context {
  return { chat: { id: 1 }, message: { message_id: 1, text } } as unknown as Context;
}

const long = (c: string) => c.repeat(SPLIT_PART_MIN_LENGTH);

describe('message batcher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('lets a short message through at once', async () => {
    const next = vi.fn(async () => {});
    await createBatchMiddleware()(textCtx('hi'), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('merges the parts of a split paste into one message', async () => {
    const batch = createBatchMiddleware();
    const first = textCtx(long('a'));
    const next = vi.fn(async () => {});

    const done = batch(first, next);
    // The last part is short and this one starts like a path: both still join.
    await batch(textCtx('/home/rik/b'), next);
    await batch(textCtx('c'), next);
    expect(next).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1500);
    await done;

    expect(next).toHaveBeenCalledOnce();
    expect(first.message!.text).toBe(`${long('a')}\n/home/rik/b\nc`);
    expect(wasBatched(first.message!)).toBe(true);
  });

  it('sends a long message alone once no part follows', async () => {
    const ctx = textCtx(long('a'));
    const next = vi.fn(async () => {});
    const done = createBatchMiddleware()(ctx, next);
    await vi.advanceTimersByTimeAsync(1500);
    await done;
    expect(next).toHaveBeenCalledOnce();
    expect(wasBatched(ctx.message!)).toBe(false);
  });
});
