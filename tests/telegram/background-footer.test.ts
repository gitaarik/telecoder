/**
 * The "Running in background" footer under a turn's status line. It only
 * named the task, so a long one looked stuck; it now lists the latest things
 * the tasks reported doing, timed like the action log's entries. With more
 * than one task it named none of them; now it lists each.
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

  it('lists every task by name, each with its latest update', () => {
    const footer = renderBackgroundFooter([
      { description: 'Build', updates: [{ at: at(10, 0), text: 'a' }, { at: at(10, 3), text: 'c' }] },
      { description: 'Watch CI', updates: [{ at: at(10, 1), text: 'b' }, { at: at(10, 4), text: 'd' }] },
      { description: 'Explore auth' },
    ])!;
    expect(footer.text.split('\n')).toEqual([
      '🔄 3 tasks running in background',
      '  • Build',
      '    ⎿ [10:03] c',
      '  • Watch CI',
      '    ⎿ [10:04] d',
      '  • Explore auth',
    ]);
  });

  it('caps a long list and points at /tasks for the rest', () => {
    const tasks = Array.from({ length: 8 }, (_, i) => ({ description: `Task ${i + 1}` }));
    const lines = renderBackgroundFooter(tasks)!.text.split('\n');
    expect(lines[0]).toBe('🔄 8 tasks running in background');
    expect(lines.slice(1, -1)).toEqual(tasks.slice(0, 6).map((t) => `  • ${t.description}`));
    expect(lines.at(-1)).toBe('  … +2 more · /tasks');
  });
});

describe('taskTracker updates', () => {
  it('folds a repeated update into the one before it, and keeps three', () => {
    taskTracker.clear(KEY);
    taskTracker.start(KEY, { taskId: 't1', description: 'Watch CI', isBackgrounded: true });
    for (const job of ['lint', 'lint', 'build', 'test', 'deploy']) {
      taskTracker.noteUpdate(KEY, 't1', `${job} passed`);
    }
    expect(taskTracker.getTask(KEY, 't1')!.updates!.map((u) => u.text))
      .toEqual(['build passed', 'test passed', 'deploy passed']);
  });

  it('takes a monitor firing for a known task and ignores unknown ones', () => {
    taskTracker.clear(KEY);
    taskTracker.start(KEY, { taskId: 'toolu_1', description: 'Watch deploy', isBackgrounded: true });
    taskTracker.noteUpdate(KEY, 'toolu_1', 'deploy finished', at(9, 30));
    taskTracker.noteUpdate(KEY, 'toolu_x', 'nobody');
    expect(taskTracker.getTask(KEY, 'toolu_1')!.updates).toEqual([{ at: at(9, 30), text: 'deploy finished' }]);
    expect(taskTracker.getTask(KEY, 'toolu_x')).toBeUndefined();
  });
});
