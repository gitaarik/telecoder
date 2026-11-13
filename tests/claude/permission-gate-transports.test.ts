/**
 * The permission gate decides the same way on both transports.
 *
 * The PTY transport runs it as a PreToolUse command hook that calls back into
 * the bot over IPC; the SDK transport (and CCR, which always takes the SDK
 * path) as an in-process PreToolUse callback handed to the agent SDK. For a
 * long time only the first existed, so a guest on a default install — SDK —
 * got an unsupervised shell. One table of tool calls and chat settings runs
 * through both, so neither can drift from the other again.
 *
 * Each side is driven through its real wiring: the `/hook/preToolUse` handler
 * pty-provider.ts registers, and the hooks agent.ts's sendToAgent passes to
 * `query()`. Telegram is a stand-in that records what was posted.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import type { Context } from 'grammy';

const fx = vi.hoisted(() => {
  const nodeFs = process.getBuiltinModule('fs');
  const nodeOs = process.getBuiltinModule('os');
  const nodePath = process.getBuiltinModule('path');
  process.env.TELECODER_TEST_HOME = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'telecoder-gate-transports-'));
  // Resolved when pty-provider loads; no terminal is ever spawned here.
  process.env.CLAUDE_BIN = '/bin/true';
  return {
    ipcHandlers: new Map<string, (turn: unknown, body: Record<string, unknown>) => unknown>(),
    /** The options of each query() call, newest last. */
    queryOptions: [] as Record<string, unknown>[],
  };
});

vi.mock('node-pty', () => ({ spawn: () => { throw new Error('no pty in this test'); } }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: actual, homedir: () => process.env.TELECODER_TEST_HOME ?? actual.homedir() };
});

vi.mock('../../src/claude/ipc-server.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/claude/ipc-server.js')>();
  return {
    ...actual,
    getIpcPort: () => 45679,
    registerIpcHandler: (route: string, fn: (turn: unknown, body: Record<string, unknown>) => unknown) => {
      fx.ipcHandlers.set(route, fn);
    },
  };
});

