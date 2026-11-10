/**
 * telecoder_request_secret through the real IPC server and the real
 * /mcp/request_secret route, with a stand-in for Telegram: the way the MCP
 * subprocess reaches it in PTY mode.
 */

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { Context } from 'grammy';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

vi.mock('../../src/telegram/message-sender.js', () => ({
  messageSender: {
    sendMessage: async () => 1,
    noteQuestionPosted: async () => {},
    noteQuestionAnswered: async () => {},
  },
}));

const { startIpcServer, getIpcPort, registerActiveTurn, unregisterActiveTurn } = await import('../../src/claude/ipc-server.js');
await import('../../src/claude/mcp-bridge.js');
const { captureSecretMessages, hasPendingSecret } = await import('../../src/claude/secret-request.js');
const { toolResult } = await import('../../src/bin/tool-result.js');

const ADMIN = 1;
const SECRET = 'sk-test-0f9e8d7c6b5a';

function fakeApi() {
  return {
    sendMessage: vi.fn(async (chatId: number) => ({ message_id: 77, chat: { id: chatId } })),
    editMessageText: vi.fn(async () => true),
    deleteMessage: vi.fn(async () => true),
  };
}

/** POST to the route as claude session `sessionId`. `hangUp` gets a way to drop the call. */
function post(
  sessionId: string,
  body: Record<string, unknown>,
  hangUp?: (drop: () => void) => void,
): Promise<Record<string, unknown>> {
  const data = JSON.stringify({ session_id: sessionId, ...body });
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: getIpcPort(),
      path: '/mcp/request_secret',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve(JSON.parse(text)));
    });
    req.on('error', reject);
    req.end(data);
    hangUp?.(() => req.destroy());
  });
}

async function userSends(api: ReturnType<typeof fakeApi>, text: string): Promise<void> {
  const ctx = {
    chat: { id: ADMIN, type: 'private' },
    from: { id: ADMIN },
    message: { message_id: 900, chat: { id: ADMIN }, text },
    api,
  } as unknown as Context;
  await captureSecretMessages(ctx, async () => {
    throw new Error('the secret went past the middleware');
  });
}

beforeAll(async () => {
  await startIpcServer();
});

afterEach(() => {
  unregisterActiveTurn('claude-1');
});

describe('/mcp/request_secret', () => {
  it('runs the command with what the user sends, and answers the tool with the result', async () => {
    const api = fakeApi();
    registerActiveTurn('claude-1', { sessionKey: String(ADMIN), options: { telegramCtx: { chat: { id: ADMIN, type: 'private' }, api } } });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-ipc-'));

    const reply = post('claude-1', {
      name: 'API_KEY',
      purpose: 'For the test.',
      command: 'umask 077 && cat > stored && echo stored it',
      cwd: dir,
    });
    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalled());
    await userSends(api, SECRET);

    const answer = await reply;
    expect(answer.success).toBe(true);
    expect(String(answer.message)).toContain('your command ran with it: exit 0.');
    expect(String(answer.message)).toContain('stored it');
    expect(JSON.stringify(answer)).not.toContain(SECRET);
    expect(fs.readFileSync(path.join(dir, 'stored'), 'utf8')).toBe(`${SECRET}\n`);
    expect((fs.statSync(path.join(dir, 'stored')).mode & 0o777).toString(8)).toBe('600');
    expect(CallToolResultSchema.safeParse(toolResult(answer as never)).success).toBe(true);
  });

  it('withdraws the request when the tool call hangs up', async () => {
    const api = fakeApi();
    registerActiveTurn('claude-1', { sessionKey: String(ADMIN), options: { telegramCtx: { chat: { id: ADMIN, type: 'private' }, api } } });
    let drop!: () => void;
    const reply = post('claude-1', { name: 'API_KEY', purpose: 'p', command: 'cat > /dev/null' }, (d) => {
      drop = d;
    });
    reply.catch(() => {});
    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalled());
    expect(hasPendingSecret(String(ADMIN))).toBe(true);

    drop();
    await vi.waitFor(() => expect(hasPendingSecret(String(ADMIN))).toBe(false));
    await vi.waitFor(() =>
      expect(api.editMessageText).toHaveBeenCalledWith(ADMIN, 77, expect.stringContaining('🚫 Claude stopped waiting for it.'), expect.anything()));
  });

  it('says what is wrong with a request before asking anyone', async () => {
    const api = fakeApi();
    registerActiveTurn('claude-1', { sessionKey: String(ADMIN), options: { telegramCtx: { chat: { id: ADMIN, type: 'private' }, api } } });
    expect(await post('claude-1', { purpose: 'p', command: 'true' })).toEqual({ success: false, message: 'Error: name is required.' });
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
});
