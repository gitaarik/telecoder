/**
 * runOverlayCommand's `steer`: keystrokes into an open overlay, sent after the
 * command and before the screen is read. These watch what reaches the terminal.
 */

import { describe, it, expect, vi } from 'vitest';

const fake = vi.hoisted(() => {
  process.env.CLAUDE_BIN = '/bin/true';
  class FakeTerm {
    pid = 4242;
    writes: string[] = [];
    onData() { return { dispose() {} }; }
    onExit() { return { dispose() {} }; }
    write(data: string) { this.writes.push(data); }
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

const { PtyProvider } = await import('../../src/claude/pty-provider.js');

const KEY = '889';
const ESC = '\x1b';
const DOWN = '\x1b[B';
const ENTER = '\r';
const pasteOf = (text: string) => `\x1b[200~${text}\x1b[201~`;

function makeRig() {
  const provider = new PtyProvider();
  const internals = provider as unknown as Record<string, unknown> & {
    _getOrCreateSession(key: string): unknown;
  };
  internals._getOrCreateSession(KEY);
  const term = fake.terms[fake.terms.length - 1]!;
  // The screen changes as keys land, the way the real overlay redraws.
  internals._getScreenText = () => `screen after ${term.writes.length} writes`;
  internals._hasInputBox = () => true;
  internals._waitQuiet = async () => true;
  return { provider, term };
}

describe('runOverlayCommand with steer', () => {
  it('sends the keys it answers with after the command, then closes the overlay', async () => {
    const { provider, term } = makeRig();
    const result = await provider.runOverlayCommand(KEY, '/tasks', () => [DOWN, DOWN, ENTER]);
    expect(result.ok).toBe(true);
    expect(term.writes).toEqual([pasteOf('/tasks'), ENTER, DOWN, DOWN, ENTER, ESC]);
  });

  it('shows steer the overlay as first drawn and returns the screen after the keys', async () => {
    const { provider, term } = makeRig();
    let seen = '';
    const result = await provider.runOverlayCommand(KEY, '/tasks', (screen) => {
      seen = screen;
      return [ENTER];
    });
    // The paste and its Enter had gone in when steer looked.
    expect(seen).toBe('screen after 2 writes');
    expect(result.ok && result.screen).toBe('screen after 3 writes');
    expect(term.writes.at(-1)).toBe(ESC);
  });

  it('sends nothing extra when steer declines', async () => {
    const { provider, term } = makeRig();
    await provider.runOverlayCommand(KEY, '/tasks', () => undefined);
    expect(term.writes).toEqual([pasteOf('/tasks'), ENTER, ESC]);
  });
});
