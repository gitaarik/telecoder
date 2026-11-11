import { describe, it, expect, vi } from 'vitest';
import { GrammyError, type Context } from 'grammy';
import { messageSender } from '../../src/telegram/message-sender.js';
import { SUGGESTION_CARD_BUTTON } from '../../src/telegram/prompt-suggestion.js';

const LONG = 'Run the full test suite and fix whatever fails in the PTY provider before touching the docs';

function fakeCtx(reply = vi.fn().mockResolvedValue({ message_id: 1 })) {
  return { reply, _reply: reply } as unknown as Context & { _reply: ReturnType<typeof vi.fn> };
}

describe('sendSuggestionCard', () => {
  it('writes the whole prompt into the body, where no clip can reach it', async () => {
    const ctx = fakeCtx();
    await messageSender.sendSuggestionCard(ctx, { id: 'abc', text: LONG, onButton: false });

    expect(ctx._reply).toHaveBeenCalledTimes(1);
    const [text, opts] = ctx._reply.mock.calls[0];
    expect(text).toContain(LONG);
    expect(text).not.toContain('…');
    expect(opts.reply_markup.inline_keyboard[0][0]).toEqual({
      text: SUGGESTION_CARD_BUTTON,
      callback_data: 'sgt:abc',
    });
  });

  it('does not ping — the response it follows already did', async () => {
    const ctx = fakeCtx();
    await messageSender.sendSuggestionCard(ctx, { id: 'abc', text: LONG, onButton: false });
    expect(ctx._reply.mock.calls[0][1].disable_notification).toBe(true);
  });

  it('stays out of the chat when the suggestion rode on its button', async () => {
    const ctx = fakeCtx();
    await messageSender.sendSuggestionCard(ctx, { id: 'abc', text: 'run the tests', onButton: true });
    expect(ctx._reply).not.toHaveBeenCalled();
  });

  it('no-ops for a turn with no suggestion', async () => {
    const ctx = fakeCtx();
    await messageSender.sendSuggestionCard(ctx, null);
    expect(ctx._reply).not.toHaveBeenCalled();
  });

  it('goes out with entities, never a parse mode', async () => {
    const ctx = fakeCtx();
    await messageSender.sendSuggestionCard(ctx, { id: 'abc', text: LONG, onButton: false });
    const [, opts] = ctx._reply.mock.calls[0];
    expect(opts.parse_mode).toBeUndefined();
    expect(Array.isArray(opts.entities)).toBe(true);
  });

  it('retries unformatted when Telegram refuses the entities, keeping the button', async () => {
    const refused = new GrammyError(
      "Call to 'sendMessage' failed!",
      { ok: false, error_code: 400, description: "Bad Request: can't parse entities" },
      'sendMessage',
      {},
    );
    const reply = vi.fn()
      .mockRejectedValueOnce(refused)
      .mockResolvedValueOnce({ message_id: 2 });
    const ctx = fakeCtx(reply);

    await messageSender.sendSuggestionCard(ctx, { id: 'abc', text: LONG, onButton: false });

    expect(reply).toHaveBeenCalledTimes(2);
    const [text, opts] = reply.mock.calls[1];
    expect(text).toContain(LONG);
    expect(opts.entities).toEqual([]);
    expect(opts.reply_markup.inline_keyboard[0][0].callback_data).toBe('sgt:abc');
  });

  it('swallows a second failure — the answer itself already landed', async () => {
    const reply = vi.fn().mockRejectedValue(new Error('nope'));
    const ctx = fakeCtx(reply);
    await expect(
      messageSender.sendSuggestionCard(ctx, { id: 'abc', text: LONG, onButton: false }),
    ).resolves.toBeUndefined();
  });
});
