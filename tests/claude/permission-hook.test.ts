/**
 * The PTY permission gate, end to end: the PreToolUse hook command claude runs,
 * the loopback IPC server it calls, and the bot's preToolUse handler.
 *
 * Three properties matter. The hook fails closed — only an explicit allow lets
 * a tool run, so a bot that is restarting or erroring blocks it. A tool called
 * between TeleCoder's turns (a background agent, a turn claude started itself)
 * still goes through the gate, in the session's chat. And the IPC server only
 * answers callers holding this process's token, which reaches them through the
 * environment, never through the process arguments `ps` shows.
 *
 * The hook command runs for real under /bin/sh with curl, against the real IPC
 * server or a stand-in for it, with Telegram stubbed.
 */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import * as http from 'http';
import { spawn } from 'child_process';

vi.hoisted(() => {
  // Resolved at import; nothing here spawns a pty.
  process.env.CLAUDE_BIN = '/bin/true';
});

vi.mock('node-pty', () => ({ spawn: () => { throw new Error('no pty in this suite'); } }));

vi.mock('../../src/claude/session-manager.js', () => ({
  sessionManager: {
    getSession: () => ({ workingDirectory: process.cwd(), claudeSessionId: 'sess-1' }),
    setClaudeSessionId: () => {},
  },
}));

const { config } = await import('../../src/config.js');
const {
  startIpcServer,
  getIpcPort,
  getIpcToken,
  registerActiveTurn,
  unregisterActiveTurn,
  registerSessionChat,
  unregisterSessionChat,
  IPC_TOKEN_ENV,
} = await import('../../src/claude/ipc-server.js');
await import('../../src/claude/pty-provider.js');
const { buildSettingsJson, buildMcpEnv, buildMcpConfigJson, GATE_UNREACHABLE_REASON } =
  await import('../../src/claude/pty-spawn-config.js');
const { ALLOW_MARKER, DENY_MARKER_START, hookCurlTimeoutSeconds, hookTimeoutSeconds } =
  await import('../../src/claude/permission-gate.js');
const { resolvePendingQuestion } = await import('../../src/claude/ask-user.js');
const { getPromptResponderIds } = await import('../../src/utils/admins.js');

interface HookRun { code: number | null; stderr: string }

type HookEntry = { command: string; timeout?: number };

function hooksFor(port: number, event = 'PreToolUse'): HookEntry[] {
  return JSON.parse(buildSettingsJson(port)).hooks[event][0].hooks;
}

/** Run claude's PreToolUse hook command for `port` the way claude does: payload on stdin. */
function runHook(
  port: number,
  payload: Record<string, unknown>,
  env: Record<string, string> = { [IPC_TOKEN_ENV]: getIpcToken() },
): Promise<HookRun> {
  const [{ command }] = hooksFor(port);
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], { env: { PATH: process.env.PATH ?? '', ...env } });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

