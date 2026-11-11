/**
 * Coverage for showing the reply while it is being written.
 *
 * The reply used to reach the chat only when the turn ended. It is now edited
 * into the status bubble as it grows, formatted, with the status line (or a
 * "Writing" line) under it as the sign that it isn't final, and overflows into
 * messages of its own past Telegram's limit. The final text then takes the
 * place of the live one.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GrammyError, type Context } from 'grammy';

const isTerminalUIEnabled = vi.fn((_sessionKey: string) => false);
vi.mock('../../src/telegram/terminal-settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/telegram/terminal-settings.js')>()),
  isTerminalUIEnabled: (sessionKey: string) => isTerminalUIEnabled(sessionKey),
}));

// No action log: the reply is edited into the bubble.
vi.mock('../../src/utils/verbosity.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/verbosity.js')>()),
  resolveVerbosityFlags: () => ({
    showUsageFooter: true,
    notifyCompaction: true,
    terminalUiVerbose: false,
    sendCompletionPing: true,
    showToolResults: false,
    toolResultMaxLines: 20,
    toolResultMaxChars: 2000,
    showDiffs: false,
    diffMaxLines: 25,
    useActionLog: false,
  }),
}));

vi.mock('../../src/telegram/telegraph-settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/telegram/telegraph-settings.js')>()),
  isTelegraphEnabled: () => false,
}));

const { MessageSender } = await import('../../src/telegram/message-sender.js');

const BUBBLE = 50;
let nextId = 60;

function fakeChat(chatId: number, type: 'private' | 'supergroup' = 'private') {
  const api = {
    sendMessage: vi.fn(async () => ({ message_id: nextId++ })),
    editMessageText: vi.fn(async (..._args: unknown[]) => true),
    editMessageReplyMarkup: vi.fn(async () => true),
    deleteMessage: vi.fn(async () => true),
    sendChatAction: vi.fn(async () => true),
  };
  let replies = 0;
  const reply = vi.fn(async (..._args: unknown[]) => ({ message_id: replies++ === 0 ? BUBBLE : nextId++ }));
  const ctx = { chat: { id: chatId, type }, message: { message_id: 1 }, api, reply } as unknown as Context;
  /** Every [text, options] `messageId` was edited to, in order. */
  const edits = (messageId: number) => api.editMessageText.mock.calls
    .filter((call) => call[1] === messageId)
    .map((call) => ({ text: call[2] as string, other: call[3] as { entities?: unknown[]; parse_mode?: string } }));
  return { ctx, api, reply, edits };
}

