import { describe, it, expect, beforeEach } from 'vitest';
import { _isPossiblyStale, _renderTasksList, _renderTaskDetail } from '../../src/bot/handlers/command/tasks.js';
import { taskTracker, type TaskState } from '../../src/telegram/task-tracker.js';

const SESSION_KEY = 'staleness-test';
const STALE_AFTER_MS = 15 * 60 * 1000;

/** A running task last heard from `silentMs` ago. */
function task(overrides: Partial<TaskState> = {}, silentMs = 0): TaskState {
  const now = Date.now();
  return {
    id: 'task-1',
    description: 'do a thing',
    status: 'running',
    isBackgrounded: true,
    startedAt: now - silentMs,
    lastActivityAt: now - silentMs,
    ...overrides,
  };
}

describe('isPossiblyStale', () => {
  it('leaves a task that just reported alone', () => {
    expect(_isPossiblyStale(task({ taskType: 'local_agent' }))).toBe(false);
  });

  it('flags a non-monitor task silent past the threshold', () => {
    expect(_isPossiblyStale(task({ taskType: 'local_agent' }, STALE_AFTER_MS + 60_000))).toBe(true);
  });

  it('does not flag one still inside the threshold', () => {
    expect(_isPossiblyStale(task({ taskType: 'local_agent' }, STALE_AFTER_MS - 60_000))).toBe(false);
  });

  // An armed monitor is *supposed* to idle until its event fires — silence
  // says nothing about whether it is still alive.
  it('never flags a monitor, however long it has been silent', () => {
    expect(_isPossiblyStale(task({ taskType: 'monitor_mcp' }, STALE_AFTER_MS * 100))).toBe(false);
  });

  it('flags a backgrounded shell that went quiet', () => {
    expect(_isPossiblyStale(task({ taskType: 'local_bash' }, STALE_AFTER_MS + 1))).toBe(true);
  });
});

describe('renderTasksList staleness annotation', () => {
  it('marks the stale row and explains the marker once', () => {
    const { message: { text } } = _renderTasksList(SESSION_KEY, [
      task({ id: 'a', description: 'fresh agent', taskType: 'local_agent' }),
      task({ id: 'b', description: 'quiet agent', taskType: 'local_agent' }, STALE_AFTER_MS + 1),
    ]);
    const quietLine = text.split('\n').find((l) => l.includes('quiet agent'));
    const freshLine = text.split('\n').find((l) => l.includes('fresh agent'));
    expect(quietLine).toContain('⚠️');
    expect(freshLine).not.toContain('⚠️');
    expect(text).toContain('may have finished already');
  });

  it('omits the explanation when nothing is flagged', () => {
    const { message: { text } } = _renderTasksList(SESSION_KEY, [
      task({ id: 'a', description: 'fresh agent', taskType: 'local_agent' }),
    ]);
    expect(text).not.toContain('⚠️');
    expect(text).not.toContain('may have finished already');
  });

  it('still lists a stale task rather than hiding it', () => {
    const { message: { text }, keyboard } = _renderTasksList(SESSION_KEY, [
      task({ id: 'a', description: 'quiet agent', taskType: 'local_agent' }, STALE_AFTER_MS + 1),
    ]);
    expect(text).toContain('quiet agent');
    // The numbered button for the task must survive, or it can't be inspected.
    expect(keyboard.flat().some((b) => b.callback_data === 'tasks:view:a')).toBe(true);
  });
});

describe('task rendering as entities', () => {
  /** The text each entity of `type` covers. */
  const covered = (m: { text: string; entities: { type: string; offset: number; length: number }[] }, type: string) =>
    m.entities.filter((e) => e.type === type).map((e) => m.text.slice(e.offset, e.offset + e.length));

  it('shows a description verbatim, with the headings in bold', () => {
    const { message } = _renderTasksList(SESSION_KEY, [
      task({ id: 'a', description: 'fix *this* (now) [1]_x_', taskType: 'local_agent' }),
    ]);
    expect(message.text).toContain('fix *this* (now) [1]_x_');
    expect(message.text).not.toContain('\\');
    expect(covered(message, 'bold')).toContain('Active background tasks');
    expect(message.text).toContain('Active background tasks (1)');
    expect(covered(message, 'italic')).toContain('Tap a number to view details.');
  });

  it('renders the detail view with bold labels and code values', () => {
    const { message } = _renderTaskDetail(
      task({ description: 'deploy_v2 (prod)', taskType: 'local_bash' }),
    );
    expect(message.text).toMatch(/^💻 Shell: deploy_v2 \(prod\)\n\n• Status: running/);
    expect(covered(message, 'bold')).toEqual(
      expect.arrayContaining(['deploy_v2 (prod)', 'Status:', 'Type:']),
    );
    expect(covered(message, 'code')).toEqual(['local_bash']);
  });
});

describe('lastActivityAt wiring', () => {
  beforeEach(() => taskTracker.clear(SESSION_KEY));

  it('is set when a task starts', () => {
    const state = taskTracker.start(SESSION_KEY, {
      taskId: 't1',
      description: 'agent',
      taskType: 'local_agent',
    });
    expect(state.lastActivityAt).toBeGreaterThan(0);
    expect(_isPossiblyStale(state)).toBe(false);
  });

  // The whole point: a task that keeps reporting must never be flagged.
  it('is refreshed by an update, clearing staleness', () => {
    const started = taskTracker.start(SESSION_KEY, {
      taskId: 't2',
      description: 'agent',
      taskType: 'local_agent',
    });
    started.lastActivityAt = Date.now() - (STALE_AFTER_MS + 60_000);
    expect(_isPossiblyStale(started)).toBe(true);

    taskTracker.noteUpdate(SESSION_KEY, 't2', 'still working');
    expect(_isPossiblyStale(taskTracker.getTask(SESSION_KEY, 't2')!)).toBe(false);
  });
});
