/**
 * Idle PTY sessions have their claude ended, so neither a long-lived bot nor
 * a thread deleted in Telegram keeps a few hundred MB per session running for
 * nothing — but never a session that still has something to finish.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const fake = vi.hoisted(() => {
  // Resolved at import; the fake terminal below never runs it.
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
  return { FakeTerm, terms: [] as InstanceType<typeof FakeTerm>[], children: [] as string[] };
});

vi.mock('node-pty', () => ({
  spawn: () => {
    const term = new fake.FakeTerm();
    fake.terms.push(term);
    return term;
  },
}));

vi.mock('../../src/claude/session-manager.js', () => ({
  sessionManager: {
    getSession: () => ({ workingDirectory: process.cwd(), claudeSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }),
    setClaudeSessionId: () => {},
  },
}));

vi.mock('../../src/claude/ipc-server.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/claude/ipc-server.js')>();
  return { ...actual, getIpcPort: () => 45678 };
});

// Claude's children, by command line.
vi.mock('../../src/utils/proc-children.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/proc-children.js')>()),
  getDirectChildren: () => fake.children.map((_, i) => 1000 + i),
  describeProcess: (pid: number) => ({ pid, ppid: 4242, ageSec: 1, cmd: fake.children[pid - 1000] }),
}));

const { PtyProvider } = await import('../../src/claude/pty-provider.js');
const { sessionHasWork } = await import('../../src/claude/pty-idle-reaper.js');
const { taskTracker } = await import('../../src/telegram/task-tracker.js');

const KEY = '37620077:4242';
const HOUR = 60 * 60_000;
const AT_THE_PROMPT = 'output\n✻ Brewed for 3m 5s\n❯ \n  ? for shortcuts\n';
const WORKING = 'output\n✶ Percolating… (29s)\n❯ \n  esc to interrupt\n';

function makeProvider(opts: { idleFor: number; screen?: string }) {
  const provider = new PtyProvider();
  const internals = provider as unknown as {
    _getOrCreateSession(key: string): { lastUsedAt: number; lastChunkAt: number };
    _getScreenText(): string;
  };
  const session = internals._getOrCreateSession(KEY);
  session.lastUsedAt = session.lastChunkAt = Date.now() - opts.idleFor;
  internals._getScreenText = () => opts.screen ?? AT_THE_PROMPT;
  return { provider, term: fake.terms[fake.terms.length - 1]! };
}

beforeEach(() => {
  fake.children = [];
  taskTracker.clear(KEY);
});

describe('endIdleSessions', () => {
  it('ends a claude idle past the limit', () => {
    const { provider, term } = makeProvider({ idleFor: 2 * HOUR });
    expect(provider.endIdleSessions(HOUR, () => false)).toEqual([KEY]);
    expect(term.killed).toBe(true);
    expect(provider.getSessionPid(KEY)).toBeUndefined();
  });

  it('leaves one used recently', () => {
    const { provider, term } = makeProvider({ idleFor: 10 * 60_000 });
    expect(provider.endIdleSessions(HOUR, () => false)).toEqual([]);
    expect(term.killed).toBe(false);
  });

  it('leaves one that is generating, or has work it vouches for', () => {
    expect(makeProvider({ idleFor: 2 * HOUR, screen: WORKING }).provider.endIdleSessions(HOUR, () => false)).toEqual([]);
    expect(makeProvider({ idleFor: 2 * HOUR }).provider.endIdleSessions(HOUR, () => true)).toEqual([]);
  });

  it('counts output as use, so a long turn just ended is not idle', () => {
    const { provider } = makeProvider({ idleFor: 2 * HOUR });
    (provider as unknown as { sessions: Map<string, { lastChunkAt: number }> }).sessions.get(KEY)!.lastChunkAt = Date.now();
    expect(provider.endIdleSessions(HOUR, () => false)).toEqual([]);
  });
});

describe('sessionHasWork', () => {
  it('is false for a claude with only its MCP servers', () => {
    fake.children = ['node /home/rik/dev/telecoder/dist/bin/mcp-server.js', 'npx some-mcp-server'];
    expect(sessionHasWork(KEY, 4242)).toBe(false);
  });

  it('is true while a shell Claude started is still running', () => {
    fake.children = ["/usr/bin/zsh -c source /home/rik/.claude/shell-snapshots/snapshot-zsh-1.sh && eval 'npm run dev' < /dev/null"];
    expect(sessionHasWork(KEY, 4242)).toBe(true);
  });

  it('is true while a background task is still running', () => {
    expect(sessionHasWork(KEY, 4242)).toBe(false);
    taskTracker.start(KEY, { taskId: 't1', description: 'watch logs', taskType: 'local_bash' });
    expect(sessionHasWork(KEY, 4242)).toBe(true);
  });
});
