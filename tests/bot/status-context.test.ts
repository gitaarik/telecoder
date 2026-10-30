/**
 * /status's 📐 Context line reads the same figure as the usage footer under
 * every reply.
 *
 * Drives the real handler against a session made under a scratch home, so
 * nothing here touches the real ~/.claudegram.
 */

import { describe, it, expect, vi, afterAll } from 'vitest';
import type { Context } from 'grammy';
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

    const [text] = reply.mock.calls[0]!;
    expect(text).toContain('📐 *Context:* 54% \\(535\\.5k/1\\.0M\\)');
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
    userPreferences.setMethod(chat, 'pty');
    usage = undefined;

    const reply = vi.fn(async (_text: string, _opts?: unknown) => ({}));
    await handleStatus({ chat: { id: chat }, message: { text: '/status' }, reply } as unknown as Context);

    const [text] = reply.mock.calls[0]!;
    expect(text).toContain('📐 *Context:* 30% \\(300\\.0k/1\\.0M\\)');
  });
});
