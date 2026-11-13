/**
 * In SDK mode only a Monitor said in the chat that it had started; a
 * backgrounded shell or subagent showed up as a count in the footer, so what
 * had started was left to guess. Every backgrounded task now gets a silent
 * start line, which its completion replaces.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'grammy';
import { taskTracker } from '../../src/telegram/task-tracker.js';

const { MessageSender } = await import('../../src/telegram/message-sender.js');

const CHAT = 777;
const KEY = String(CHAT);

function fakeChat() {
  let nextId = 100;
  const api = {
    sendMessage: vi.fn(async () => ({ message_id: nextId++ })),
    editMessageText: vi.fn(async () => true),
    sendChatAction: vi.fn(async () => true),
  };
  const reply = vi.fn(async (_text: string, _other?: Record<string, unknown>) => ({ message_id: nextId++ }));
  const ctx = { chat: { id: CHAT }, message: { message_id: 1 }, api, reply } as unknown as Context;
  return { ctx, api, reply };
}

describe('background task start line (SDK mode)', () => {
  beforeEach(() => taskTracker.clear(KEY));

  it('posts a silent line per backgrounded task and edits it when the task ends', async () => {
    const sender = new MessageSender();
    const { ctx, api, reply } = fakeChat();

    await sender.notifyTaskEvent(ctx, KEY, {
      type: 'started', taskId: 'a', description: 'Explore auth', taskType: 'local_agent', isBackgrounded: true,
    });
    await sender.notifyTaskEvent(ctx, KEY, {
      type: 'started', taskId: 'b', description: 'npm test', taskType: 'local_bash', isBackgrounded: true,
    });

    expect(reply.mock.calls.map((c) => c[0])).toEqual([
      '🤖 Subagent "Explore auth" running in background',
      '⚙️ Command "npm test" running in background',
    ]);
    expect(reply.mock.calls.every((c) => c[1]?.disable_notification === true)).toBe(true);
    const startId = taskTracker.getTask(KEY, 'a')!.armedMessageId;

    await sender.notifyTaskEvent(ctx, KEY, {
      type: 'notification', taskId: 'a', status: 'completed', outputFile: '', summary: '',
    });
    const edit = api.editMessageText.mock.calls.find((c) => (c as unknown[])[1] === startId) as unknown[];
    expect(edit[2]).toMatch(/^✅ Subagent "Explore auth" completed in \d+s$/);
  });

  it('says nothing for a foreground task', async () => {
    const sender = new MessageSender();
    const { ctx, reply } = fakeChat();
    await sender.notifyTaskEvent(ctx, KEY, {
      type: 'started', taskId: 'f', description: 'Quick look', taskType: 'local_agent', isBackgrounded: false,
    });
    expect(reply).not.toHaveBeenCalled();
  });

  it('posts once a shell is moved to the background partway through', async () => {
    const sender = new MessageSender();
    const { ctx, reply } = fakeChat();
    await sender.notifyTaskEvent(ctx, KEY, {
      type: 'started', taskId: 's', description: 'npm run build', taskType: 'local_bash', isBackgrounded: false,
    });
    await sender.notifyTaskEvent(ctx, KEY, { type: 'updated', taskId: 's', isBackgrounded: true });
    await sender.notifyTaskEvent(ctx, KEY, { type: 'updated', taskId: 's', isBackgrounded: true });
    expect(reply.mock.calls.map((c) => c[0])).toEqual([
      '⚙️ Command "npm run build" running in background',
    ]);
  });
});
