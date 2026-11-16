/**
 * A turn that asks the user something carries on in the same turn once they
 * answer, and its next actions went into the log posted before the question —
 * above the question and the answer, out of sight. startNewMessage closes that
 * log and has the next action open a new one below.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Context } from 'grammy';
import type { ToolResultEvent } from '../../src/providers/types.js';

const { ActionLogger } = await import('../../src/telegram/action-logger.js');

const SESSION = '111';

function fakeChat() {
  let nextMessageId = 100;
  const api = {
    sendMessage: vi.fn(async () => ({ message_id: nextMessageId++ })),
    editMessageText: vi.fn(async () => true),
  };
  const ctx = { chat: { id: 111 }, message: { message_id: 1 }, api } as unknown as Context;
  const sentTexts = () => api.sendMessage.mock.calls.map((call) => String(call[1]));
  /** The messages that were drawn closed (📋, not the live ⏳), in order. */
  const closed = () => api.editMessageText.mock.calls
    .filter((call) => String(call[2]).startsWith('📋 '))
    .map((call) => call[1]);
  return { ctx, api, sentTexts, closed };
}

const bash = (command: string): ToolResultEvent => ({
  toolUseId: `t-${command}`,
  toolName: 'Bash',
  input: { command },
  content: 'ok',
  isError: false,
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ActionLogger.startNewMessage', () => {
  it('closes the log from before the answer and posts the next actions in a new one', async () => {
    const logger = new ActionLogger();
    const { ctx, api, sentTexts, closed } = fakeChat();
    await logger.initialize(ctx, SESSION, undefined, 'fix the build');
    await logger.addToolResult(SESSION, bash('ls'), 20, 2000);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);

    logger.startNewMessage(SESSION);
    await vi.advanceTimersByTimeAsync(0);
    expect(closed()).toEqual([100]);

    await logger.addToolResult(SESSION, bash('npm test'), 20, 2000);
    // Not straight away: the bot's "✅ You picked" goes first.
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1500);

    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    const second = sentTexts()[1];
    expect(second).toContain('npm test');
    expect(second).not.toContain('$ ls');
    // The turn is still running, and the new log says what for.
    expect(second).toContain('⏳');
    expect(second).toContain('fix the build');
  });

  it('closes the new log, not the closed one again, when the turn ends', async () => {
    const logger = new ActionLogger();
    const { ctx, closed } = fakeChat();
    await logger.initialize(ctx, SESSION);
    await logger.addToolResult(SESSION, bash('ls'), 20, 2000);
    logger.startNewMessage(SESSION);
    await logger.addToolResult(SESSION, bash('npm test'), 20, 2000);
    await vi.advanceTimersByTimeAsync(1500);

    logger.endTurn(SESSION);
    await vi.advanceTimersByTimeAsync(5000);

    expect(closed()).toEqual([100, 101]);
    expect(logger.isActive(SESSION)).toBe(false);
  });

  it('leaves a log with nothing in it yet alone', async () => {
    const logger = new ActionLogger();
    const { ctx, api, closed } = fakeChat();
    await logger.initialize(ctx, SESSION);

    logger.startNewMessage(SESSION);
    await logger.addToolResult(SESSION, bash('ls'), 20, 2000);

    // Posted at once, as a turn's first log is.
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(closed()).toEqual([]);
  });
});
