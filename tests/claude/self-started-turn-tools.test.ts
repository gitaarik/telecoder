/**
 * An MCP tool claude calls in a turn it started itself — when a background
 * task reports back between TeleCoder's turns — runs in the session's chat.
 *
 * It used to find no turn. The IPC server acked it like a stray hook, with no
 * message; mcp-server built the tool's result from that message, and the MCP
 * SDK rejected the empty text block with -32602. A question asked in such a
 * turn was never posted, and the model got a schema dump instead of a reason.
 *
 * These drive the real IPC server over loopback HTTP and the real ask_user
 * handler, with a stand-in for Telegram.
 */

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import * as http from 'http';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

const fx = vi.hoisted(() => ({ settleBeforePost: vi.fn(), proseSent: vi.fn() }));

vi.mock('../../src/claude/monitor-relay.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/claude/monitor-relay.js')>()),
  settleBeforePost: fx.settleBeforePost,
}));
vi.mock('../../src/telegram/message-sender.js', () => ({
  messageSender: {
    sendMessage: async (...args: unknown[]) => { fx.proseSent(...args); return 1; },
    noteQuestionPosted: async () => {},
    noteQuestionAnswered: async () => {},
  },
}));

const {
  startIpcServer,
  getIpcPort,
  registerIpcHandler,
  registerActiveTurn,
  unregisterActiveTurn,
  registerSessionChat,
  unregisterSessionChat,
} = await import('../../src/claude/ipc-server.js');
await import('../../src/claude/mcp-bridge.js');
const { resolvePendingQuestion } = await import('../../src/claude/ask-user.js');
const { toolResult } = await import('../../src/bin/tool-result.js');

/** POST `body` to the IPC route `route` as claude session `sessionId`, and read the answer. */
function post(route: string, sessionId: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const data = JSON.stringify({ session_id: sessionId, ...body });
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: getIpcPort(),
      path: route,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve(JSON.parse(text)));
    });
    req.on('error', reject);
    req.end(data);
  });
}

const hookCalls: string[] = [];

beforeAll(async () => {
  await startIpcServer();
  registerIpcHandler('/mcp/test_where', (turn) => ({
    success: true,
    message: `${turn.sessionKey}, ${turn.selfStarted ? 'a turn claude started' : "TeleCoder's turn"}`,
  }));
  registerIpcHandler('/hook/test_where', (turn) => {
    hookCalls.push(turn.sessionKey);
    return { ok: true };
  });
});

afterEach(() => {
  for (const id of ['s1', 's2']) {
    unregisterActiveTurn(id);
    unregisterSessionChat(id);
  }
  hookCalls.length = 0;
  fx.settleBeforePost.mockClear();
  fx.proseSent.mockClear();
});

describe('routing between turns', () => {
  it("runs a tool in the session's chat when no turn of TeleCoder's is running", async () => {
    registerSessionChat('s1', '100', { chat: { id: 100 } });
    expect(await post('/mcp/test_where', 's1')).toEqual({ success: true, message: '100, a turn claude started' });
  });

  it("gives a tool the turn TeleCoder is running while there is one", async () => {
    registerSessionChat('s1', '100', { chat: { id: 100 } });
    registerActiveTurn('s1', { sessionKey: '100', options: {} });
    expect(await post('/mcp/test_where', 's1')).toEqual({ success: true, message: "100, TeleCoder's turn" });
    unregisterActiveTurn('s1');
    expect(await post('/mcp/test_where', 's1')).toEqual({ success: true, message: '100, a turn claude started' });
  });

  it('leaves a hook outside a turn acked and ignored, as it was', async () => {
    registerSessionChat('s1', '100', { chat: { id: 100 } });
    expect(await post('/hook/test_where', 's1')).toEqual({ ok: true, ignored: true });
    expect(hookCalls).toEqual([]);
  });

  it('tells a tool with no chat on record that it did nothing, in words', async () => {
    const answer = await post('/mcp/test_where', 's1');
    expect(answer.success).toBe(false);
    expect(answer.message).toMatch(/no Telegram chat on record/);

    registerSessionChat('s1', '100', { chat: { id: 100 } });
    unregisterSessionChat('s1');
    expect((await post('/mcp/test_where', 's1')).success).toBe(false);
  });
});

describe('ask_user in a turn claude started itself', () => {
  it("posts the question in the session's chat and returns the answer", async () => {
    const sendMessage = vi.fn(async () => ({ message_id: 9, chat: { id: 200 } }));
    registerSessionChat('s2', '200:7', { chat: { id: 200 }, api: { sendMessage } });

    const answer = post('/mcp/ask_user', 's2', {
      question: 'Snapshot the box now?',
      context: 'The box is up and the tools are installed.',
      options: [{ label: 'Snapshot now' }, { label: 'Later' }],
    });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalled());

    const [chatId, text, extra] = sendMessage.mock.lastCall as unknown as [
      number, string, { message_thread_id?: number; reply_markup: { inline_keyboard: { callback_data: string }[][] } },
    ];
    expect(chatId).toBe(200);
    expect(text).toContain('Snapshot the box now?');
    expect(extra.message_thread_id).toBe(7);

    const [, id] = extra.reply_markup.inline_keyboard[0]![0]!.callback_data.split(':');
    resolvePendingQuestion(id!, 0);
    expect(await answer).toEqual({ success: true, message: 'User selected: Snapshot now' });

    // Its prose is the monitor relay's to send, which settling has it do
    // above the question, rather than the flush a submitted turn gets.
    expect(fx.settleBeforePost).toHaveBeenCalledWith('200:7');
    expect(fx.proseSent).not.toHaveBeenCalled();
  });
});

describe('the tool result mcp-server builds', () => {
  it('passes the message on, as an error when the bot says it failed', () => {
    expect(toolResult({ success: true, message: 'Sent.' })).toEqual({ content: [{ type: 'text', text: 'Sent.' }], isError: false });
    expect(toolResult({ success: false, message: 'No chat.' }).isError).toBe(true);
  });

  it('is one the MCP SDK accepts even when the bot answers without a message', () => {
    const ignored = { ok: true, ignored: true } as unknown as Parameters<typeof toolResult>[0];
    // What it used to build from that answer, which the SDK refused.
    expect(CallToolResultSchema.safeParse({ content: [{ type: 'text', text: undefined }], isError: true }).success).toBe(false);

    const result = toolResult(ignored);
    expect(CallToolResultSchema.safeParse(result).success).toBe(true);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/may not have been done/);
  });
});
