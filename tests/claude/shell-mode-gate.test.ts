import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Context } from 'grammy';

/**
 * A `!command` runs in Claude Code's shell mode: no tool call, so no
 * PreToolUse hook, so the gate never heard of it. These pin that such a
 * message is put to the gate before it is typed into the pty, and that
 * nothing else about a message changes.
 */

const CHAT = -1009990001;
const SESSION_KEY = String(CHAT);
const WORKDIR = '/tmp/telecoder-test-workspace/app';

// The gate is off unless guests exist or it is forced on; force it, so this
// file does not depend on the roster.
vi.stubEnv('TELECODER_PERMISSION_PROMPTS', '1');

const { screenShellCommand, shellModeCommand, SHELL_MODE_LABEL } =
  await import('../../src/claude/shell-mode-gate.js');
const { resolvePendingQuestion } = await import('../../src/claude/ask-user.js');
const { openWindow, resetAutoApprove } = await import('../../src/claude/auto-approve.js');
const { sessionManager } = await import('../../src/claude/session-manager.js');

function fakeCtx() {
  const sendMessage = vi.fn().mockResolvedValue({ message_id: 7, chat: { id: CHAT } });
  const editMessageText = vi.fn().mockResolvedValue(true);
  const getChatMember = vi.fn().mockRejectedValue(new Error('not a member'));
  const ctx = {
    chat: { id: CHAT },
    from: { id: 3, first_name: 'Guest' },
    api: { sendMessage, editMessageText, getChatMember },
  } as unknown as Context;
  return { ctx, sendMessage };
}

/** The id of the question behind the prompt the gate just posted. */
function questionId(sendMessage: ReturnType<typeof vi.fn>): string {
  const keyboard = sendMessage.mock.calls[0]![2].reply_markup.inline_keyboard;
  return (keyboard[0][0].callback_data as string).split(':')[1]!;
}

beforeEach(() => {
  resetAutoApprove();
});

