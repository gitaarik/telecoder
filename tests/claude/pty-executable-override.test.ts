/**
 * A chat on CCR runs the same pty with CCR's wrapper in claude's place. The
 * pty spawns what the turn's options name, respawns when that changes, and
 * refuses to resume a session the other backend minted.
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
  current: { workingDirectory: process.cwd(), claudeSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', ownerProvider: undefined as string | undefined },
  recorded: [] as Array<{ id: string; owner?: string }>,
  fresh: 0,
}));

vi.mock('../../src/claude/session-manager.js', () => ({
  sessionManager: {
    getSession: () => sessions.current,
    setClaudeSessionId: (_key: string, id: string, owner?: string) => { sessions.recorded.push({ id, owner }); },
    startNewConversation: () => { sessions.fresh++; sessions.current = { ...sessions.current, claudeSessionId: undefined as unknown as string, ownerProvider: undefined }; },
  },
}));

vi.mock('../../src/claude/session-jsonl.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/claude/session-jsonl.js')>();
  return { ...actual, claudeSessionFileExists: () => true, hasForeignThinkingSignatures: () => false };
});

vi.mock('../../src/claude/ipc-server.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/claude/ipc-server.js')>();
  return { ...actual, getIpcPort: () => 45678 };
});

const { PtyProvider } = await import('../../src/claude/pty-provider.js');

type Internals = { _getOrCreateSession(key: string, options?: Record<string, unknown>): unknown };
const KEY = '4242';

describe('pty executable override', () => {
  beforeEach(() => {
    fake.spawns.length = 0;
    sessions.recorded.length = 0;
    sessions.fresh = 0;
    sessions.current = { workingDirectory: process.cwd(), claudeSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', ownerProvider: undefined };
  });

  it('spawns claude itself by default and the override when a turn names one', () => {
    const provider = new PtyProvider() as unknown as Internals;
    provider._getOrCreateSession(KEY);
    expect(fake.spawns[0].file).toBe('/bin/true');
    provider._getOrCreateSession(KEY, { executableOverride: '/state/claude-via-ccr.sh' });
    expect(fake.spawns).toHaveLength(2);
    expect(fake.spawns[1].file).toBe('/state/claude-via-ccr.sh');
    expect(fake.spawns[0].term.killed).toBe(true);
  });

  it('keeps the live pty while the executable stays the same', () => {
    const provider = new PtyProvider() as unknown as Internals;
    const first = provider._getOrCreateSession(KEY, { executableOverride: '/state/claude-via-ccr.sh' });
    const second = provider._getOrCreateSession(KEY, { executableOverride: '/state/claude-via-ccr.sh' });
    expect(second).toBe(first);
    expect(fake.spawns).toHaveLength(1);
  });

  it('resumes a session its own backend minted, and records the owner of a new one', () => {
    sessions.current.ownerProvider = 'ccr';
    const provider = new PtyProvider() as unknown as Internals;
    provider._getOrCreateSession(KEY, { providerName: 'ccr', executableOverride: '/state/claude-via-ccr.sh' });
    expect(fake.spawns[0].args).toContain('--resume');
    expect(sessions.fresh).toBe(0);

    sessions.current = { workingDirectory: process.cwd(), claudeSessionId: undefined as unknown as string, ownerProvider: undefined };
    provider._getOrCreateSession('4243', { providerName: 'ccr', executableOverride: '/state/claude-via-ccr.sh' });
    expect(sessions.recorded).toEqual([{ id: expect.any(String), owner: 'ccr' }]);
  });

  it('refuses to resume a session the other backend minted and starts fresh', () => {
    sessions.current.ownerProvider = 'ccr';
    const provider = new PtyProvider() as unknown as Internals;
    provider._getOrCreateSession(KEY, { providerName: 'claude' });
    expect(sessions.fresh).toBe(1);
    expect(fake.spawns[0].args).toContain('--session-id');
    expect(fake.spawns[0].args).not.toContain('--resume');
    expect(sessions.recorded[0].owner).toBe('claude');
  });
});
