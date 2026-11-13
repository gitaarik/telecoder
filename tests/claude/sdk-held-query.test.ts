/**
 * A query kept open for background work, past its reply and into the chat's
 * next message.
 *
 * Resuming a session whose previous process left a task behind, the CLI first
 * answers the "didn't finish before the previous session ended" notice with a
 * result of its own, ahead of the prompt. TeleCoder took that result for the
 * turn's: nothing was running yet, so it ended the input, and the CLI stopped
 * whatever the real turn then started in the background five seconds after
 * the reply — which left one more such notice for the next turn to trip on.
 *
 * And a message sent while a query is held joins it, rather than starting a
 * second CLI on the same session that would see the first one's tasks as dead.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const fx = vi.hoisted(() => {
  const nodeFs = process.getBuiltinModule('fs');
  const nodeOs = process.getBuiltinModule('os');
  const nodePath = process.getBuiltinModule('path');
  process.env.TELECODER_TEST_HOME = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'telecoder-sdk-held-'));
  return {
    // What the fake CLI emits. A function runs instead; a message it returns
    // is emitted.
    script: [] as unknown[],
    queries: 0,
    prompts: [] as { uuid: string; message: { content: unknown } }[],
    promptRead: [] as (() => void)[],
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
    query: ({ prompt }: { prompt: AsyncIterable<{ uuid: string; message: { content: unknown } }> }) => {
      fx.queries++;
      fx.inputEnded = false;
      const reading = (async () => {
        for await (const m of prompt) {
          fx.prompts.push(m);
          fx.promptRead.splice(0).forEach((wake) => wake());
        }
        fx.inputEnded = true;
      })();
      const script = fx.script;
      return {
        async *[Symbol.asyncIterator]() {
          for (const step of script) {
            if (typeof step !== 'function') { yield step; continue; }
            const out = await step();
            if (out) yield out;
          }
          // Like the CLI: the stream ends once its input has.
          await reading;
        },
        close: () => {},
        interrupt: async () => {},
        setModel: async () => {},
        setPermissionMode: async () => {},
        supportedCommands: async () => [],
      };
    },
  };
});

const { sendToAgent } = await import('../../src/claude/agent.js');
const { sessionManager } = await import('../../src/claude/session-manager.js');
const { getHeldQuery } = await import('../../src/claude/held-query.js');

const SESSION = 'sess-1';
const KEY = 'chat:1';
const init = { type: 'system', subtype: 'init', session_id: SESSION, model: 'm', cwd: process.cwd(), tools: [], slash_commands: [], skills: [] };
const text = (t: string) => ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: t }] } });
const result = (r: string) => ({ type: 'result', subtype: 'success', session_id: SESSION, result: r });
const backgroundBash = (id: string) => ({
  type: 'assistant', parent_tool_use_id: null,
  message: { content: [{ type: 'tool_use', id: `tu-${id}`, name: 'Bash', input: { command: 'make snapshot', run_in_background: true } }] },
});
const started = (id: string) => ({ type: 'system', subtype: 'task_started', task_id: id, tool_use_id: `tu-${id}`, description: 'make snapshot' });
const notified = (id: string, status: string) => ({ type: 'system', subtype: 'task_notification', task_id: id, status, output_file: '/tmp/out', summary: id });
/** The CLI's report on the nth prompt it has read, once it has read it. */
const lifecycle = (n: number, state: string) => async () => {
  while (fx.prompts.length <= n) await new Promise<void>((resolve) => fx.promptRead.push(resolve));
  return { type: 'command_lifecycle', command_uuid: fx.prompts[n].uuid, state };
};
const tick = () => new Promise((r) => setTimeout(r, 10));