// A CLI that answers each prompt at once, so sendToAgent hands its hooks over
// and returns.
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  return {
    ...actual,
    query: ({ prompt, options }: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
      fx.queryOptions.push(options);
      const reading = (async () => { for await (const _ of prompt) { /* drain */ } })();
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'system', subtype: 'init', session_id: 'gate-sess', model: 'm', cwd: process.cwd(), tools: [], slash_commands: [], skills: [] };
          yield { type: 'result', subtype: 'success', session_id: 'gate-sess', result: 'ok' };
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

await import('../../src/claude/pty-provider.js');
const { sendToAgent } = await import('../../src/claude/agent.js');
const { sessionManager } = await import('../../src/claude/session-manager.js');
const { userPreferences } = await import('../../src/providers/user-preferences.js');
const { resolvePendingQuestion } = await import('../../src/claude/ask-user.js');
const { openWindow, resetAutoApprove } = await import('../../src/claude/auto-approve.js');
const { DENY_MARKER_START, DENY_MARKER_END } = await import('../../src/claude/permission-gate.js');
type HookCallbackMatcher = import('@anthropic-ai/claude-agent-sdk').HookCallbackMatcher;

const CHAT = -1009990001;
const KEY = String(CHAT);
/** In vitest.config's ALLOWED_USER_IDS, and with no ADMIN_USER_IDS, all admins. */
const REQUESTER = 3;
const APPROVER = 1;

interface Decision { block: boolean; reason: string }

/** A stand-in for the update behind the turn. `answer` taps a button on any prompt it posts. */
function fakeCtx(answer?: 'allow' | 'deny') {
  const sendMessage = vi.fn(async (_chat: number, _text: string, opts?: { reply_markup?: { inline_keyboard: { callback_data: string }[][] } }) => {
    const data = opts?.reply_markup?.inline_keyboard[0]?.[0]?.callback_data;
    if (data && answer) {
      const id = data.split(':')[1]!;
      // After the gate starts awaiting it, as a real tap would be.
      setTimeout(() => resolvePendingQuestion(id, answer === 'allow' ? 0 : 1, APPROVER), 0);
    }
    return { message_id: 7, chat: { id: CHAT } };
  });
  const ctx = {
    chat: { id: CHAT, type: 'supergroup' },
    from: { id: REQUESTER, first_name: 'Guest' },
    api: {
      sendMessage,
      editMessageText: vi.fn().mockResolvedValue(true),
      editMessageReplyMarkup: vi.fn().mockResolvedValue(true),
      getChatMember: vi.fn().mockRejectedValue(new Error('not a member')),
    },
  } as unknown as Context;
  return { ctx, sendMessage };
}

/** A context that breaks the gate the moment it looks at the chat. */
function brokenCtx(): Context {
  return { get chat(): never { throw new Error('boom'); } } as unknown as Context;
}

interface ToolCall { tool: string; input: Record<string, unknown>; agentId?: string }

interface Transport {
  name: string;
  decide(call: ToolCall, ctx: Context | undefined): Promise<Decision>;
}

const pty: Transport = {
  name: 'pty',
  async decide(call, ctx) {
    const handler = fx.ipcHandlers.get('/hook/preToolUse');
    if (!handler) throw new Error('pty-provider registered no preToolUse handler');
    const turn = { sessionKey: KEY, options: { telegramCtx: ctx }, onToolStart: () => {}, onToolEnd: () => {} };
    const out = await handler(turn, {
      session_id: 'gate-sess', tool_name: call.tool, tool_input: call.input, tool_use_id: 'tu-1',
      ...(call.agentId ? { agent_id: call.agentId } : {}),
    });
    // What the shell wrapper in pty-spawn-config.ts reads.
    if (typeof out === 'string' && out.includes(DENY_MARKER_START)) {
      return { block: true, reason: out.split(DENY_MARKER_START)[1]!.split(DENY_MARKER_END)[0]! };
    }
    return { block: false, reason: '' };
  },
};

const sdk: Transport = {
  name: 'sdk',
  async decide(call, ctx) {
    await sendToAgent(KEY, 'go', { telegramCtx: ctx });
    const hooks = fx.queryOptions.at(-1)?.hooks as Record<string, HookCallbackMatcher[]> | undefined;
    const matchers = hooks?.PreToolUse ?? [];
    // As the CLI runs them: every matcher, the first deny wins.
    for (const matcher of matchers) {
      for (const hook of matcher.hooks) {
        const out = await hook({
          hook_event_name: 'PreToolUse', session_id: 'gate-sess', transcript_path: '/dev/null', cwd: '/tmp',
          tool_name: call.tool, tool_input: call.input, tool_use_id: 'tu-1',
          ...(call.agentId ? { agent_id: call.agentId } : {}),
        }, 'tu-1', { signal: new AbortController().signal });
        const specific = (out as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput;
        if (specific?.permissionDecision === 'deny') {
          return { block: true, reason: specific.permissionDecisionReason ?? '' };
        }
      }
    }
    return { block: false, reason: '' };
  },
};

interface Case {
  name: string;
  gate: '0' | '1';
  call: ToolCall;
  ctx: 'allow' | 'deny' | 'silent' | 'none' | 'broken';
  window?: boolean;
  expect: { block: boolean; prompts: number; notices?: number; reason?: RegExp };
}

const bash = (command: string): ToolCall => ({ tool: 'Bash', input: { command } });

const CASES: Case[] = [
  { name: 'gate off: a guarded command runs, nothing is posted', gate: '0', call: bash('rm -rf build'), ctx: 'silent', expect: { block: false, prompts: 0 } },
  { name: 'gate off: even with no chat to ask', gate: '0', call: bash('sudo reboot'), ctx: 'none', expect: { block: false, prompts: 0 } },
  { name: 'an unguarded command runs without a prompt', gate: '1', call: bash('ls -la'), ctx: 'silent', expect: { block: false, prompts: 0 } },
  { name: 'an unguarded edit inside the workspace runs', gate: '1', call: { tool: 'Write', input: { file_path: '/tmp/telecoder-test-workspace/a.txt', content: 'x' } }, ctx: 'silent', expect: { block: false, prompts: 0 } },
  { name: 'a guarded command runs once approved', gate: '1', call: bash('rm -rf build'), ctx: 'allow', expect: { block: false, prompts: 1 } },
  { name: 'a guarded command is blocked when denied', gate: '1', call: bash('sudo reboot'), ctx: 'deny', expect: { block: true, prompts: 1, reason: /denied: sudo/ } },
  { name: 'the scope guard prompts for a path outside the workspace', gate: '1', call: { tool: 'Read', input: { file_path: '/etc/shadow' } }, ctx: 'deny', expect: { block: true, prompts: 1, reason: /\/etc\/shadow/ } },
  { name: "a subagent's guarded call is gated like the main thread's", gate: '1', call: { ...bash('git push --force'), agentId: 'sub-1' }, ctx: 'deny', expect: { block: true, prompts: 1, reason: /git push --force/ } },
  { name: 'no chat to ask in: denied without a prompt', gate: '1', call: bash('rm -rf build'), ctx: 'none', expect: { block: true, prompts: 0, reason: /no Telegram context/ } },
  { name: 'an open auto-approve window lets it through and posts a notice', gate: '1', call: bash('rm -rf build'), ctx: 'silent', window: true, expect: { block: false, prompts: 0, notices: 1 } },
  { name: 'a gate that throws denies', gate: '1', call: bash('rm -rf build'), ctx: 'broken', expect: { block: true, prompts: 0, reason: /could not evaluate/ } },
];

beforeAll(() => {
  sessionManager.createSession(KEY, '/tmp/telecoder-test-workspace');
});

beforeEach(() => {
  resetAutoApprove();
  fx.queryOptions.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetAutoApprove();
});

describe.each([pty, sdk])('permission gate on the $name transport', (transport) => {
  it.each(CASES)('$name', async (c) => {
    vi.stubEnv('TELECODER_PERMISSION_PROMPTS', c.gate);
    if (c.window) openWindow(CHAT, { openedBy: 1, openedByName: 'Ann', durationMs: 30 * 60 * 1000 });
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});

    const fake = c.ctx === 'none' || c.ctx === 'broken' ? undefined : fakeCtx(c.ctx === 'silent' ? undefined : c.ctx);
    const ctx = c.ctx === 'broken' ? brokenCtx() : fake?.ctx;
    const decision = await transport.decide(c.call, ctx);
    quiet.mockRestore();

    expect(decision.block).toBe(c.expect.block);
    if (c.expect.reason) expect(decision.reason).toMatch(c.expect.reason);
    const posted = fake?.sendMessage.mock.calls ?? [];
    const prompts = posted.filter(([, , opts]) => opts?.reply_markup !== undefined);
    expect(prompts).toHaveLength(c.expect.prompts);
    expect(posted.length - prompts.length).toBe(c.expect.notices ?? 0);
  });
});

