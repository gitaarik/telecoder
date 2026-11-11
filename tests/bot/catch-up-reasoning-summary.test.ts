/**
 * The catch-up relay doesn't count the reasoning summary as missed prose.
 *
 * The reply goes out with its reasoning summary stripped, while the session log
 * keeps it. Compared as they were, the summary alone made the log look longer
 * than what was sent, so every turn that had one got a "📨 Catch-up". With a
 * tool call in the turn, the sent text (blocks joined with ───) isn't a prefix
 * of the log's, and the catch-up posted the whole reply a second time.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Context } from 'grammy';

const fx = vi.hoisted(() => ({
  jsonl: '' as string | undefined,
  replies: [] as string[],
  sent: [] as string[],
}));

vi.mock('../../src/claude/session-manager.js', () => ({
  sessionManager: {
    getSession: () => ({ claudeSessionId: 'sess', workingDirectory: '/tmp/proj' }),
    setLastRelayedAssistantText: () => {},
  },
}));
vi.mock('../../src/claude/session-jsonl.js', () => ({
  readLastAssistantTurnText: () => fx.jsonl,
}));
vi.mock('../../src/telegram/message-sender.js', () => ({
  messageSender: { sendMessage: async (_ctx: unknown, text: string) => { fx.sent.push(text); } },
}));
vi.mock('../../src/providers/claude-provider.js', () => ({ getPtyProvider: () => ({}) }));
vi.mock('../../src/providers/provider-router.js', () => ({ getCachedUsage: () => undefined }));
vi.mock('../../src/bot/handlers/command/settings.js', () => ({ sendStatusLine: async () => {} }));

const { relayCatchUpIfMissed } = await import('../../src/bot/handlers/message/turn-notify.js');

const ctx = { reply: async (text: string) => { fx.replies.push(text); } } as unknown as Context;

const SUMMARY = '\n\n**Reasoning Summary**\n'
  + '- Loaded the live page and read its full text from the accessibility snapshot.\n'
  + '- Took screenshots at 1440px and 390px, scrolling first because content only appears on scroll.\n'
  + '- Ranked the findings by how much they affect what a recruiter takes away.';

beforeEach(() => {
  fx.replies = [];
  fx.sent = [];
});

describe('relayCatchUpIfMissed and the reasoning summary', () => {
  it('posts nothing for a turn with tool calls whose only extra is the summary', async () => {
    fx.jsonl = `Now the visuals, desktop and mobile.\n\nI went through the page.${SUMMARY}`;
    await relayCatchUpIfMissed(ctx, 'k', 'Now the visuals, desktop and mobile.\n\n───\n\nI went through the page.');
    expect(fx.replies).toEqual([]);
    expect(fx.sent).toEqual([]);
  });

  it('posts nothing for a one-block turn whose only extra is the summary', async () => {
    fx.jsonl = `The design is in good shape.${SUMMARY}`;
    await relayCatchUpIfMissed(ctx, 'k', 'The design is in good shape.');
    expect(fx.sent).toEqual([]);
  });

  it('still recovers prose that was really missed, without the summary', async () => {
    fx.jsonl = `First part.\n\nA second part the relay dropped, long enough to count.${SUMMARY}`;
    await relayCatchUpIfMissed(ctx, 'k', 'First part.');
    expect(fx.replies).toHaveLength(1);
    expect(fx.sent).toEqual(['A second part the relay dropped, long enough to count.']);
  });
});
