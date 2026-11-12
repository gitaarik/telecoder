/**
 * SDK mode keeps the prompt stream open while a background task the query
 * started is still live. Given a finished prompt, the CLI exits a few seconds
 * after the model's last turn and stops any background shell still running —
 * the shell's work is lost, and the model, whose turn is over, never hears.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const fx = vi.hoisted(() => {
  const nodeFs = process.getBuiltinModule('fs');
  const nodeOs = process.getBuiltinModule('os');
  const nodePath = process.getBuiltinModule('path');
  process.env.TELECODER_TEST_HOME = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'telecoder-sdk-bg-hold-'));
  return {
    // Messages the fake CLI emits; a function entry runs instead of yielding.
    script: [] as unknown[],
    inputEnded: false,
  };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: actual, homedir: () => process.env.TELECODER_TEST_HOME ?? actual.homedir() };
});

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  return {
    ...actual,
    query: ({ prompt }: { prompt: AsyncIterable<unknown> }) => {
      fx.inputEnded = false;
      const reading = (async () => {
        for await (const _ of prompt) { /* the user message */ }
        fx.inputEnded = true;
      })();
      const script = fx.script;
      return {
        async *[Symbol.asyncIterator]() {
          for (const step of script) {
            if (typeof step === 'function') await step();
            else yield step;
          }
          // Like the CLI: the stream ends once its input has.
          await reading;
        },
        close: () => {},
        interrupt: async () => {},
        supportedCommands: async () => [],
      };
    },
  };
});

const { sendToAgent } = await import('../../src/claude/agent.js');
const { sessionManager } = await import('../../src/claude/session-manager.js');
const { cancelRequest, setActiveQuery } = await import('../../src/claude/request-queue.js');

const SESSION = 'sess-1';
const KEY = 'chat:1';
const init = { type: 'system', subtype: 'init', session_id: SESSION, model: 'm', cwd: process.cwd(), tools: [], slash_commands: [], skills: [] };
const text = (t: string) => ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: t }] } });
const result = (r: string) => ({ type: 'result', subtype: 'success', session_id: SESSION, result: r });
const backgroundBash = {
  type: 'assistant', parent_tool_use_id: null,
  message: { content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'make snapshot', run_in_background: true } }] },
};
const started = { type: 'system', subtype: 'task_started', task_id: 'b1', tool_use_id: 'tu-1', description: 'make snapshot' };
const notified = (status: string) => ({ type: 'system', subtype: 'task_notification', task_id: 'b1', status, output_file: '/tmp/out', summary: 'done' });
const tick = () => new Promise((r) => setTimeout(r, 10));

describe('SDK input held open for background tasks', () => {
  let seen: boolean[];
  const look = async () => { await tick(); seen.push(fx.inputEnded); };

  beforeEach(() => {
    seen = [];
    sessionManager.createSession(KEY, process.env.TELECODER_TEST_HOME!);
  });

  it('ends the input once a turn finishes with nothing in the background', async () => {
    fx.script = [init, text('Hi.'), result('Hi.'), look];
    await sendToAgent(KEY, 'hello');
    expect(seen).toEqual([true]);
  });

  it('keeps it open past the reply until the background shell reports', async () => {
    fx.script = [
      init, backgroundBash, started, text('Building.'), result('Building.'),
      look,
      notified('completed'),
      look,
      init, text('Snapshot done.'), result('Snapshot done.'),
    ];
    const subTurns: string[] = [];
    await sendToAgent(KEY, 'build it', { onSubTurnResponse: (t) => { subTurns.push(t); } });
    expect(seen).toEqual([false, true]);
    expect(subTurns).toEqual(['Snapshot done.']);
  });

  it('lets a cancel end the wait', async () => {
    fx.script = [
      init, backgroundBash, started, text('Building.'), result('Building.'),
      look,
      async () => {
        // agent.ts registers the query itself; cancelRequest only needs one.
        setActiveQuery(KEY, { interrupt: async () => {} } as never);
        await cancelRequest(KEY);
      },
      look,
    ];
    await sendToAgent(KEY, 'build it');
    expect(seen).toEqual([false, true]);
  });
});
