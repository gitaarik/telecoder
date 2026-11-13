/**
 * The "Running in background" footer under a turn's status line. It only
 * named the task, so a long one looked stuck; it now lists the latest things
 * the tasks reported doing, timed like the action log's entries.
 */

import { describe, it, expect } from 'vitest';
import { renderBackgroundFooter } from '../../src/telegram/terminal-renderer.js';
import { taskTracker } from '../../src/telegram/task-tracker.js';

const KEY = '424242';
const at = (hh: number, mm: number) => new Date(2026, 10, 13, hh, mm).getTime();

describe('renderBackgroundFooter', () => {
  it('is null with nothing running', () => {
    expect(renderBackgroundFooter([])).toBeNull();
  });

  it('times each update under a lone task with a date_time entity', () => {
    const footer = renderBackgroundFooter([{
      description: 'Run the test suite',
      updates: [{ at: at(14, 2), text: 'Bash · npm test' }],
    }])!;
    expect(footer.text).toBe('🔄 Running in background: Run the test suite\n  ⎿ [14:02] Bash · npm test');
    expect(footer.entities).toHaveLength(1);
    expect(footer.entities[0]).toMatchObject({ type: 'date_time', unix_time: at(14, 2) / 1000 });
  });

  it('merges several tasks by time, keeps the latest three, and says whose each is', () => {
    const footer = renderBackgroundFooter([
      { description: 'Build', updates: [{ at: at(10, 0), text: 'a' }, { at: at(10, 3), text: 'c' }] },
      { description: 'Watch CI', updates: [{ at: at(10, 1), text: 'b' }, { at: at(10, 4), text: 'd' }] },
    ])!;
    expect(footer.text.split('\n')).toEqual([
      '🔄 2 tasks running in background',
      '  ⎿ [10:01] Watch CI: b',
      '  ⎿ [10:03] Build: c',
      '  ⎿ [10:04] Watch CI: d',
    ]);
  });
});

describe('taskTracker updates', () => {
  it('records progress as tool · activity, folds repeats, and keeps three', () => {
    taskTracker.clear(KEY);
    taskTracker.handleEvent(KEY, { type: 'started', taskId: 't1', description: 'Explore', isBackgrounded: true });
    for (const file of ['a.ts', 'a.ts', 'b.ts', 'c.ts', 'd.ts']) {
      taskTracker.handleEvent(KEY, { type: 'progress', taskId: 't1', description: `Reading ${file}`, lastToolName: 'Read' });
    }
    expect(taskTracker.getTask(KEY, 't1')!.updates!.map((u) => u.text))
      .toEqual(['Read · Reading b.ts', 'Read · Reading c.ts', 'Read · Reading d.ts']);
  });

  it('takes a PTY monitor firing for a known task and ignores unknown ones', () => {
    taskTracker.clear(KEY);
    taskTracker.handleEvent(KEY, { type: 'started', taskId: 'toolu_1', description: 'Watch deploy', isBackgrounded: true });
    taskTracker.noteUpdate(KEY, 'toolu_1', 'deploy finished', at(9, 30));
    taskTracker.noteUpdate(KEY, 'toolu_x', 'nobody');
    expect(taskTracker.getTask(KEY, 'toolu_1')!.updates).toEqual([{ at: at(9, 30), text: 'deploy finished' }]);
    expect(taskTracker.getTask(KEY, 'toolu_x')).toBeUndefined();
  });
});