describe('live reply', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    isTerminalUIEnabled.mockReturnValue(false);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('edits the reply into the bubble, formatted, with a Writing line under it', async () => {
    const sender = new MessageSender();
    const chat = fakeChat(101);
    await sender.startStreaming(chat.ctx, 'hi');
    vi.advanceTimersByTime(2000);

    sender.updateStream(chat.ctx, 'Here is **the** answer');
    await vi.advanceTimersByTimeAsync(0);

    const [edit] = chat.edits(BUBBLE);
    expect(edit.text).toBe('Here is the answer\n\n✍️ Writing…');
    expect(edit.other.parse_mode).toBeUndefined();
    expect(edit.other.entities).toEqual([
      { type: 'bold', offset: 8, length: 3 },
      { type: 'italic', offset: 20, length: 11 },
    ]);
  });

  it('holds back edits closer together than the stream interval, then catches up', async () => {
    const sender = new MessageSender();
    const chat = fakeChat(102);
    await sender.startStreaming(chat.ctx, 'hi');
    vi.advanceTimersByTime(2000);

    sender.updateStream(chat.ctx, 'one');
    await vi.advanceTimersByTimeAsync(0);
    sender.updateStream(chat.ctx, 'one two');
    sender.updateStream(chat.ctx, 'one two three');
    await vi.advanceTimersByTimeAsync(0);
    expect(chat.edits(BUBBLE)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1500);
    const edits = chat.edits(BUBBLE);
    expect(edits).toHaveLength(2);
    expect(edits[1].text.startsWith('one two three')).toBe(true);
  });

  it('backs off for as long as Telegram says after a 429, and widens the gap', async () => {
    const sender = new MessageSender();
    const chat = fakeChat(103);
    await sender.startStreaming(chat.ctx, 'hi');
    vi.advanceTimersByTime(2000);

    chat.api.editMessageText.mockRejectedValueOnce(new GrammyError(
      'Too Many Requests',
      { ok: false, error_code: 429, description: 'Too Many Requests: retry after 5', parameters: { retry_after: 5 } },
      'editMessageText',
      {},
    ));
    sender.updateStream(chat.ctx, 'first');
    await vi.advanceTimersByTimeAsync(0);
    expect(chat.api.editMessageText).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4000);
    expect(chat.api.editMessageText).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(chat.edits(BUBBLE).at(-1)!.text.startsWith('first')).toBe(true);
  });

  it('overflows past the message limit into a silent message of its own', async () => {
    const sender = new MessageSender();
    const chat = fakeChat(104);
    await sender.startStreaming(chat.ctx, 'hi');
    vi.advanceTimersByTime(2000);

    const long = Array.from({ length: 120 }, (_, i) => `Paragraph ${i} of a long answer that keeps going.`).join('\n\n');
    sender.updateStream(chat.ctx, long);
    await vi.advanceTimersByTimeAsync(0);

    const bubble = chat.edits(BUBBLE).at(-1)!;
    expect(bubble.text.length).toBeLessThanOrEqual(4096);
    expect(bubble.text).not.toContain('Writing');
    const overflow = chat.reply.mock.calls.at(-1)!;
    expect(String(overflow[0]).endsWith('✍️ Writing…')).toBe(true);
    expect((overflow[1] as { disable_notification?: boolean }).disable_notification).toBe(true);
  });

  it('puts the final text in place of the live one, deleting overflow it no longer needs', async () => {
    const sender = new MessageSender();
    const chat = fakeChat(105);
    await sender.startStreaming(chat.ctx, 'hi');
    vi.advanceTimersByTime(2000);

    const long = Array.from({ length: 120 }, (_, i) => `Paragraph ${i} of a long answer that keeps going.`).join('\n\n');
    sender.updateStream(chat.ctx, long);
    await vi.advanceTimersByTimeAsync(0);
    const overflowId = nextId - 1;

    await sender.finishStreaming(chat.ctx, 'Short in the end.');

    expect(chat.edits(BUBBLE).at(-1)!.text).toBe('Short in the end.');
    expect(chat.api.deleteMessage).toHaveBeenCalledWith(105, overflowId);
  });

  it('keeps what was written when the turn is cancelled, the banner in place of the status', async () => {
    const sender = new MessageSender();
    const chat = fakeChat(106);
    await sender.startStreaming(chat.ctx, 'hi');
    vi.advanceTimersByTime(2000);
    sender.updateStream(chat.ctx, 'Partial answer');
    await vi.advanceTimersByTimeAsync(0);

    await sender.cancelStreaming(chat.ctx, '⚠️ Request cancelled');
    expect(chat.edits(BUBBLE).at(-1)!.text).toBe('Partial answer\n\n⚠️ Request cancelled');
  });

  it('shows the status line under the reply with the terminal UI on', async () => {
    isTerminalUIEnabled.mockReturnValue(true);
    const sender = new MessageSender();
    const chat = fakeChat(107);
    await sender.startStreaming(chat.ctx, 'hi');
    vi.advanceTimersByTime(11000);

    sender.updateStream(chat.ctx, 'Answer so far');
    await vi.advanceTimersByTimeAsync(1500);
    const text = chat.edits(BUBBLE).at(-1)!.text;
    expect(text.startsWith('Answer so far\n\n')).toBe(true);
    expect(text).toContain('✍️ Writing…');
    await sender.finishStreaming(chat.ctx, 'Answer so far.');
  });
});
