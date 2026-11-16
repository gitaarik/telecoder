/**
 * A claude started ahead of its first prompt is the one that prompt uses, and
 * until then it leaves the bot's session as it found it: a new session id is
 * recorded by the first turn, not by the early start.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const fake = vi.hoisted(() => {
  process.env.CLAUDE_BIN = '/bin/true';
  class FakeTerm {
    pid = 4242;
    killed = false;
    onData() { return { dispose() {} }; }
    onExit() { return { dispose() {} }; }
    write() {}
    resize() {}
    kill() { this.killed = true; }
  }
  return { FakeTerm, spawns: [] as Array<{ file: string; args: string[]; term: InstanceType<typeof FakeTerm> }> };
});

vi.mock('node-pty', () => ({
  spawn: (file: string, args: string[]) => {
    const term = new fake.FakeTerm();
    fake.spawns.push({ file, args, term });
    return term;
  },
}));

const sessions = vi.hoisted(() => ({
  current: undefined as { workingDirectory: string; claudeSessionId?: string; ownerProvider?: string } | undefined,
  recorded: [] as Array<{ id: string; owner?: string }>,
}));

vi.mock('../../src/claude/session-manager.js', () => ({
  sessionManager: {
    getSession: () => sessions.current,
    setClaudeSessionId: (_key: string, id: string, owner?: string) => { sessions.recorded.push({ id, owner }); },
    startNewConversation: () => {},
  },
}));

vi.mock('../../src/claude/session-jsonl.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/claude/session-jsonl.js')>();
  return { ...actual, claudeSessionFileExists: () => true, hasForeignThinkingSignatures: () => false };
});

const chats = vi.hoisted(() => [] as Array<{ id: string; key: string; ctx: unknown }>);

vi.mock('../../src/claude/ipc-server.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/claude/ipc-server.js')>();
  return {
    ...actual,
    getIpcPort: () => 45678,
    registerSessionChat: (id: string, key: string, ctx: unknown) => { chats.push({ id, key, ctx }); },
  };
});

const { PtyProvider } = await import('../../src/claude/pty-provider.js');

type Internals = {
  prewarm(key: string, options?: Record<string, unknown>): boolean;
  hasLiveSession(key: string): boolean;
  closeAll(waitMs?: number): Promise<void>;
  _getOrCreateSession(key: string, options?: Record<string, unknown>): { claudeSessionId: string };
};
const KEY = '4242';
const make = () => new PtyProvider() as unknown as Internals;
const idArg = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe('pty prewarm', () => {
  beforeEach(() => {
    fake.spawns.length = 0;
    sessions.recorded.length = 0;
    chats.length = 0;
    sessions.current = { workingDirectory: process.cwd() };
  });

  it('starts a claude on a new session id without recording the id', () => {
    const provider = make();
    expect(provider.prewarm(KEY)).toBe(true);
    expect(provider.hasLiveSession(KEY)).toBe(true);
    expect(fake.spawns).toHaveLength(1);
    expect(fake.spawns[0].file).toBe('/bin/true');
    expect(fake.spawns[0].args).toContain('--session-id');
    expect(sessions.recorded).toEqual([]);
  });

  it('hands that claude to the first turn, which records the id and its backend, once', () => {
    const provider = make();
    provider.prewarm(KEY, { providerName: 'claude' });
    const used = provider._getOrCreateSession(KEY, { providerName: 'claude' });
    expect(fake.spawns).toHaveLength(1);
    expect(fake.spawns[0].term.killed).toBe(false);
    expect(sessions.recorded).toEqual([{ id: idArg(fake.spawns[0].args, '--session-id'), owner: 'claude' }]);
    expect(used.claudeSessionId).toBe(sessions.recorded[0].id);

    provider._getOrCreateSession(KEY, { providerName: 'claude' });
    expect(sessions.recorded).toHaveLength(1);
  });

  it('leaves a chat that already has a claude alone', () => {
    const provider = make();
    const progress = () => {};
    const live = provider._getOrCreateSession(KEY, { onProgress: progress }) as unknown as { onProgress?: unknown };
    expect(provider.prewarm(KEY)).toBe(false);
    expect(fake.spawns).toHaveLength(1);
    expect(live.onProgress).toBe(progress);
  });

  it('resumes the conversation the chat is in, with nothing new to record', () => {
    sessions.current = { workingDirectory: process.cwd(), claudeSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' };
    const provider = make();
    expect(provider.prewarm(KEY)).toBe(true);
    expect(idArg(fake.spawns[0].args, '--resume')).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    provider._getOrCreateSession(KEY);
    expect(fake.spawns).toHaveLength(1);
    expect(sessions.recorded).toEqual([]);
  });

  it('is replaced when the first turn runs on another backend', () => {
    const provider = make();
    provider.prewarm(KEY, { providerName: 'claude' });
    provider._getOrCreateSession(KEY, { providerName: 'ccr', executableOverride: '/state/claude-via-ccr.sh' });
    expect(fake.spawns).toHaveLength(2);
    expect(fake.spawns[0].term.killed).toBe(true);
    expect(fake.spawns[1].file).toBe('/state/claude-via-ccr.sh');
    expect(sessions.recorded).toEqual([{ id: idArg(fake.spawns[1].args, '--session-id'), owner: 'ccr' }]);
  });

  it('records the chat so a tool called before the first prompt can reach it', () => {
    const provider = make();
    const ctx = { chat: { id: 4242 } };
    provider.prewarm(KEY, { telegramCtx: ctx });
    expect(chats).toEqual([{ id: idArg(fake.spawns[0].args, '--session-id'), key: KEY, ctx }]);
  });

  it('throws without a project, and starts nothing once the bot is shutting down', async () => {
    sessions.current = undefined;
    const provider = make();
    expect(() => provider.prewarm(KEY)).toThrow(/No active session/);
    sessions.current = { workingDirectory: process.cwd() };
    await provider.closeAll(0);
    expect(provider.prewarm(KEY)).toBe(false);
    expect(fake.spawns).toHaveLength(0);
  });
});
