/**
 * SDK-mode sub-turns: once a query has backgrounded a task, every turn claude
 * starts on a task-notification (a Monitor firing, say) is posted as a message
 * of its own. Its result text is that same reply, so it must not also land in
 * the user's streaming reply — where every monitor event used to pile up, a
 * second copy of each.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const fx = vi.hoisted(() => {
  const nodeFs = process.getBuiltinModule('fs');
  const nodeOs = process.getBuiltinModule('os');
  const nodePath = process.getBuiltinModule('path');
  process.env.TELECODER_TEST_HOME = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'telecoder-sdk-sub-turn-'));
  return { stream: [] as unknown[] };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: actual, homedir: () => process.env.TELECODER_TEST_HOME ?? actual.homedir() };
});

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  return {
    ...actual,
    query: () => {
      const messages = fx.stream;
      return {
        async *[Symbol.asyncIterator]() { yield* messages; },
        close: () => {},
        interrupt: async () => {},
        supportedCommands: async () => [],
      };
    },
  };
});

const { sendToAgent } = await import('../../src/claude/agent.js');
const { sessionManager } = await import('../../src/claude/session-manager.js');
const { getHeldQuery } = await import('../../src/claude/held-query.js');

const SESSION = 'sess-1';
const init = { type: 'system', subtype: 'init', session_id: SESSION, model: 'm', cwd: process.cwd(), tools: [], slash_commands: [], skills: [] };
const text = (t: string) => ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: t }] } });
const result = (r: string) => ({ type: 'result', subtype: 'success', session_id: SESSION, result: r });

function stream(): unknown[] {
  return [
    init,
    text('Sweep started, watching it.'),
    {
      type: 'assistant', parent_tool_use_id: null,
      message: { content: [{ type: 'tool_use', id: 'tu-mon', name: 'Monitor', input: { command: 'tail -f log', description: 'sweep' } }] },
    },
    { type: 'system', subtype: 'task_started', task_id: 't1', tool_use_id: 'tu-mon', description: 'sweep' },
    result('Sweep started, watching it.'),
    // A monitor event, answered in a turn of claude's own.
    init,
    text('📡 1000/13325 boards'),
    result('📡 1000/13325 boards'),
    init,
    text('📡 2000/13325 boards'),
    result('📡 2000/13325 boards'),
  ];
}

describe('SDK sub-turn replies', () => {
  beforeEach(() => {
    fx.stream = stream();
    sessionManager.createSession('chat:1', process.env.TELECODER_TEST_HOME!);
  });

  it('posts each sub-turn on its own and keeps it out of the streamed reply', async () => {
    const progress: string[] = [];
    const subTurns: string[] = [];
    const response = await sendToAgent('chat:1', 'run the sweep', {
      onProgress: (t) => { progress.push(t); },
      onSubTurnResponse: (t) => { subTurns.push(t); },
    });
    // The reply is back while the monitor keeps the query open.
    await getHeldQuery('chat:1')?.feed.closed;

    await vi.waitFor(() => expect(subTurns).toEqual(['📡 1000/13325 boards', '📡 2000/13325 boards']));
    expect(response.text).not.toContain('📡');
    expect(progress.some((t) => t.includes('📡'))).toBe(false);
  });
});
