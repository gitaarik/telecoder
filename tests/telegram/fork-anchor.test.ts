/**
 * Where the 🍴 Fork button goes when a turn ends.
 *
 * It marks the end of the reply, so it belongs under the reply's last message:
 * the last part of a reply edited into the live bubble, the last part of one
 * re-sent under tool output — and, for a turn that said everything it had to
 * say before asking a question, the prose that went out ahead of the question.
 * That turn ends with nothing new to post, and the button used to land on the
 * "Done" bubble above the prose and the question card.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Context } from 'grammy';

// No action log: the reply is edited into the bubble.
vi.mock('../../src/utils/verbosity.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/verbosity.js')>()),
  resolveVerbosityFlags: () => ({
    showUsageFooter: true,
    notifyCompaction: true,
    fullToolInputs: false,
    sendCompletionPing: true,
    showToolResults: false,
    toolResultMaxLines: 20,
    toolResultMaxChars: 2000,
    showDiffs: false,
    diffMaxLines: 25,
    useActionLog: false,
  }),
}));
// A session with a transcript to fork from, so the button is attached at all.
vi.mock('../../src/claude/session-manager.js', () => ({
  sessionManager: {
    getSession: () => ({ claudeSessionId: 'cs', workingDirectory: '/tmp', conversationId: 'conv' }),
  },
}));
vi.mock('../../src/claude/message-offsets.js', () => ({
  messageOffsets: { record: vi.fn() },
  countJsonlLines: () => 5,
}));

const { MessageSender } = await import('../../src/telegram/message-sender.js');

const BUBBLE = 50;
let nextId = 60;

function fakeChat(chatId: number) {
  const api = {
    sendMessage: vi.fn(async () => ({ message_id: nextId++ })),
    editMessageText: vi.fn(async () => true),
    editMessageReplyMarkup: vi.fn(async () => true),
    deleteMessage: vi.fn(async () => true),
    sendChatAction: vi.fn(async () => true),
  };
  let replies = 0;
  const reply = vi.fn(async () => ({ message_id: replies++ === 0 ? BUBBLE : nextId++ }));
  const ctx = { chat: { id: chatId, type: 'private' }, message: { message_id: 1 }, api, reply } as unknown as Context;
  /** The ids of the messages posted, the bubble first. */
  const posted = async () => (await Promise.all(reply.mock.results.map((r) => r.value as Promise<{ message_id: number }>)))
    .map((m) => m.message_id);
  /** The messages a fork button was attached to. */
  const forkButtonsOn = () => api.editMessageReplyMarkup.mock.calls.map((call) => call[1]);
  return { ctx, api, reply, posted, forkButtonsOn };
}

const TWO_PARTS = Array.from({ length: 120 }, (_, i) => `Paragraph ${i} of a long answer that keeps going.`).join('\n\n');

describe('fork button anchor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('goes under the last part of a reply edited into the live messages', async () => {
    const sender = new MessageSender();
    const chat = fakeChat(301);
    await sender.startStreaming(chat.ctx, 'hi');
    vi.advanceTimersByTime(2000);
    sender.updateStream(chat.ctx, TWO_PARTS);
    await vi.advanceTimersByTimeAsync(0);

    await sender.finishStreaming(chat.ctx, TWO_PARTS);

    const [bubble, overflow] = await chat.posted();
    expect(bubble).toBe(BUBBLE);
    expect(chat.forkButtonsOn()).toEqual([overflow]);
  });

  it('goes under the last part of a reply re-sent below a mid-turn post', async () => {
    const sender = new MessageSender();
    const chat = fakeChat(302);
    await sender.startStreaming(chat.ctx, 'hi');
    vi.advanceTimersByTime(2000);
    // A sub-agent's reply, posted as the turn runs: the bubble becomes a
    // pointer and the reply is sent again under it.
    await sender.postSubTurnResponse(chat.ctx, 'What the sub-agent found.');

    await sender.finishStreaming(chat.ctx, TWO_PARTS);

    const ids = await chat.posted();
    expect(ids).toHaveLength(4); // bubble, sub-agent reply, two parts
    expect(chat.forkButtonsOn()).toEqual([ids[3]]);
  });

  it('goes under the prose sent ahead of a question when the answer ends the turn', async () => {
    const sender = new MessageSender();
    const chat = fakeChat(303);
    await sender.startStreaming(chat.ctx, 'hi');
    vi.advanceTimersByTime(2000);
    // What the bridge does before a question goes out: the prose so far, as
    // its own message. The pty strips it from the final reply, which is then
    // empty when claude writes nothing after the answer.
    await sender.sendMessage(chat.ctx, 'Two ways to do this. Which one?');
    // The question card follows, posted by the bridge itself.
    await sender.noteQuestionPosted(chat.ctx, '303');

    await sender.finishStreaming(chat.ctx, '');

    const [bubble, prose] = await chat.posted();
    expect(chat.api.editMessageText.mock.calls.filter((call) => call[1] === bubble).at(-1)?.[2]).toBe('✅ Done');
    expect(chat.forkButtonsOn()).toEqual([prose]);
  });

  it('stays on the Done bubble when nothing else was posted during the turn', async () => {
    const sender = new MessageSender();
    const chat = fakeChat(304);
    await sender.startStreaming(chat.ctx, 'hi');
    vi.advanceTimersByTime(2000);

    await sender.finishStreaming(chat.ctx, '');

    expect(chat.forkButtonsOn()).toEqual([BUBBLE]);
  });
});