describe('the SDK transport', () => {
  it('registers the gate in every /mode, bypass included, as the PTY hook runs in every mode', async () => {
    for (const mode of ['manual', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'] as const) {
      userPreferences.setPermissionMode(KEY, mode);
      fx.queryOptions.length = 0;
      await sendToAgent(KEY, 'go', { telegramCtx: fakeCtx().ctx });
      const hooks = fx.queryOptions.at(-1)?.hooks as Record<string, HookCallbackMatcher[]>;
      expect(hooks.PreToolUse?.length, mode).toBeGreaterThan(0);
    }
    userPreferences.setPermissionMode(KEY, 'acceptEdits');
  });

  it("gives the hook longer than an unanswered prompt waits, so the gate's denial ends it", async () => {
    await sendToAgent(KEY, 'go', { telegramCtx: fakeCtx().ctx });
    const hooks = fx.queryOptions.at(-1)?.hooks as Record<string, HookCallbackMatcher[]>;
    // PERMISSION_PROMPT_TIMEOUT_MINUTES defaults to 10.
    expect(hooks.PreToolUse![0]!.timeout).toBeGreaterThan(10 * 60);
  });

  it("prompts on behalf of the latest turn's sender, not the one that started the query", async () => {
    vi.stubEnv('TELECODER_PERMISSION_PROMPTS', '1');
    await sendToAgent(KEY, 'first', { telegramCtx: fakeCtx().ctx });
    const firstHooks = fx.queryOptions.at(-1)?.hooks as Record<string, HookCallbackMatcher[]>;
    const second = fakeCtx('deny');
    await sendToAgent(KEY, 'second', { telegramCtx: second.ctx });

    // The first query's hook, as a held query's would be, asked after the second turn.
    const out = await firstHooks.PreToolUse![0]!.hooks[0]!({
      hook_event_name: 'PreToolUse', session_id: 'gate-sess', transcript_path: '/dev/null', cwd: '/tmp',
      tool_name: 'Bash', tool_input: { command: 'sudo reboot' }, tool_use_id: 'tu-2',
    }, 'tu-2', { signal: new AbortController().signal });
    expect(second.sendMessage).toHaveBeenCalledTimes(1);
    expect((out as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision).toBe('deny');
  });
});
