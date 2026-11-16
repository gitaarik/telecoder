/**
 * Coverage for closing the action log at the end of a turn — one last draw
 * without the live marker and status line — which sometimes went wrong:
 *
 * - The close runs a few seconds after the turn ends, and a message queued
 *   behind the turn starts the next one inside that window. The timer looked
 *   the session's log up by key, found the new turn's, and closed that one
 *   mid-turn instead.
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
  /** The messages that were drawn closed (📋, not the live ⏳), in order. */
  const closed = () => api.editMessageText.mock.calls
    .filter((call) => String(call[2]).startsWith('📋 '))
    .map((call) => call[1]);
  return { ctx, api, closed };
}

const bash = (command: string, content = 'ok'): ToolResultEvent => ({
  toolUseId: `t-${command}`,
  toolName: 'Bash',
  input: { command },
  content,
  isError: false,
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ActionLogger.endTurn', () => {
  it('closes the log after a short delay and lets it go', async () => {
    const logger = new ActionLogger();
    const { ctx, closed } = fakeChat();
    await logger.initialize(ctx, SESSION);
    await logger.addToolResult(SESSION, bash('ls'), 20, 2000);

    logger.endTurn(SESSION);
    expect(closed()).toEqual([]);

    await vi.advanceTimersByTimeAsync(5000);
    expect(closed()).toEqual([100]);
    expect(logger.isActive(SESSION)).toBe(false);
  });

  it('leaves the full log in place, no longer marked live and without the status line', async () => {
    const logger = new ActionLogger();
    const { ctx, api, closed } = fakeChat();
    const status = () => ({ text: '⏳ 💻 Running [12s]', entities: [] });
    await logger.initialize(ctx, SESSION, status);
    await logger.addToolResult(SESSION, bash('ls'), 20, 2000);

    logger.endTurn(SESSION);
    await vi.advanceTimersByTimeAsync(5000);

    expect(closed()).toEqual([100]);
    const [, messageId, text] = api.editMessageText.mock.calls.at(-1) as unknown as [number, number, string];
    expect(messageId).toBe(100);
    expect(text).toMatch(/^📋 Action Log\n\n.+ Bash result\n\$ ls\nok$/);
  });

  it("closes a turn's log even once the next turn has started", async () => {
    const logger = new ActionLogger();
    const { ctx, closed } = fakeChat();
    await logger.initialize(ctx, SESSION);
    await logger.addToolResult(SESSION, bash('ls'), 20, 2000); // message 100
    logger.endTurn(SESSION);

    // A message queued behind the turn starts the next one straight away.
    await logger.initialize(ctx, SESSION);
    await logger.addToolResult(SESSION, bash('pwd'), 20, 2000); // message 101

    await vi.advanceTimersByTimeAsync(5000);
    expect(closed()).toEqual([100]);
    expect(logger.isActive(SESSION)).toBe(true);

    logger.endTurn(SESSION);
    await vi.advanceTimersByTimeAsync(5000);
    expect(closed()).toEqual([100, 101]);
    expect(logger.isActive(SESSION)).toBe(false);
  });
});
