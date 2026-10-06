/**
 * How the pty provider keeps the background-task count — the footer's
 * "🔄 N tasks running in background", /tasks and the background card — in
 * step with what claude is actually running.
 *
 * A claude that went down on its own (a crash, an OOM kill) never passed
 * through _cleanupSession, so its tasks counted as running for good: the
 * respawn reports them stopped by task id, and the relay knows them only by
 * tool-use id.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as realOs from 'os';

const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const fake = vi.hoisted(() => {
  // Resolved at import; the fake terminal below never runs it.
  process.env.CLAUDE_BIN = '/bin/true';

  type ExitHandler = (e: { exitCode: number; signal?: number }) => void;
  class FakeTerm {
    pid = 4242;
    private exitHandlers: ExitHandler[] = [];
    onData() { return { dispose() {} }; }
    onExit(cb: ExitHandler) { this.exitHandlers.push(cb); return { dispose() {} }; }
    write() {}
    resize() {}
    kill() {}
    /** What node-pty does once the process is gone. */
    exit(exitCode = 137) { for (const cb of this.exitHandlers) cb({ exitCode }); }
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
    getSession: () => ({ workingDirectory: process.cwd() }),
    setClaudeSessionId: () => {},
  },
}));

vi.mock('../../src/claude/ipc-server.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/claude/ipc-server.js')>()),
  getIpcPort: () => 45678,
}));

// The relay watches the session log under os.homedir(); keep it in a scratch dir.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: actual, homedir: () => process.env.TELECODER_TEST_HOME ?? actual.homedir() };
});

const { PtyProvider } = await import('../../src/claude/pty-provider.js');
const { onAsyncToolArmed, teardown } = await import('../../src/claude/monitor-relay.js');
const { taskTracker } = await import('../../src/telegram/task-tracker.js');
const { sessionJsonlPath } = await import('../../src/claude/session-jsonl.js');

const KEY = '777';
let home: string;

type Provider = InstanceType<typeof PtyProvider>;

function logPath(): string {
  return sessionJsonlPath(process.cwd(), SESSION_ID);
}

/** Create the session log so the relay's watcher has something to attach to. */
function seedLog(): void {
  fs.mkdirSync(path.dirname(logPath()), { recursive: true });
  fs.writeFileSync(logPath(), '');
}

/** Spawn the session's pty the way a turn would, and return its terminal. */
function spawnSession(provider: Provider) {
  (provider as unknown as { _getOrCreateSession(key: string): unknown })._getOrCreateSession(KEY);
  return fake.terms[fake.terms.length - 1];
}

/** Arm a backgrounded command on the live session, as its PreToolUse hook would. */
function armBackgroundTask(toolUseId: string): void {
  seedLog();
  onAsyncToolArmed('bash_background', KEY, process.cwd(), SESSION_ID, 'npm test', toolUseId);
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(realOs.tmpdir(), 'telecoder-pty-tasks-'));
  process.env.TELECODER_TEST_HOME = home;
});

afterAll(() => {
  delete process.env.TELECODER_TEST_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

afterEach(() => {
  teardown(KEY);
  fake.terms.length = 0;
});

describe('a claude that exits', () => {
  it('stops counting the background tasks of a claude that exits on its own', () => {
    const provider = new PtyProvider();
    const term = spawnSession(provider);
    armBackgroundTask('toolu_01');
    expect(taskTracker.getBackgroundedCount(KEY)).toBe(1);

    term.exit();

    expect(taskTracker.getBackgroundedCount(KEY)).toBe(0);
    expect(provider.getSessionPid(KEY)).toBeUndefined();
  });

  it('leaves the replacement session alone when a killed claude exits late', () => {
    const provider = new PtyProvider();
    const first = spawnSession(provider);
    provider.clearConversation(KEY);
    spawnSession(provider);
    armBackgroundTask('toolu_02');

    // /clear killed the first claude; its exit only lands now, after the
    // replacement is up and has a task running.
    first.exit();

    expect(taskTracker.getBackgroundedCount(KEY)).toBe(1);
    expect(provider.getSessionPid(KEY)).toBe(4242);
  });
});