/** A stand-in bot that answers every request with `status` and `body`, recording the headers. */
async function standIn(status: number, body: string): Promise<{ port: number; headers: http.IncomingHttpHeaders[]; close: () => void }> {
  const headers: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => {
    headers.push(req.headers);
    req.resume();
    req.on('end', () => { res.writeHead(status); res.end(body); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { port, headers, close: () => server.close() };
}

/** A port nothing listens on: the bot between a crash and its restart. */
async function deadPort(): Promise<number> {
  const s = await standIn(200, '');
  s.close();
  return s.port;
}

function post(route: string, body: Record<string, unknown>, token?: string): Promise<{ status: number; body: string }> {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: getIpcPort(),
      path: route,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...(token !== undefined ? { 'X-TeleCoder-Token': token } : {}),
      },
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

const SUDO = { tool_name: 'Bash', tool_input: { command: 'sudo systemctl restart nginx' } };
const LS = { tool_name: 'Bash', tool_input: { command: 'ls' } };

beforeAll(async () => {
  await startIpcServer();
});

afterEach(() => {
  vi.unstubAllEnvs();
  unregisterActiveTurn('sess-1');
  unregisterSessionChat('sess-1');
});

describe('the PreToolUse hook command', () => {
  it('lets the tool run only on the explicit allow', async () => {
    const bot = await standIn(200, JSON.stringify(ALLOW_MARKER));
    expect((await runHook(bot.port, LS)).code).toBe(0);
    bot.close();
  });

  it('blocks with the reason on a deny', async () => {
    const bot = await standIn(200, JSON.stringify(`${DENY_MARKER_START}nope: sudo__END__`));
    expect(await runHook(bot.port, SUDO)).toEqual({ code: 2, stderr: 'nope: sudo' });
    bot.close();
  });

  it.each([
    ['an empty reply', 200, ''],
    ['the old bare ack', 200, '{"ok":true}'],
    ['a server error', 500, '{"error":"boom"}'],
    ['a refused token', 401, '{"error":"unauthorized"}'],
    ['an allow marker inside other text', 200, `{"error":"${ALLOW_MARKER} x"}`],
  ])('blocks on %s', async (_name, status, body) => {
    const bot = await standIn(status, body);
    expect(await runHook(bot.port, LS)).toEqual({ code: 2, stderr: GATE_UNREACHABLE_REASON });
    bot.close();
  });

  it('blocks when the bot is not there at all', async () => {
    expect(await runHook(await deadPort(), LS)).toEqual({ code: 2, stderr: GATE_UNREACHABLE_REASON });
  });

  it('sends the token from its environment, which the settings JSON never contains', async () => {
    const bot = await standIn(200, JSON.stringify(ALLOW_MARKER));
    await runHook(bot.port, LS, { [IPC_TOKEN_ENV]: 'from-the-env' });
    expect(bot.headers[0]!['x-telecoder-token']).toBe('from-the-env');
    bot.close();

    expect(buildSettingsJson(1234)).not.toContain(getIpcToken());
    expect(buildSettingsJson(1234)).toContain(`$${IPC_TOKEN_ENV}`);
  });

  it('outlasts the permission prompt, and claude outlasts curl', () => {
    const previous = config.PERMISSION_PROMPT_TIMEOUT_MINUTES;
    try {
      for (const minutes of [10, 30]) {
        config.PERMISSION_PROMPT_TIMEOUT_MINUTES = minutes;
        const [hook] = hooksFor(1234);
        expect(hookCurlTimeoutSeconds()).toBeGreaterThan(minutes * 60);
        expect(hook!.command).toContain(`--max-time ${hookCurlTimeoutSeconds()} `);
        expect(hook!.timeout).toBe(hookTimeoutSeconds());
        expect(hook!.timeout!).toBeGreaterThan(hookCurlTimeoutSeconds());
      }
    } finally {
      config.PERMISSION_PROMPT_TIMEOUT_MINUTES = previous;
    }
  });
});

describe('the IPC token', () => {
  it('turns away a call without it, or with the wrong one', async () => {
    registerActiveTurn('sess-1', { sessionKey: '100', options: {} });
    expect((await post('/hook/preToolUse', { session_id: 'sess-1', ...LS })).status).toBe(401);
    expect((await post('/hook/preToolUse', { session_id: 'sess-1', ...LS }, 'x'.repeat(64))).status).toBe(401);
    expect((await post('/mcp/list_projects', { session_id: 'sess-1' }, '')).status).toBe(401);
    expect((await post('/hook/preToolUse', { session_id: 'sess-1', ...LS }, getIpcToken())).status).toBe(200);
  });

  it('stays out of the MCP config, which is a process argument', () => {
    vi.stubEnv(IPC_TOKEN_ENV, 'inherited-from-a-parent-bot');
    vi.stubEnv('CLAUDEGRAM_IPC_TOKEN', 'inherited-the-old-way');
    const json = buildMcpConfigJson(buildMcpEnv({ TELECODER_IPC_PORT: '1' }));
    expect(json).not.toContain('inherited');
    expect(json).not.toContain(getIpcToken());
  });
});

describe('the gate through the real hook and IPC server', () => {
  const hook = (payload: Record<string, unknown>) => runHook(getIpcPort(), { session_id: 'sess-1', ...payload });

  it('allows everything without prompting when the gate is off, turn or no turn', async () => {
    vi.stubEnv('TELECODER_PERMISSION_PROMPTS', '0');
    expect((await hook(SUDO)).code).toBe(0);

    registerActiveTurn('sess-1', { sessionKey: '100', options: {} });
    expect((await hook(SUDO)).code).toBe(0);
  });

  it('allows a harmless tool in a turn with the gate on', async () => {
    vi.stubEnv('TELECODER_PERMISSION_PROMPTS', '1');
    registerActiveTurn('sess-1', { sessionKey: '100', options: {} });
    expect((await hook(LS)).code).toBe(0);
  });

  it('denies when the gate is on and no chat is on record for the session', async () => {
    vi.stubEnv('TELECODER_PERMISSION_PROMPTS', '1');
    const run = await hook(LS);
    expect(run.code).toBe(2);
    expect(run.stderr).toMatch(/no Telegram chat on record/);
  });

  it("prompts the session's chat for a tool called between TeleCoder's turns", async () => {
    vi.stubEnv('TELECODER_PERMISSION_PROMPTS', '1');
    const sendMessage = vi.fn(async (chatId: number) => ({ message_id: 5, chat: { id: chatId } }));
    const getChatMember = vi.fn(async () => { throw new Error('not in chat'); });
    registerSessionChat('sess-1', '300', { chat: { id: 300 }, from: { id: 1, first_name: 'Rik' }, api: { sendMessage, getChatMember } });

    const approver = getPromptResponderIds(1)[0];

    // Harmless: no prompt.
    expect((await hook(LS)).code).toBe(0);
    expect(sendMessage).not.toHaveBeenCalled();

    // Dangerous: prompted, then allowed on the tap.
    const allowed = hook(SUDO);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalled());
    const [chatId, , extra] = sendMessage.mock.lastCall as unknown as [
      number, string, { reply_markup: { inline_keyboard: { callback_data: string }[][] } },
    ];
    expect(chatId).toBe(300);
    const [, id] = extra.reply_markup.inline_keyboard[0]![0]!.callback_data.split(':');
    resolvePendingQuestion(id!, 0, approver);
    expect((await allowed).code).toBe(0);

    // And denied on the other button.
    const denied = hook(SUDO);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    const [, , extra2] = sendMessage.mock.lastCall as unknown as [
      number, string, { reply_markup: { inline_keyboard: { callback_data: string }[][] } },
    ];
    const [, id2] = extra2.reply_markup.inline_keyboard[1]![0]!.callback_data.split(':');
    resolvePendingQuestion(id2!, 1, approver);
    const run = await denied;
    expect(run.code).toBe(2);
    expect(run.stderr).toMatch(/denied: sudo/);
  });
});

afterAll(() => {
  vi.unstubAllEnvs();
});
