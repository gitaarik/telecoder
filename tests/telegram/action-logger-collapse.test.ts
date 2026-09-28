/**
 * Coverage for collapsing the action log into a Telegraph link at the end of a
 * turn, which sometimes left the live log standing instead:
 *
 * - A long turn's log was bigger than Telegraph takes on one page, and the
 *   refusal (CONTENT_TOO_BIG) meant no link to collapse into.
 * - The collapse runs a few seconds after the turn ends, and a message queued
 *   behind the turn starts the next one inside that window. The timer looked
 *   the session's log up by key, found the new turn's, and collapsed that one
 *   mid-turn instead.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Context } from 'grammy';
import type { ToolResultEvent } from '../../src/providers/types.js';

vi.mock('../../src/telegram/telegraph-settings.js', () => ({
  isTelegraphEnabled: () => true,
}));

const createTelegraphPage = vi.fn(async (_title: string, _markdown: string) => 'https://telegra.ph/log');
vi.mock('../../src/telegram/telegraph.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/telegram/telegraph.js')>()),
  createTelegraphPage: (title: string, markdown: string) => createTelegraphPage(title, markdown),
}));

const { ActionLogger } = await import('../../src/telegram/action-logger.js');
const { fitsTelegraphPage } = await import('../../src/telegram/telegraph.js');

const SESSION = '111';

function fakeChat() {
  let nextMessageId = 100;
  const api = {
    sendMessage: vi.fn(async () => ({ message_id: nextMessageId++ })),
    editMessageText: vi.fn(async () => true),
  };
  const ctx = { chat: { id: 111 }, message: { message_id: 1 }, api } as unknown as Context;
  /** The messages that were edited into a collapsed summary, in order. */
  const collapsed = () => api.editMessageText.mock.calls
    .filter((call) => String(call[2]).includes('view full log'))
    .map((call) => call[1]);
  return { ctx, api, collapsed };
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
  createTelegraphPage.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ActionLogger.endTurn', () => {
  it('collapses the log after a short delay and lets it go', async () => {
    const logger = new ActionLogger();
    const { ctx, collapsed } = fakeChat();
    await logger.initialize(ctx, SESSION);
    await logger.addToolResult(ctx, SESSION, bash('ls'), 20, 2000);

    logger.endTurn(ctx, SESSION);
    expect(collapsed()).toEqual([]);

    await vi.advanceTimersByTimeAsync(5000);
    expect(collapsed()).toEqual([100]);
    expect(logger.isActive(SESSION)).toBe(false);
  });

  it("collapses a turn's log even once the next turn has started", async () => {
    const logger = new ActionLogger();
    const { ctx, collapsed } = fakeChat();
    await logger.initialize(ctx, SESSION);
    await logger.addToolResult(ctx, SESSION, bash('ls'), 20, 2000); // message 100
    logger.endTurn(ctx, SESSION);

    // A message queued behind the turn starts the next one straight away.
    await logger.initialize(ctx, SESSION);
    await logger.addToolResult(ctx, SESSION, bash('pwd'), 20, 2000); // message 101

    await vi.advanceTimersByTimeAsync(5000);
    expect(collapsed()).toEqual([100]);
    expect(logger.isActive(SESSION)).toBe(true);

    logger.endTurn(ctx, SESSION);
    await vi.advanceTimersByTimeAsync(5000);
    expect(collapsed()).toEqual([100, 101]);
    expect(logger.isActive(SESSION)).toBe(false);
  });

  it("fits a long turn's log onto one Telegraph page, every action still listed", async () => {
    const logger = new ActionLogger();
    const { ctx, collapsed } = fakeChat();
    await logger.initialize(ctx, SESSION);
    for (let i = 1; i <= 60; i++) {
      await logger.addToolResult(ctx, SESSION, bash(`cat file${i}`, 'x'.repeat(2000)), 20, 2000);
    }

    logger.endTurn(ctx, SESSION);
    await vi.advanceTimersByTimeAsync(5000);

    const [, markdown] = createTelegraphPage.mock.calls[0];
    expect(fitsTelegraphPage(markdown)).toBe(true);
    expect(markdown).toContain('## 1. ');
    expect(markdown).toContain('## 60. ');
    expect(markdown).toContain('cat file1\n');
    expect(collapsed()).toEqual([100]);
  });

  it('keeps the newest actions when even their titles overflow the page', async () => {
    const logger = new ActionLogger();
    const { ctx, collapsed } = fakeChat();
    await logger.initialize(ctx, SESSION);
    for (let i = 1; i <= 1000; i++) {
      await logger.addToolResult(ctx, SESSION, bash(`echo ${i}`), 20, 2000);
    }

    logger.endTurn(ctx, SESSION);
    await vi.advanceTimersByTimeAsync(5000);

    const [, markdown] = createTelegraphPage.mock.calls[0];
    expect(fitsTelegraphPage(markdown)).toBe(true);
    expect(markdown).toMatch(/^_\d+ earlier actions left off to fit the page\._/);
    expect(markdown).toContain('## 1000. ');
    expect(markdown).not.toContain('## 1. ');
    expect(collapsed()).toEqual([100]);
  });
});

describe('fitsTelegraphPage', () => {
  it('takes a page well under 64 KB', () => {
    expect(fitsTelegraphPage('x'.repeat(50_000))).toBe(true);
  });

  it('turns away a page over it', () => {
    expect(fitsTelegraphPage('x'.repeat(70_000))).toBe(false);
  });

  it('counts non-ASCII text at its escaped width', () => {
    // 20,000 characters, but 120 KB once each is written as \uXXXX.
    expect(fitsTelegraphPage('é'.repeat(20_000))).toBe(false);
  });
});
