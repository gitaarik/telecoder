/**
 * The pty provider's view of a turn nothing in the bot started.
 *
 * A turn claude starts itself when a background task reports back isn't in the
 * request queue and has no abort controller, so the TUI is the only place to ask
 * whether one is running, and writing Esc to it the only way to stop one.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const fake = vi.hoisted(() => {
  // Resolved at import; the fake terminal below never runs it.
  process.env.CLAUDE_BIN = '/bin/true';
  class FakeTerm {
    pid = 4242;
    writes: string[] = [];
    failWrites = false;
    onData() { return { dispose() {} }; }
    onExit() { return { dispose() {} }; }
    write(data: string) {
      if (this.failWrites) throw new Error('pty gone');
      this.writes.push(data);
    }
    resize() {}
    kill() {}
  }
  return { FakeTerm, terms: [] as InstanceType<typeof FakeTerm>[] };
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

const relay = vi.hoisted(() => ({ interrupted: [] as string[] }));
vi.mock('../../src/claude/monitor-relay.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/claude/monitor-relay.js')>();
  return { ...actual, markSelfTurnInterrupted: (key: string) => { relay.interrupted.push(key); } };
});

const { PtyProvider } = await import('../../src/claude/pty-provider.js');

const KEY = '777';
const WORKING = 'output\n✶ Percolating… (29s)\n❯ \n  esc to interrupt\n';
const AT_THE_PROMPT = 'output\n✻ Brewed for 3m 5s\n❯ \n  ? for shortcuts\n';

function makeProvider(screen: string) {
  const provider = new PtyProvider();
  const internals = provider as unknown as {
    _getOrCreateSession(key: string): unknown;
    _getScreenText(): string;
  };
  internals._getOrCreateSession(KEY);
  internals._getScreenText = () => screen;
  return { provider, term: fake.terms[fake.terms.length - 1]! };
}

describe('isSessionGenerating', () => {
  it('reads what the TUI shows', () => {
    expect(makeProvider(WORKING).provider.isSessionGenerating(KEY)).toBe(true);
    expect(makeProvider(AT_THE_PROMPT).provider.isSessionGenerating(KEY)).toBe(false);
  });

  it('is false with no pty, which is every session in SDK mode', () => {
    expect(new PtyProvider().isSessionGenerating(KEY)).toBe(false);
  });
});

describe('interruptOwnTurn', () => {
  beforeEach(() => {
    relay.interrupted.length = 0;
  });

  it('presses Esc on a generation in progress', () => {
    const { provider, term } = makeProvider(WORKING);

    expect(provider.interruptOwnTurn(KEY)).toBe(true);
    expect(term.writes).toEqual(['\x1b']);
  });

  it('tells the relay, because the log may not: an early Esc writes no record', () => {
    const { provider } = makeProvider(WORKING);

    provider.interruptOwnTurn(KEY);

    expect(relay.interrupted).toEqual([KEY]);
  });

  it('presses nothing at the prompt, where Esc would mean something else', () => {
    const { provider, term } = makeProvider(AT_THE_PROMPT);

    expect(provider.interruptOwnTurn(KEY)).toBe(false);
    expect(term.writes).toEqual([]);
    expect(relay.interrupted).toEqual([]);
  });

  it('reports a pty that has gone as nothing interrupted', () => {
    const { provider, term } = makeProvider(WORKING);
    term.failWrites = true;

    expect(provider.interruptOwnTurn(KEY)).toBe(false);
    expect(relay.interrupted).toEqual([]);
  });

  it('has nothing to do with no pty', () => {
    expect(new PtyProvider().interruptOwnTurn(KEY)).toBe(false);
  });
});
