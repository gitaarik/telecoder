import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Context } from 'grammy';

/**
 * The gate's behaviour when an auto-approve window is open.
 *
 * Worth its own file because the interesting cases are the ones where the
 * window must *not* apply: a carve-out reason, and a chat that never opened
 * one. Both have to fall through to the prompt, and a prompt that is never
 * answered has to stay blocked — which is what makes a stranded window safe.
 */

const CHAT = -1009990001;
const SESSION_KEY = String(CHAT);

// The gate is off unless guests exist or it is forced on; force it, so this
// file does not depend on the roster.
vi.stubEnv('TELECODER_PERMISSION_PROMPTS', '1');

const { evaluateToolCall } = await import('../../src/claude/permission-gate.js');
const { openWindow, resetAutoApprove, getWindow } = await import('../../src/claude/auto-approve.js');

function fakeCtx() {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const getChatMember = vi.fn().mockRejectedValue(new Error('not a member'));
  const ctx = {
    chat: { id: CHAT },
    from: { id: 3, first_name: 'Guest' },
    api: { sendMessage, getChatMember },
  } as unknown as Context;
  return { ctx, sendMessage };
}

function call(ctx: Context, command: string) {
  return evaluateToolCall({
    sessionKey: SESSION_KEY,
    toolName: 'Bash',
    toolInput: { command },
    telegramCtx: ctx,
  });
}

beforeEach(() => {
  resetAutoApprove();
});

afterEach(() => {
  resetAutoApprove();
  vi.clearAllMocks();
});

describe('the gate with a window open', () => {
  beforeEach(() => {
    openWindow(CHAT, { openedBy: 2, openedByName: 'Ann', durationMs: 30 * 60 * 1000 });
  });

  it('lets a guarded command through without a prompt', async () => {
    const { ctx } = fakeCtx();
    const decision = await call(ctx, 'rm -rf node_modules');
    expect(decision.block).toBe(false);
  });

  it('posts what it approved instead of a prompt', async () => {
    // The window buys back the tap, not the record. A silent auto-approval
    // would make the window impossible to audit after the fact.
    const { ctx, sendMessage } = fakeCtx();
    await call(ctx, 'rm -rf node_modules');

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text, opts] = sendMessage.mock.calls[0]!;
    expect(chatId).toBe(CHAT);
    expect(text).toContain('Auto-approved');
    expect(text).toContain('rm -rf');
    expect(text).toContain('node_modules');
    expect(text).toContain("Ann's window");
    // Posted as a plain notice, not a question.
    expect(opts?.reply_markup).toBeUndefined();
  });

  it('counts each one so the tally is real', async () => {
    const { ctx } = fakeCtx();
    await call(ctx, 'rm -rf a');
    await call(ctx, 'sudo systemctl restart nginx');
    expect(getWindow(CHAT)!.approved).toBe(2);
  });

  it('leaves unguarded commands alone entirely', async () => {
    const { ctx, sendMessage } = fakeCtx();
    const decision = await call(ctx, 'ls -la');
    expect(decision.block).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('still prompts for an irreversible one, and blocks when nobody answers', async () => {
    // The point of the carve-out: a window left open by accident still cannot
    // cost you the machine. The prompt goes up and is never tapped here, so
    // the call has to end blocked rather than allowed.
    vi.useFakeTimers();
    const { ctx, sendMessage } = fakeCtx();
    const pending = call(ctx, 'mkfs.ext4 /dev/sda1');

    await vi.advanceTimersByTimeAsync(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![1]).toContain('Permission requested');
    expect(sendMessage.mock.calls[0]![2]?.reply_markup).toBeDefined();

    await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
    const decision = await pending;
    expect(decision.block).toBe(true);
    expect(getWindow(CHAT)!.approved).toBe(0);
    vi.useRealTimers();
  });
});

describe('the gate with no window', () => {
  it('prompts as usual', async () => {
    vi.useFakeTimers();
    const { ctx, sendMessage } = fakeCtx();
    const pending = call(ctx, 'rm -rf node_modules');

    await vi.advanceTimersByTimeAsync(1);
    expect(sendMessage.mock.calls[0]![1]).toContain('Permission requested');

    await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
    expect((await pending).block).toBe(true);
    vi.useRealTimers();
  });
});
