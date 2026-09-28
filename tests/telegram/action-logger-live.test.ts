/**
 * Coverage for the live action log staying within one Telegram message.
 *
 * It showed the last ten entries whatever their size, and ten with a command
 * and output apiece come to more than a message holds. Every edit past that
 * point failed with MESSAGE_TOO_LONG — the plain-text fallback too — so a busy
 * turn's live log froze partway through.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Context } from 'grammy';
import type { ToolResultEvent } from '../../src/providers/types.js';
import { ActionLogger } from '../../src/telegram/action-logger.js';

const SESSION = '111';

/** A chat that turns away over-long text the way Telegram does. */
function fakeChat() {
  const delivered: string[] = [];
  const deliver = (text: string) => {
    if (text.length > 4096) throw new Error('Bad Request: MESSAGE_TOO_LONG');
    delivered.push(text);
  };
  const api = {
    sendMessage: vi.fn(async (_chatId: number, text: string) => {
      deliver(text);
      return { message_id: 100 };
    }),
    editMessageText: vi.fn(async (_chatId: number, _messageId: number, text: string) => {
      deliver(text);
      return true;
    }),
  };
  const ctx = { chat: { id: 111 }, message: { message_id: 1 }, api } as unknown as Context;
  return { ctx, delivered };
}

const bash = (command: string, content: string): ToolResultEvent => ({
  toolUseId: `t-${command}`,
  toolName: 'Bash',
  input: { command },
  content,
  isError: false,
});

/** Log `count` results, then one more past the edit throttle so it's shown. */
async function logResults(logger: ActionLogger, ctx: Context, count: number, result: (i: number) => ToolResultEvent) {
  await logger.initialize(ctx, SESSION);
  for (let i = 1; i < count; i++) {
    await logger.addToolResult(ctx, SESSION, result(i), 20, 2000);
  }
  await vi.advanceTimersByTimeAsync(10_000);
  await logger.addToolResult(ctx, SESSION, result(count), 20, 2000);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ActionLogger live log', () => {
  it('drops the oldest of its ten entries when they would overflow a message', async () => {
    const logger = new ActionLogger();
    const { ctx, delivered } = fakeChat();
    await logResults(logger, ctx, 12, (i) => bash(`cat file${i} ${'some/long/path/'.repeat(15)}`, 'x'.repeat(2000)));

    const latest = delivered.at(-1)!;
    expect(latest).toContain('cat file12 ');
    expect(latest).toMatch(/^_Showing last [1-9] of 12 actions_/);
  });

  it('still shows ten when they fit', async () => {
    const logger = new ActionLogger();
    const { ctx, delivered } = fakeChat();
    await logResults(logger, ctx, 12, (i) => bash(`echo ${i}`, `${i}`));

    expect(delivered.at(-1)).toMatch(/^_Showing last 10 of 12 actions_/);
  });
});
