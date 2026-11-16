/**
 * /status's 📐 Context line reads the same figure as the usage footer under
 * every reply.
 *
 * Drives the real handler against a session made under a scratch home, so
 * nothing here touches the real ~/.telecoder.
 */

import { describe, it, expect, vi, afterAll } from 'vitest';
import type { Context } from 'grammy';
import type { MessageEntity } from 'grammy/types';
import type { AgentUsage } from '../../src/providers/types.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const mocked = { ...actual, homedir: () => process.env.TELECODER_TEST_HOME ?? actual.homedir() };
  return { ...mocked, default: mocked };
});

let usage: AgentUsage | undefined;
vi.mock('../../src/providers/provider-router.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/providers/provider-router.js')>();
  return { ...actual, getCachedUsage: (key: string) => usage ?? actual.getCachedUsage(key) };
});

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-status-'));
process.env.TELECODER_TEST_HOME = home;

const { handleStatus } = await import('../../src/bot/handlers/command.handler.js');
const { sessionManager } = await import('../../src/claude/session-manager.js');
const { sessionJsonlPath } = await import('../../src/claude/session-jsonl.js');
const { userPreferences } = await import('../../src/providers/user-preferences.js');

/** The reply's text, after checking its label went out bold. */
function contextLine(reply: ReturnType<typeof vi.fn>): string {
  const [text, opts] = reply.mock.calls[0]! as [string, { entities?: MessageEntity[]; parse_mode?: string }];
  expect(opts.parse_mode).toBeUndefined();
  const at = text.indexOf('Context:');
  expect(opts.entities).toContainEqual({ type: 'bold', offset: at, length: 'Context:'.length });
  return text;
}

afterAll(() => {
  delete process.env.TELECODER_TEST_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

/** The last reply's usage in a long PTY conversation: nearly all of it cache reads. */
const WARM_CACHE: AgentUsage = {
  inputTokens: 2,
  outputTokens: 320,
  cacheReadTokens: 535221,
  cacheWriteTokens: 876,
  totalCostUsd: 0,
  sessionCostUsd: 0,
  sessionCostTurns: 0,
  contextWindow: 1_000_000,
  numTurns: 12,
  model: 'claude-opus-5-5',
};

describe('/status', () => {
  it('counts cache reads in the context line', async () => {
    const chat = 400;
    const project = path.join(home, 'project');
    fs.mkdirSync(project, { recursive: true });
    sessionManager.createSession(String(chat), project);
    usage = WARM_CACHE;

    const reply = vi.fn(async (_text: string, _opts?: unknown) => ({}));
    await handleStatus({ chat: { id: chat }, message: { text: '/status' }, reply } as unknown as Context);

    expect(contextLine(reply)).toContain('📐 Context: 54% (536.4k/1.0M)');
  });

  it('reads it from the session log when no turn has cached one, as after a jump', async () => {
    const chat = 401;
    const project = path.join(home, 'project-401');
    fs.mkdirSync(project, { recursive: true });
    const file = sessionJsonlPath(project, 'branch');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [{ type: 'text', text: 'Two stages.' }],
        usage: { input_tokens: 2, output_tokens: 320, cache_read_input_tokens: 299_678 },
      },
    }) + '\n');
    sessionManager.createSession(String(chat), project);
    sessionManager.setClaudeSessionId(String(chat), 'branch');
    usage = undefined;

    const reply = vi.fn(async (_text: string, _opts?: unknown) => ({}));
    await handleStatus({ chat: { id: chat }, message: { text: '/status' }, reply } as unknown as Context);

    expect(contextLine(reply)).toContain('📐 Context: 30% (300.0k/1.0M)');
  });

  it('names the effort and model that served the last reply, and who picked them', async () => {
    const chat = 402;
    const project = path.join(home, 'project-402');
    fs.mkdirSync(project, { recursive: true });
    const file = sessionJsonlPath(project, 'served');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      { type: 'api-request', params: { model: 'claude-fable-5-1', output_config: { effort: 'high' } } },
      {
        type: 'assistant',
        message: { role: 'assistant', model: 'claude-fable-5-1', content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 2, output_tokens: 20 } },
      },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    sessionManager.createSession(String(chat), project);
    sessionManager.setClaudeSessionId(String(chat), 'served');
    usage = undefined;

    const reply = vi.fn(async (_text: string, _opts?: unknown) => ({}));
    await handleStatus({ chat: { id: chat }, message: { text: '/status' }, reply } as unknown as Context);
    const [text] = reply.mock.calls[0]! as [string];
    expect(text).toContain("🎚️ Effort: 🧠 High (Claude Code's default)");
    expect(text).toContain("🧠 Model: 💎 Fable 5.1 claude-fable-5-1 (Claude Code's default)");

    // The chat's own picks are credited as such; the effort shown is still
    // the chat's, which the next spawn applies.
    userPreferences.setEffort(String(chat), 'max');
    userPreferences.setModel(String(chat), 'fable[1m]');
    reply.mockClear();
    await handleStatus({ chat: { id: chat }, message: { text: '/status' }, reply } as unknown as Context);
    const [again] = reply.mock.calls[0]! as [string];
    expect(again).toContain('🎚️ Effort: 🚀 Max (set for this chat with /effort)');
    expect(again).toContain('🧠 Model: 💎 Fable 5.1 claude-fable-5-1 (set for this chat with /model fable[1m])');
    userPreferences.clearEffort(String(chat));
    userPreferences.clearModel(String(chat));
  });

  it('says both are known after the first reply while the log is empty', async () => {
    const chat = 403;
    const project = path.join(home, 'project-403');
    fs.mkdirSync(project, { recursive: true });
    sessionManager.createSession(String(chat), project);
    usage = undefined;

    const reply = vi.fn(async (_text: string, _opts?: unknown) => ({}));
    await handleStatus({ chat: { id: chat }, message: { text: '/status' }, reply } as unknown as Context);
    const [text] = reply.mock.calls[0]! as [string];
    expect(text).toContain("🎚️ Effort: Claude Code's default — known after the first reply");
    expect(text).toContain("🧠 Model: Claude Code's default — known after the first reply");
  });
});
