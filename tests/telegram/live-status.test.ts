/**
 * Coverage for how a running turn shows it's alive.
 *
 * Every turn kept "typing…" up, renewed every four seconds until it ended, and
 * Telegram Desktop draws that animation on the CPU for as long as it shows —
 * so a long turn kept the client busy throughout. A turn with a live status
 * line no longer sends it. Once the action log is in the chat, the status line
 * moves to the bottom of the log: the log is posted below the status bubble
 * and is usually tall enough to push it off screen.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Context } from 'grammy';
import type { ToolResultEvent } from '../../src/providers/types.js';

const isTerminalUIEnabled = vi.fn((_sessionKey: string) => true);
vi.mock('../../src/telegram/terminal-settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/telegram/terminal-settings.js')>()),
  isTerminalUIEnabled: (sessionKey: string) => isTerminalUIEnabled(sessionKey),
}));

// The verbose tier: tool results go to the action log.
vi.mock('../../src/utils/verbosity.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/verbosity.js')>()),
  resolveVerbosityFlags: () => ({
    showUsageFooter: true,
    notifyCompaction: true,
    terminalUiVerbose: true,
    sendCompletionPing: true,
    showToolResults: true,
    toolResultMaxLines: 20,
    toolResultMaxChars: 2000,
    showDiffs: true,
    diffMaxLines: 25,
    useActionLog: true,
  }),
}));

// Telegraph off: a finished turn's log stays in the chat.
vi.mock('../../src/telegram/telegraph-settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/telegram/telegraph-settings.js')>()),
  isTelegraphEnabled: () => false,
}));

const hasPendingQuestionForSession = vi.fn((_sessionKey: string) => false);
vi.mock('../../src/claude/ask-user.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/claude/ask-user.js')>()),
  hasPendingQuestionForSession: (sessionKey: string) => hasPendingQuestionForSession(sessionKey),
}));

const { MessageSender } = await import('../../src/telegram/message-sender.js');

const BUBBLE = 50;
const LOG = 51;
const POINTER = '⏳ Working — live log below ↓';

function fakeChat(chatId: number) {
  const api = {
    sendMessage: vi.fn(async (_chatId: number, _text: string) => ({ message_id: LOG })),
    editMessageText: vi.fn(async (_chatId: number, _messageId: number, _text: string) => true),
    sendChatAction: vi.fn(async () => true),
  };
  const ctx = {
    chat: { id: chatId },
    message: { message_id: 1 },
    api,
    reply: vi.fn(async () => ({ message_id: BUBBLE })),
  } as unknown as Context;
  /** Every text `messageId` was edited to, in order. */
  const edits = (messageId: number) => api.editMessageText.mock.calls
    .filter((call) => call[1] === messageId)
    .map((call) => call[2]);
  return { ctx, api, edits };
}

const bash = (command: string, content: string): ToolResultEvent => ({
  toolUseId: `t-${command}`,
  toolName: 'Bash',
  input: { command },
  content,
  isError: false,
});

/** Start a turn, run `npm test`, and log a result: the action log's first post. */
async function turnWithLog(chatId: number) {
  const sender = new MessageSender();
  const chat = fakeChat(chatId);
  await sender.startStreaming(chat.ctx);
  sender.updateToolOperation(String(chatId), 'Bash', { command: 'npm test' }, chat.ctx);
  await sender.postToolResult(chat.ctx, bash('ls', 'src'), 20, 2000);
  return { sender, ...chat };
}

beforeEach(() => {
  vi.useFakeTimers();
  isTerminalUIEnabled.mockReturnValue(true);
  hasPendingQuestionForSession.mockReturnValue(false);
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a running turn', () => {
  it('sends no "typing…" when it has a live status line', async () => {
    const sender = new MessageSender();
    const { ctx, api } = fakeChat(7001);
    await sender.startStreaming(ctx);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(api.sendChatAction).not.toHaveBeenCalled();
    await sender.cancelStreaming(ctx);
  });

  it('keeps "typing…" up when it has none', async () => {
    isTerminalUIEnabled.mockReturnValue(false);
    const sender = new MessageSender();
    const { ctx, api } = fakeChat(7002);
    await sender.startStreaming(ctx);
    expect(api.sendChatAction).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4000);
    expect(api.sendChatAction).toHaveBeenCalledTimes(2);

    await sender.cancelStreaming(ctx);
    await vi.advanceTimersByTimeAsync(8000);
    expect(api.sendChatAction).toHaveBeenCalledTimes(2);
  });

  it('moves the status line to the bottom of the action log, and points the bubble at it', async () => {
    const { sender, ctx, api, edits } = await turnWithLog(7003);

    const [, posted] = api.sendMessage.mock.calls[0];
    expect(posted).toMatch(/^⏳ Action Log\n/);
    expect(posted).toMatch(/\n\n⏳ 💻 Running\nnpm test$/);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(edits(LOG).at(-1)).toMatch(/\n\n⏳ 💻 Running \[10s\]\nnpm test$/);

    // The bubble is edited once, to the pointer, and left alone after that.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(edits(BUBBLE)).toEqual([POINTER]);
    expect(edits(LOG).at(-1)).toMatch(/\[30s\]\nnpm test$/);

    // A finished turn's log no longer reads as running.
    await sender.cancelStreaming(ctx);
    await vi.advanceTimersByTimeAsync(5000);
    expect(edits(LOG).at(-1)).toMatch(/^📋 Action Log\n/);
    expect(edits(LOG).at(-1)).not.toContain('Running');
  });

  it('announces a pending question at the bottom of the log straight away', async () => {
    const { sender, ctx, edits } = await turnWithLog(7004);
    await vi.advanceTimersByTimeAsync(10_000);
    const before = edits(LOG).length;

    // Well inside the log's edit throttle.
    await vi.advanceTimersByTimeAsync(1000);
    hasPendingQuestionForSession.mockReturnValue(true);
    await sender.noteQuestionPosted(ctx, '7004');

    expect(edits(LOG)).toHaveLength(before + 1);
    expect(edits(LOG).at(-1)).toMatch(/\n\n⏸️ Waiting for your answer — see the question below ↓$/);
    await sender.cancelStreaming(ctx);
  });
});
