import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Context } from 'grammy';

/**
 * The router is the one point every user prompt passes on its way to claude.
 * These pin what it does with the two checks that sit there: the shell-mode
 * gate and the charter judge's hold.
 */

const providerSend = vi.fn();
const screenShellCommand = vi.fn();
const screenPrompt = vi.fn();

vi.mock('../../src/providers/claude-provider.js', () => ({
  claudeProvider: { sendToAgent: (...a: unknown[]) => providerSend(...a) },
}));
vi.mock('../../src/providers/ccr-provider.js', () => ({
  ccrProvider: { sendToAgent: (...a: unknown[]) => providerSend(...a) },
}));
vi.mock('../../src/claude/shell-mode-gate.js', () => ({
  screenShellCommand: (...a: unknown[]) => screenShellCommand(...a),
}));
vi.mock('../../src/claude/prompt-hold.js', () => ({
  screenPrompt: (...a: unknown[]) => screenPrompt(...a),
}));

const { sendToAgent } = await import('../../src/providers/provider-router.js');

const KEY = '-1009990001';
const ctx = { chat: { id: -1009990001 }, from: { id: 3 } } as unknown as Context;
const PASS = { proceed: true, message: '', approved: false };

beforeEach(() => {
  vi.clearAllMocks();
  providerSend.mockResolvedValue({ text: 'ran', toolsUsed: [] });
  screenShellCommand.mockResolvedValue(PASS);
  screenPrompt.mockResolvedValue({ proceed: true, message: '' });
});

describe('sendToAgent screening', () => {
  it('sends a message both checks pass', async () => {
    const response = await sendToAgent(KEY, 'fix the tests', { telegramCtx: ctx });

    expect(response.text).toBe('ran');
    expect(screenShellCommand).toHaveBeenCalledWith(ctx, KEY, 'fix the tests');
    expect(screenPrompt).toHaveBeenCalledWith(ctx, KEY, 'fix the tests');
    expect(providerSend).toHaveBeenCalledTimes(1);
    expect(providerSend.mock.calls[0]![1]).toBe('fix the tests');
  });

  it('never types a shell command the gate blocked', async () => {
    screenShellCommand.mockResolvedValue({
      proceed: false, message: '🔐 An approver denied: sudo. Nothing ran.', approved: false,
    });

    const response = await sendToAgent(KEY, '!sudo reboot', { telegramCtx: ctx });

    expect(response).toEqual({ text: '🔐 An approver denied: sudo. Nothing ran.', toolsUsed: [] });
    expect(providerSend).not.toHaveBeenCalled();
    // Blocked already; no need to spend a judge call on it.
    expect(screenPrompt).not.toHaveBeenCalled();
  });

  it('does not ask twice about a command an approver just allowed', async () => {
    screenShellCommand.mockResolvedValue({ proceed: true, message: '', approved: true });

    await sendToAgent(KEY, '!sudo apt install ffmpeg', { telegramCtx: ctx });

    expect(screenPrompt).not.toHaveBeenCalled();
    expect(providerSend).toHaveBeenCalledTimes(1);
    expect(providerSend.mock.calls[0]![1]).toBe('!sudo apt install ffmpeg');
  });

  it('still puts an unprompted shell command to the charter judge', async () => {
    // The gate had no pattern for it, which says nothing about the charter.
    screenPrompt.mockResolvedValue({ proceed: false, message: '🚧 Blocked — opens a tunnel. Nothing ran.' });

    const response = await sendToAgent(KEY, '!ngrok http 22', { telegramCtx: ctx });

    expect(response.text).toBe('🚧 Blocked — opens a tunnel. Nothing ran.');
    expect(providerSend).not.toHaveBeenCalled();
  });
});