afterEach(() => {
  resetAutoApprove();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('shellModeCommand', () => {
  it('reads the command after a leading !', () => {
    expect(shellModeCommand('!ls -la')).toBe('ls -la');
    expect(shellModeCommand('! sudo reboot')).toBe('sudo reboot');
  });

  it('takes a multi-line message whole, as the script it runs as', () => {
    expect(shellModeCommand('!cd build\nsudo make install')).toBe('cd build\nsudo make install');
  });

  it('is not shell mode unless the ! comes first', () => {
    // Measured: a space before it leaves an ordinary prompt in the editor.
    expect(shellModeCommand(' !ls')).toBeUndefined();
    expect(shellModeCommand('run !ls for me')).toBeUndefined();
    expect(shellModeCommand('sudo rm -rf / is a bad idea, right?')).toBeUndefined();
  });

  it('has nothing to check in a bare !', () => {
    expect(shellModeCommand('!')).toBeUndefined();
    expect(shellModeCommand('!   ')).toBeUndefined();
  });
});

describe('screenShellCommand', () => {
  it('leaves an ordinary message alone, guarded words and all', async () => {
    const { ctx, sendMessage } = fakeCtx();
    const outcome = await screenShellCommand(ctx, SESSION_KEY, 'please run sudo apt update');
    expect(outcome).toEqual({ proceed: true, message: '', approved: false });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('lets an unguarded command through without asking', async () => {
    const { ctx, sendMessage } = fakeCtx();
    const outcome = await screenShellCommand(ctx, SESSION_KEY, '!ls -la');
    expect(outcome).toEqual({ proceed: true, message: '', approved: false });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('asks before a guarded one, naming shell mode and the command', async () => {
    vi.useFakeTimers();
    const { ctx, sendMessage } = fakeCtx();
    const pending = screenShellCommand(ctx, SESSION_KEY, '!sudo apt install ffmpeg');

    await vi.advanceTimersByTimeAsync(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text] = sendMessage.mock.calls[0]!;
    expect(chatId).toBe(CHAT);
    expect(text).toContain('Permission requested — sudo');
    expect(text).toContain('Asked by Guest');
    expect(text).toContain(`Tool: ${SHELL_MODE_LABEL}`);
    expect(text).toContain('sudo apt install ffmpeg');
    // The `!` is the mode switch, not part of what runs.
    expect(text).not.toContain('!sudo');

    await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
    await pending;
  });

  it('blocks it when nobody answers, and says nothing ran', async () => {
    vi.useFakeTimers();
    const { ctx } = fakeCtx();
    const pending = screenShellCommand(ctx, SESSION_KEY, '!sudo apt install ffmpeg');

    await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
    const outcome = await pending;
    expect(outcome.proceed).toBe(false);
    expect(outcome.message).toBe('🔐 Nobody approved within 10 minutes. Denied: sudo. Nothing ran.');
  });

  it('blocks it when an admin denies', async () => {
    const { ctx, sendMessage } = fakeCtx();
    const pending = screenShellCommand(ctx, SESSION_KEY, '!git push --force');
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalled());

    expect(resolvePendingQuestion(questionId(sendMessage), 1, 1)).toBe('resolved');
    const outcome = await pending;
    expect(outcome.proceed).toBe(false);
    expect(outcome.message).toBe('🔐 An approver denied: git push --force. Nothing ran.');
  });

  it('runs it once an admin allows, and reports that someone did', async () => {
    const { ctx, sendMessage } = fakeCtx();
    const pending = screenShellCommand(ctx, SESSION_KEY, '!sudo apt install ffmpeg');
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalled());

    expect(resolvePendingQuestion(questionId(sendMessage), 0, 1)).toBe('resolved');
    expect(await pending).toEqual({ proceed: true, message: '', approved: true });
  });

  it('catches a guarded command on a later line', async () => {
    vi.useFakeTimers();
    const { ctx, sendMessage } = fakeCtx();
    const pending = screenShellCommand(ctx, SESSION_KEY, '!cd build\nrm -rf ../dist');

    await vi.advanceTimersByTimeAsync(1);
    expect(sendMessage.mock.calls[0]![1]).toContain('Permission requested — rm -rf');

    await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
    expect((await pending).proceed).toBe(false);
  });

  it('puts a path outside the projects to the scope guard', async () => {
    vi.useFakeTimers();
    sessionManager.setWorkingDirectory(SESSION_KEY, WORKDIR);
    const { ctx, sendMessage } = fakeCtx();
    const pending = screenShellCommand(ctx, SESSION_KEY, '!cat ~/.ssh/id_rsa');

    await vi.advanceTimersByTimeAsync(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![1]).toContain('reads a credential or bot-state path');

    await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
    expect((await pending).proceed).toBe(false);
  });

  it('lets an auto-approve window answer, without calling that a person', async () => {
    openWindow(CHAT, { openedBy: 2, openedByName: 'Ann', durationMs: 30 * 60 * 1000 });
    const { ctx, sendMessage } = fakeCtx();
    const outcome = await screenShellCommand(ctx, SESSION_KEY, '!rm -rf node_modules');

    expect(outcome).toEqual({ proceed: true, message: '', approved: false });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![1]).toContain('Auto-approved');
  });

  it('blocks a guarded command it has nobody to ask about', async () => {
    const outcome = await screenShellCommand(undefined, SESSION_KEY, '!sudo reboot');
    expect(outcome.proceed).toBe(false);
    expect(outcome.message).toContain('Denied: sudo. Nothing ran.');
  });
});

describe('screenShellCommand with the gate off', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    // Back on for any file-level import that follows.
    vi.stubEnv('TELECODER_PERMISSION_PROMPTS', '1');
  });

  it('changes nothing on a solo bot: the command goes to the terminal as typed', async () => {
    vi.resetModules();
    vi.stubEnv('TELECODER_PERMISSION_PROMPTS', '0');
    const fresh = await import('../../src/claude/shell-mode-gate.js');
    const { ctx, sendMessage } = fakeCtx();

    const outcome = await fresh.screenShellCommand(ctx, SESSION_KEY, '!sudo apt install ffmpeg');
    expect(outcome).toEqual({ proceed: true, message: '', approved: false });
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
