import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as realOs from 'os';

// The relay watches sessionJsonlPath(), which resolves under os.homedir();
// point it at a scratch dir so the test never touches the real ~/.claude.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: actual, homedir: () => process.env.TELECODER_TEST_HOME ?? actual.homedir() };
});

const {
  onAsyncToolArmed,
  markTurnEnd,
  teardown,
  classifyAsyncTool,
} = await import('../../src/claude/monitor-relay.js');
const { taskTracker } = await import('../../src/telegram/task-tracker.js');
const { _inspectCard } = await import('../../src/telegram/background-activity-card.js');

const CWD = '/home/someone/dev/telecoder';
const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SESSION_KEY = '12345';
let home: string;

function logPath(): string {
  return path.join(home, '.claude', 'projects', CWD.replace(/\//g, '-'), `${SESSION_ID}.jsonl`);
}

/** Create the session log so the relay's watcher has something to attach to. */
function seedLog(): void {
  const file = logPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
}

function appendNotification(toolUseId: string, status: string): void {
  const text =
    '<task-notification>' +
    '<task-id>task_1</task-id>' +
    `<tool-use-id>${toolUseId}</tool-use-id>` +
    `<status>${status}</status>` +
    '<summary>all done</summary>' +
    '</task-notification>';
  const rec = {
    type: 'user',
    origin: { kind: 'task-notification' },
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
  fs.appendFileSync(logPath(), JSON.stringify(rec) + '\n');
}

function arm(kind: Parameters<typeof onAsyncToolArmed>[0], description: string, toolUseId?: string): void {
  onAsyncToolArmed(kind, SESSION_KEY, CWD, SESSION_ID, description, toolUseId);
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(realOs.tmpdir(), 'telecoder-relay-'));
  process.env.TELECODER_TEST_HOME = home;
});

afterAll(() => {
  delete process.env.TELECODER_TEST_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

afterEach(() => {
  // Closes the fs watcher and clears both the relay state and the tracker.
  teardown(SESSION_KEY);
});

describe('classifyAsyncTool', () => {
  it('classifies each backgrounded tool family', () => {
    expect(classifyAsyncTool('Monitor', {})).toBe('monitor');
    expect(classifyAsyncTool('Workflow', { name: 'audit' })).toBe('workflow');
    expect(classifyAsyncTool('Task', {})).toBe('subagent');
    expect(classifyAsyncTool('Agent', {})).toBe('subagent');
  });

  it('treats Bash as async only when explicitly backgrounded', () => {
    expect(classifyAsyncTool('Bash', { run_in_background: true })).toBe('bash_background');
    expect(classifyAsyncTool('Bash', { run_in_background: false })).toBeNull();
    expect(classifyAsyncTool('Bash', {})).toBeNull();
    // Guard against a truthy-but-not-true value being read as opt-in.
    expect(classifyAsyncTool('Bash', { run_in_background: 'yes' })).toBeNull();
  });

  it('returns null for synchronous tools', () => {
    for (const name of ['Read', 'Edit', 'Write', 'Grep', 'TaskOutput', 'monitor']) {
      expect(classifyAsyncTool(name, {})).toBeNull();
    }
  });
});

describe('PTY-mode task tracking', () => {
  it('registers an armed task with the tracker', () => {
    seedLog();
    arm('subagent', 'review the diff', 'toolu_01');

    const tasks = taskTracker.getTasks(SESSION_KEY);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: 'toolu_01',
      toolUseId: 'toolu_01',
      description: 'review the diff',
      taskType: 'local_agent',
      status: 'running',
      isBackgrounded: true,
    });
  });

  it('registers even though no bot is configured to receive the armed message', () => {
    seedLog();
    arm('monitor', 'watch the deploy', 'toolu_02');

    // setMonitorRelayBot was never called, so the card never reaches
    // Telegram. The task must still be tracked — that is the whole point of
    // registering before the Telegram round-trip.
    expect(taskTracker.getTasks(SESSION_KEY)).toHaveLength(1);
  });

  it('puts the armed task on the background card', () => {
    seedLog();
    arm('subagent', 'review the diff', 'toolu_0a');

    const card = _inspectCard(SESSION_KEY);
    expect(card?.running).toBe(1);
    expect(card?.text).toContain('review the diff');
  });

  it('takes the task off the card when its completion lands', () => {
    seedLog();
    arm('bash_background', 'npm run build', 'toolu_0b');
    expect(_inspectCard(SESSION_KEY)?.running).toBe(1);

    appendNotification('toolu_0b', 'completed');
    markTurnEnd(SESSION_KEY);

    // markTurnEnd also seals the card, so the running list is what carries
    // over — and this task is done, so nothing should.
    expect(_inspectCard(SESSION_KEY)?.running).toBe(0);
  });

  it('maps each kind onto the bucket /tasks groups by', () => {
    seedLog();
    arm('monitor', 'm', 'toolu_m');
    arm('bash_background', 'b', 'toolu_b');
    arm('subagent', 's', 'toolu_s');
    arm('workflow', 'w', 'toolu_w');

    const byId = new Map(taskTracker.getTasks(SESSION_KEY).map((t) => [t.id, t.taskType]));
    expect(byId.get('toolu_m')).toBe('monitor_mcp');
    expect(byId.get('toolu_b')).toBe('local_bash');
    expect(byId.get('toolu_s')).toBe('local_agent');
    expect(byId.get('toolu_w')).toBe('local_workflow');
  });

  it('counts armed tasks as backgrounded so the footer picks them up', () => {
    seedLog();
    arm('bash_background', 'npm run build', 'toolu_03');
    expect(taskTracker.getBackgroundedCount(SESSION_KEY)).toBe(1);
  });

  it('reports an active monitor to hasActiveMonitor', () => {
    seedLog();
    arm('monitor', 'tail the log', 'toolu_04');
    expect(taskTracker.hasActiveMonitor(SESSION_KEY)).toBe(true);
  });

  it('skips tasks with no tool_use_id rather than leaking a ghost entry', () => {
    seedLog();
    arm('subagent', 'untrackable', undefined);

    // Without a tool_use_id the terminal notification could never be matched,
    // so the entry would sit in /tasks as "running" forever.
    expect(taskTracker.getTasks(SESSION_KEY)).toHaveLength(0);
  });

  it('drops the task when its completion notification lands', () => {
    seedLog();
    arm('bash_background', 'npm test', 'toolu_05');
    expect(taskTracker.getTasks(SESSION_KEY)).toHaveLength(1);

    appendNotification('toolu_05', 'completed');
    markTurnEnd(SESSION_KEY); // drains the JSONL synchronously

    expect(taskTracker.getTasks(SESSION_KEY)).toHaveLength(0);
  });

  it('drops the task on a failed completion too', () => {
    seedLog();
    arm('subagent', 'flaky agent', 'toolu_06');

    appendNotification('toolu_06', 'failed');
    markTurnEnd(SESSION_KEY);

    expect(taskTracker.getTasks(SESSION_KEY)).toHaveLength(0);
  });

  it('leaves unrelated tasks alone when one completes', () => {
    seedLog();
    arm('subagent', 'first', 'toolu_07');
    arm('monitor', 'second', 'toolu_08');

    appendNotification('toolu_07', 'completed');
    markTurnEnd(SESSION_KEY);

    const remaining = taskTracker.getTasks(SESSION_KEY);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe('toolu_08');
  });

  it('clears tracked tasks on teardown so a respawned session starts clean', () => {
    seedLog();
    arm('monitor', 'watch', 'toolu_09');
    expect(taskTracker.getTasks(SESSION_KEY)).toHaveLength(1);

    teardown(SESSION_KEY);

    expect(taskTracker.getTasks(SESSION_KEY)).toHaveLength(0);
  });
});
