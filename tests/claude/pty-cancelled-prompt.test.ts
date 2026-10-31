/**
 * A cancelled prompt must not reach claude later.
 *
 * An Esc that lands before a turn has any output puts its prompt back in the
 * input box. Measured against a live pty, the next message then went out as
 * "<cancelled prompt><next message>", and a /cost would have submitted the
 * cancelled prompt all by itself. The box can't be read to tell, since a
 * suggestion's ghost text looks the same, so the provider clears it before typing
 * anything after an Esc. These watch the keystrokes that reach the terminal.
 */

import { describe, it, expect, vi } from 'vitest';
import { clearPresses } from '../../src/claude/tui-state.js';

const fake = vi.hoisted(() => {
  // Resolved at import; the fake terminal below never runs it.
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

const KEY = '888';
const ESC = '\x1b';
const CLEAR = '\x15';
const ENTER = '\r';
const pasteOf = (text: string) => `\x1b[200~${text}\x1b[201~`;

interface Rig {
  provider: InstanceType<typeof PtyProvider>;
  term: InstanceType<typeof fake.FakeTerm>;
  /** A whole turn, ended straight away. Aborted first if a controller is given. */
  runTurn: (prompt: string, controller?: AbortController) => Promise<void>;
  /** Run this while the next paste is waiting to echo. */
  duringEcho: { fn: (() => void) | null };
  setScreen: (screen: string) => void;
}

/** The real _runPtyTurn and overlay path, with only their waits on a real TUI cut out. */
function makeRig(): Rig {
  const provider = new PtyProvider();
  const internals = provider as unknown as Record<string, unknown> & {
    _getOrCreateSession(key: string): unknown;
    _runPtyTurn(key: string, prompt: string, options?: { abortController?: AbortController }): Promise<string>;
  };
  internals._getOrCreateSession(KEY);
  const term = fake.terms[fake.terms.length - 1]!;

  let screen = '';
  const duringEcho: Rig['duringEcho'] = { fn: null };
  let controllerForTurn: AbortController | undefined;

  internals._getScreenText = () => screen;
  internals._hasInputBox = () => true;
  internals._waitQuiet = async () => true;
  internals._awaitReady = async () => 'ready';
  internals._maybeRelayUpdateBanner = () => {};
  internals._applyPermissionMode = async () => {};
  internals._waitForPromptEcho = async () => {
    duringEcho.fn?.();
    duringEcho.fn = null;
    return { echoed: true, pasteId: undefined };
  };
  internals._confirmSubmitted = async () => true;
  internals._awaitEndOfTurn = async () => {
    // By now the prompt is in, so this is when a real /cancel would land.
    controllerForTurn?.abort();
    return '';
  };

  return {
    provider,
    term,
    duringEcho,
    setScreen: (s) => { screen = s; },
    runTurn: async (prompt, controller) => {
      controllerForTurn = controller;
      await internals._runPtyTurn(KEY, prompt, { abortController: controller ?? new AbortController() });
      controllerForTurn = undefined;
    },
  };
}

/** Keystrokes sent ahead of `text` being pasted. */
function keysBefore(term: InstanceType<typeof fake.FakeTerm>, text: string): string[] {
  const at = term.writes.indexOf(pasteOf(text));
  expect(at, `${text} was never pasted`).toBeGreaterThanOrEqual(0);
  return term.writes.slice(0, at);
}

describe('a prompt cancelled with /cancel', () => {
  it('is cleared out of the box before the next prompt goes in', async () => {
    const { term, runTurn } = makeRig();
    await runTurn('first', new AbortController());
    term.writes.splice(0, term.writes.indexOf(ESC) + 1);

    await runTurn('second');

    expect(keysBefore(term, 'second')).toEqual(Array(clearPresses('first', 115)).fill(CLEAR));
  });

  it('clears enough for a prompt that filled several rows', async () => {
    const long = 'word '.repeat(200);
    const { term, runTurn } = makeRig();
    await runTurn(long, new AbortController());
    term.writes.splice(0, term.writes.indexOf(ESC) + 1);

    await runTurn('second');

    const presses = keysBefore(term, 'second').filter((k) => k === CLEAR).length;
    expect(presses).toBe(clearPresses(long, 115));
    expect(presses).toBeGreaterThan(clearPresses('first', 115));
  });

  it('is only cleared the once', async () => {
    const { term, runTurn } = makeRig();
    await runTurn('first', new AbortController());
    await runTurn('second');
    term.writes.length = 0;

    await runTurn('third');

    expect(keysBefore(term, 'third')).toEqual([]);
  });

  it('is cleared before an overlay command, whose Enter would submit it', async () => {
    const { term, provider, runTurn } = makeRig();
    await runTurn('first', new AbortController());
    term.writes.length = 0;

    await provider.runOverlayCommand(KEY, '/cost');

    const keys = keysBefore(term, '/cost');
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys)).toEqual(new Set([CLEAR]));
  });

  it("isn't submitted at all when /cancel lands while it is going in", async () => {
    const { term, duringEcho, runTurn } = makeRig();
    const controller = new AbortController();
    duringEcho.fn = () => controller.abort();

    await runTurn('first', controller);

    expect(term.writes).not.toContain(ENTER);
    // Pasted, so it's taken straight back out.
    const afterPaste = term.writes.slice(term.writes.indexOf(pasteOf('first')) + 1);
    expect(afterPaste.filter((k) => k === CLEAR).length).toBe(clearPresses('first', 115));
  });

  it('leaves nothing more to clear after one taken out while going in', async () => {
    const { term, duringEcho, runTurn } = makeRig();
    const controller = new AbortController();
    duringEcho.fn = () => controller.abort();
    await runTurn('first', controller);
    term.writes.length = 0;

    await runTurn('second');

    expect(keysBefore(term, 'second')).toEqual([]);
  });
});

describe('with no Esc pressed', () => {
  it('sends nothing ahead of a prompt, so an ordinary turn pays nothing', async () => {
    const { term, runTurn } = makeRig();
    await runTurn('first');
    await runTurn('second');

    expect(term.writes).toEqual([pasteOf('first'), ENTER, pasteOf('second'), ENTER]);
  });

  it('sends nothing ahead of an overlay command', async () => {
    const { term, provider, runTurn } = makeRig();
    await runTurn('first');
    term.writes.length = 0;

    await provider.runOverlayCommand(KEY, '/cost');

    expect(keysBefore(term, '/cost')).toEqual([]);
  });
});

describe('interrupting a turn claude started itself', () => {
  const WORKING = 'output\n✶ Percolating… (29s)\n❯ \n  esc to interrupt\n';

  it('also clears before the next prompt: a turn we lost track of may have been ours', async () => {
    const { term, provider, runTurn, setScreen } = makeRig();
    await runTurn('first');
    setScreen(WORKING);

    expect(provider.interruptOwnTurn(KEY)).toBe(true);
    setScreen('');
    term.writes.length = 0;
    await runTurn('second');

    expect(new Set(keysBefore(term, 'second'))).toEqual(new Set([CLEAR]));
  });

  it('has nothing to clear when nothing was ever typed', async () => {
    const { term, provider, runTurn, setScreen } = makeRig();
    setScreen(WORKING);
    provider.interruptOwnTurn(KEY);
    setScreen('');
    term.writes.length = 0;

    await runTurn('first');

    expect(keysBefore(term, 'first')).toEqual([]);
  });
});
