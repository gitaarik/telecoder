/**
 * A query kept open for a background task doesn't hold up the chat: the reply
 * goes out, the next message joins that same query instead of starting a
 * second CLI on the session, and a /cancel stops the turn, not the task.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

type Step = unknown | (() => Promise<void> | void);

const fx = vi.hoisted(() => {
  const nodeFs = process.getBuiltinModule('fs');
  const nodeOs = process.getBuiltinModule('os');
  const nodePath = process.getBuiltinModule('path');
  process.env.TELECODER_TEST_HOME = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'telecoder-held-query-'));
  return {
    // What the fake CLI answers each prompt it reads with, in order.
    replies: [] as Step[][],
    queries: 0,
    prompts: [] as string[],
    inputEnded: false,
    closed: false,
    interrupted: 0,
    // Emits a message on the current query's stream.
    out: undefined as undefined | ((m: unknown) => void),
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
    query: ({ prompt }: { prompt: AsyncIterable<{ uuid?: string; message: { content: unknown } }> }) => {
      fx.queries++;
      fx.inputEnded = false;
      fx.closed = false;
      const buffer: unknown[] = [];
      let wake: (() => void) | undefined;
      let ended = false;
      const emit = (m: unknown) => { buffer.push(m); wake?.(); };
      fx.out = emit;
      void (async () => {
        for await (const msg of prompt) {
          fx.prompts.push(String(msg.message.content));
          const uuid = msg.uuid;
          if (uuid) emit({ type: 'command_lifecycle', command_uuid: uuid, state: 'started' });
          for (const step of fx.replies.shift() ?? []) {
            if (typeof step === 'function') await (step as () => Promise<void>)();
            else emit(step);
          }
          if (uuid) emit({ type: 'command_lifecycle', command_uuid: uuid, state: 'completed' });
        }
        fx.inputEnded = true;
        // Like the CLI: the stream ends once its input has.
        ended = true;
        wake?.();
      })();
      return {
        async *[Symbol.asyncIterator]() {
          for (;;) {
            const next = buffer.shift();
            if (next !== undefined) { yield next; continue; }
            if (ended || fx.closed) return;
            await new Promise<void>((r) => { wake = r; });
            wake = undefined;
          }
        },
        close: () => { fx.closed = true; wake?.(); },
        interrupt: async () => { fx.interrupted++; },
        setModel: async () => {},
        setPermissionMode: async () => {},
        supportedCommands: async () => [],
      };
    },
  };
});

const { sendToAgent } = await import('../../src/claude/agent.js');
const { sessionManager } = await import('../../src/claude/session-manager.js');
const { cancelRequest, clearActiveQuery, clearCancelled } = await import('../../src/claude/request-queue.js');
const { getHeldQuery } = await import('../../src/claude/held-query.js');

const SESSION = 'sess-1';
const KEY = 'chat:1';
const init = { type: 'system', subtype: 'init', session_id: SESSION, model: 'm', cwd: process.cwd(), tools: [], slash_commands: [], skills: [] };
const text = (t: string) => ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: t }] } });
const result = (r: string, subtype = 'success') => ({ type: 'result', subtype, session_id: SESSION, result: r });
const backgroundBash = {
  type: 'assistant', parent_tool_use_id: null,
  message: { content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'make snapshot', run_in_background: true } }] },
};
const started = { type: 'system', subtype: 'task_started', task_id: 'b1', tool_use_id: 'tu-1', description: 'make snapshot' };
const notified = { type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'completed', output_file: '/tmp/out', summary: 'done' };
const tick = () => new Promise((r) => setTimeout(r, 10));

/** The background task ends: the CLI reports it and answers in a sub-turn. */
const finishTask = (reply: string) => {
  for (const m of [notified, init, text(reply), result(reply)]) fx.out?.(m);
};

describe('a query held open for a background task', () => {
  beforeEach(() => {
    fx.queries = 0;
    fx.prompts = [];
    fx.replies = [];
    sessionManager.createSession(KEY, process.env.TELECODER_TEST_HOME!);
  });

  it('takes the next message into the same query, and the task still reports', async () => {
    fx.replies = [
      [init, backgroundBash, started, text('Building.'), result('Building.')],
      [init, text('Still building, yes.'), result('Still building, yes.')],
    ];
    const subTurns: string[] = [];
    const first = await sendToAgent(KEY, 'build it', { onSubTurnResponse: (t) => { subTurns.push(t); } });
    expect(first.text).toBe('Building.');
    expect(getHeldQuery(KEY)).toBeDefined();
    expect(fx.inputEnded).toBe(false);

    const second = await sendToAgent(KEY, 'still going?', { onSubTurnResponse: (t) => { subTurns.push(t); } });
    expect(second.text).toBe('Still building, yes.');
    expect(fx.queries).toBe(1);
    expect(fx.prompts).toEqual(['build it', 'still going?']);
    expect(fx.inputEnded).toBe(false);

    finishTask('Snapshot done.');
    await getHeldQuery(KEY)?.feed.closed;
    // The feed has ended; its last reader is still handling what it got.
    await tick();
    expect(subTurns).toEqual(['Snapshot done.']);
    expect(fx.inputEnded).toBe(true);
  });

  it('lets a /cancel stop the turn but keeps the task running', async () => {
    fx.replies = [[
      init, backgroundBash, started, text('Building.'),
      async () => {
        // The user cancels while the turn is still going.
        await cancelRequest(KEY);
      },
      result('', 'error_during_execution'),
    ]];
    const subTurns: string[] = [];
    const reply = sendToAgent(KEY, 'build it', { onSubTurnResponse: (t) => { subTurns.push(t); } });
    await tick();
    await reply;
    // As the request queue does once the turn's handler returns.
    clearActiveQuery(KEY);
    clearCancelled(KEY);

    expect(fx.interrupted).toBeGreaterThan(0);
    expect(fx.closed).toBe(false);
    expect(fx.inputEnded).toBe(false);
    expect(getHeldQuery(KEY)).toBeDefined();

    finishTask('Snapshot done.');
    await getHeldQuery(KEY)?.feed.closed;
    // The feed has ended; its last reader is still handling what it got.
    await tick();
    expect(subTurns).toEqual(['Snapshot done.']);
  });

  it('stops the task on a /cancel with no turn running', async () => {
    fx.replies = [[init, backgroundBash, started, text('Building.'), result('Building.')]];
    await sendToAgent(KEY, 'build it');
    clearActiveQuery(KEY);
    expect(await cancelRequest(KEY)).toBe(true);
    await getHeldQuery(KEY)?.feed.closed;
    await tick();
    expect(fx.inputEnded).toBe(true);
  });
});