describe('SDK query held open past its reply', () => {
  let seen: boolean[];
  const look = async () => { await tick(); seen.push(fx.inputEnded); };

  beforeEach(() => {
    seen = [];
    fx.queries = 0;
    fx.prompts = [];
    sessionManager.createSession(KEY, process.env.TELECODER_TEST_HOME!);
  });

  it("doesn't end the input at a result for a turn queued ahead of the prompt", async () => {
    fx.script = [
      // On resume: the notice for the previous process's task, answered first.
      lifecycle(0, 'queued'),
      notified('old', 'stopped'),
      init, result(''),
      look,
      lifecycle(0, 'started'),
      init, backgroundBash('b1'), started('b1'), text('Watching the build.'), result('Watching the build.'),
      lifecycle(0, 'completed'),
      look,
      notified('b1', 'completed'),
      init, text('Build passed.'), result('Build passed.'),
    ];
    const subTurns: string[] = [];
    const response = await sendToAgent(KEY, 'watch the build', { onSubTurnResponse: (t) => { subTurns.push(t); } });
    expect(response.text).toBe('Watching the build.');
    await getHeldQuery(KEY)?.feed.closed;
    expect(seen).toEqual([false, false]);
    await vi.waitFor(() => expect(subTurns).toEqual(['Build passed.']));
  });

  it('replies without waiting for the background work', async () => {
    fx.script = [
      lifecycle(0, 'started'),
      init, backgroundBash('b1'), started('b1'), text('Building.'), result('Building.'),
      notified('b1', 'completed'),
      init, text('Built.'), result('Built.'),
    ];
    const response = await sendToAgent(KEY, 'build it');
    expect(response.text).toBe('Building.');
    expect(getHeldQuery(KEY)).toBeDefined();
    await getHeldQuery(KEY)?.feed.closed;
    expect(getHeldQuery(KEY)).toBeUndefined();
  });

  it('feeds the next message into the held query, keeping its task alive', async () => {
    let secondTurn: Promise<{ text: string }> | undefined;
    const firstSubTurns: string[] = [];
    const secondSubTurns: string[] = [];
    fx.script = [
      lifecycle(0, 'started'),
      init, backgroundBash('b1'), started('b1'), text('Deploying.'), result('Deploying.'),
      lifecycle(0, 'completed'),
      async () => {
        await tick();
        secondTurn = sendToAgent(KEY, 'how is it going?', { onSubTurnResponse: (t) => { secondSubTurns.push(t); } });
      },
      // Read before the first turn's reader lets go: the next prompt's turn
      // starts at its own lifecycle message.
      lifecycle(1, 'queued'),
      look,
      lifecycle(1, 'started'),
      init, text('Still deploying.'), result('Still deploying.'),
      lifecycle(1, 'completed'),
      look,
      notified('b1', 'completed'),
      init, text('Deployed.'), result('Deployed.'),
    ];
    const first = await sendToAgent(KEY, 'deploy', { onSubTurnResponse: (t) => { firstSubTurns.push(t); } });
    expect(first.text).toBe('Deploying.');
    await vi.waitFor(() => expect(secondTurn).toBeDefined());
    const second = await secondTurn!;
    expect(second.text).toBe('Still deploying.');
    await getHeldQuery(KEY)?.feed.closed;

    expect(fx.queries).toBe(1);
    expect(fx.prompts.map((p) => p.message.content)).toEqual(['deploy', 'how is it going?']);
    // The task outlived both replies; the input ended only once it reported.
    expect(seen).toEqual([false, false]);
    expect(fx.inputEnded).toBe(true);
    // Its report goes to the turn reading the query by then.
    await vi.waitFor(() => expect(secondSubTurns).toEqual(['Deployed.']));
    expect(firstSubTurns).toEqual([]);
  });

  it('hands a sub-turn in progress to the next turn only where its prompt starts', async () => {
    let secondTurn: Promise<{ text: string }> | undefined;
    const firstSubTurns: string[] = [];
    fx.script = [
      lifecycle(0, 'started'),
      init, backgroundBash('b1'), started('b1'), backgroundBash('b2'), started('b2'), text('Two jobs running.'), result('Two jobs running.'),
      lifecycle(0, 'completed'),
      notified('b1', 'completed'),
      init,
      async () => {
        secondTurn = sendToAgent(KEY, 'and the other one?');
        await tick();
      },
      text('Job one is done.'), result('Job one is done.'),
      lifecycle(1, 'started'),
      init, text('Job two is still running.'), result('Job two is still running.'),
      lifecycle(1, 'completed'),
      notified('b2', 'completed'),
      init, text('Job two is done.'), result('Job two is done.'),
    ];
    await sendToAgent(KEY, 'run both', { onSubTurnResponse: (t) => { firstSubTurns.push(t); } });
    await vi.waitFor(() => expect(secondTurn).toBeDefined());
    const second = await secondTurn!;
    await getHeldQuery(KEY)?.feed.closed;
    await vi.waitFor(() => expect(firstSubTurns).toEqual(['Job one is done.']));
    expect(second.text).toBe('Job two is still running.');
    expect(fx.queries).toBe(1);
  });

  it("lets go of a held query the next turn can't join, and starts a fresh one once it has closed", async () => {
    fx.script = [
      lifecycle(0, 'started'),
      init, backgroundBash('b1'), started('b1'), text('Building.'), result('Building.'),
      // The CLI stops the task when its input ends.
      async () => { while (!fx.inputEnded) await tick(); },
      notified('b1', 'stopped'),
    ];
    await sendToAgent(KEY, 'build it');
    // A /clear: the next turn starts a new conversation.
    sessionManager.startNewConversation(KEY);
    (await import('../../src/claude/agent.js')).clearConversation(KEY);
    fx.script = [lifecycle(0, 'started'), init, text('Fresh.'), result('Fresh.')];
    const queriesBefore = fx.queries;
    fx.prompts = [];
    const response = await sendToAgent(KEY, 'hello');
    expect(response.text).toBe('Fresh.');
    expect(fx.queries).toBe(queriesBefore + 1);
  });
});
