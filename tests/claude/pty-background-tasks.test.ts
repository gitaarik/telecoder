/**
 * How the pty provider keeps the background-task count — the footer's
 * "🔄 N tasks running in background", /tasks and the background card — in
 * step with what claude is actually running.
 *
 * Two ways it used to drift:
 *  - A Bash call that runs into claude's 10-minute foreground cap is moved to
 *    the background rather than killed. PreToolUse saw a plain call, so it was
 *    never counted while it ran on.
 *  - A claude that went down on its own (a crash, an OOM kill) never passed
 *    through _cleanupSession, so its tasks counted as running for good: the
 *    respawn reports them stopped by task id, and the relay knows them only by
 *    tool-use id.
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
  return {
    FakeTerm,
    terms: [] as InstanceType<typeof FakeTerm>[],
    /** The IPC hook handlers the provider registers, by path. */
    hooks: new Map<string, (turn: unknown, body: Record<string, unknown>) => unknown>(),
  };
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
  return {
    ...actual,
    getIpcPort: () => 45678,
    registerIpcHandler: (route: string, fn: (turn: unknown, body: Record<string, unknown>) => unknown) => {
      fake.hooks.set(route, fn);
    },
  };
});

// The relay watches the session log under os.homedir(); keep it in a scratch dir.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: actual, homedir: () => process.env.TELECODER_TEST_HOME ?? actual.homedir() };
});

const { PtyProvider } = await import('../../src/claude/pty-provider.js');
const { onAsyncToolArmed, teardown } = await import('../../src/claude/monitor-relay.js');
const { taskTracker } = await import('../../src/telegram/task-tracker.js');
const { _inspectCard } = await import('../../src/telegram/background-activity-card.js');
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

/** Deliver a PostToolUse hook for `toolUseId` within a turn on this session. */
function postToolUse(toolUseId: string, toolInput: Record<string, unknown>, toolResponse: unknown): void {
  const handler = fake.hooks.get('/hook/postToolUse');
  if (!handler) throw new Error('the provider registered no /hook/postToolUse handler');
  handler(
    { sessionKey: KEY, options: {} },
    {
      session_id: SESSION_ID,
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: toolInput,
      tool_response: toolResponse,
      tool_use_id: toolUseId,
    },
  );
}

const SMOKE_TEST = {
  command: 'npm run llm:smoke',
  description: 'Run the full smoke test before the release',
  timeout: 600000,
};

/**
 * The response claude gives a call it moved to the background at the cap, as
 * claude 2.1.291 sent it to the PostToolUse hook in a live run.
 */
const MOVED_TO_BACKGROUND = {
  stdout: '',
  stderr: '',
  interrupted: false,
  isImage: false,
  noOutputExpected: false,
  backgroundTaskId: 'bqf7xbwkd',
  timedOutAfterMs: 600000,
};

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

describe('a Bash call claude moves to the background', () => {
  it('counts from the moment the call returns, dated from when it started', () => {
    seedLog();
    postToolUse('toolu_10', SMOKE_TEST, MOVED_TO_BACKGROUND);

    const [task] = taskTracker.getBackgroundedTasks(KEY);
    expect(task).toMatchObject({
      id: 'toolu_10',
      description: 'Run the full smoke test before the release',
      taskType: 'local_bash',
    });
    // Ten minutes in the foreground already, not a task that just began.
    expect(Date.now() - task.startedAt).toBeGreaterThanOrEqual(600000);
    expect(_inspectCard(KEY)?.text).toContain('running 10m 0s');
  });

  it('stops counting when its completion lands, with the whole run in the duration', async () => {
    seedLog();
    postToolUse('toolu_11', SMOKE_TEST, MOVED_TO_BACKGROUND);

    fs.appendFileSync(logPath(), JSON.stringify({
      type: 'user',
      origin: { kind: 'task-notification' },
      message: {
        role: 'user',
        content: '<task-notification>\n<task-id>bqf7xbwkd</task-id>\n<tool-use-id>toolu_11</tool-use-id>\n'
          + '<status>completed</status>\n<summary>Background command "Run the full smoke test before the release" completed (exit code 0)</summary>\n'
          + '</task-notification>',
      },
    }) + '\n');

    // Picked up off the log by the relay's watcher. (markTurnEnd would drain it
    // too, but it seals the card, and the card is where the duration shows.)
    await vi.waitFor(() => expect(taskTracker.getBackgroundedCount(KEY)).toBe(0), { timeout: 3000 });
    expect(_inspectCard(KEY)?.text).toContain('Backgrounded done: Run the full smoke test before the release (10m 0s)');
  });

  it('leaves a call that finished in the foreground uncounted', () => {
    seedLog();
    postToolUse('toolu_12', SMOKE_TEST, {
      stdout: 'all 42 cases passed', stderr: '', interrupted: false, isImage: false, noOutputExpected: false,
    });
    expect(taskTracker.getBackgroundedCount(KEY)).toBe(0);
  });
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
