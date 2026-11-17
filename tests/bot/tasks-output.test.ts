import { describe, it, expect } from 'vitest';
import { _matchTaskRow, _renderTaskDetail, _renderClaudeList, _renderClaudeDetail } from '../../src/bot/handlers/command/tasks.js';
import type { TaskState } from '../../src/telegram/task-tracker.js';
import type { TaskRow } from '../../src/claude/tasks-overlay-scraper.js';

const row = (label: string, truncated = false): TaskRow => ({ label, status: 'running', truncated });

function task(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: 'toolu_01',
    description: 'Count slowly',
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    taskType: 'local_bash',
    ...overrides,
  };
}

const buttons = (keyboard: { text: string; callback_data: string }[][]) =>
  keyboard.flat().map((b) => b.callback_data);

describe('matchTaskRow', () => {
  const rows = [
    row('Wait for background sleep 100 to finish'),
    row('sleep 100'),
    row('sleep 150'),
    row('for i in $(seq 1 40); do echo "line $i"; sleep 2;', true),
  ];

  it('finds a shell by its command', () => {
    expect(_matchTaskRow(task({ command: 'sleep 150' }), rows)).toBe(2);
  });

  it('finds a shell whose row was cut short, by prefix', () => {
    const cmd = 'for i in $(seq 1 40); do echo "line $i"; sleep 2; done';
    expect(_matchTaskRow(task({ command: cmd }), rows)).toBe(3);
  });

  it('finds a task by its description when the row shows that', () => {
    expect(_matchTaskRow(task({ description: 'Wait for background sleep 100 to finish' }), rows)).toBe(0);
  });

  it('gives up when nothing matches', () => {
    expect(_matchTaskRow(task({ command: 'npm test' }), rows)).toBeUndefined();
  });

  it('gives up when two rows would match', () => {
    const twins = [row('sleep 100'), row('sleep 100')];
    expect(_matchTaskRow(task({ command: 'sleep 100' }), twins)).toBeUndefined();
  });

  it('compares a command wrapped by the TUI as typed', () => {
    expect(_matchTaskRow(task({ command: 'sleep   150' }), rows)).toBe(2);
  });
});

describe('the task detail', () => {
  it('offers the output when there is a pty to ask', () => {
    const { keyboard } = _renderTaskDetail(task(), true);
    expect(buttons(keyboard)).toContain('tasks:out:toolu_01');
  });

  it('says where the output will come from when there is none', () => {
    const { message, keyboard } = _renderTaskDetail(task(), false);
    expect(buttons(keyboard)).not.toContain('tasks:out:toolu_01');
    expect(message.text).toContain('arrives with the result');
  });

  it('says nothing about output for a monitor, which has none', () => {
    const { message } = _renderTaskDetail(task({ taskType: 'monitor_mcp' }), false);
    expect(message.text).not.toContain('arrives with the result');
  });
});

describe("claude's list", () => {
  it('has a button per row, numbered from one', () => {
    const rows = [row('sleep 100'), row('sleep 150')];
    const { keyboard } = _renderClaudeList({ rows, text: 'Background' }, { refresh: 'tasks:claude' });
    expect(buttons(keyboard)).toEqual(['tasks:claude:1', 'tasks:claude:2', 'tasks:claude']);
  });

  it('adds a way back when asked for one', () => {
    const { keyboard } = _renderClaudeList({ rows: [], text: 'Background' }, { refresh: 'tasks:out:x', back: 'tasks:view:x' });
    expect(buttons(keyboard)).toEqual(['tasks:view:x', 'tasks:out:x']);
  });
});

describe("claude's detail", () => {
  it('shows the fields and the output tail', () => {
    const { message } = _renderClaudeDetail(
      { title: 'Shell details', fields: [{ label: 'Command', value: 'sleep 100' }], output: 'line 4\nline 5', note: 'Showing 2 lines' },
      { refresh: 'tasks:claude:1' },
    );
    expect(message.text).toContain('Shell details');
    expect(message.text).toContain('sleep 100');
    expect(message.text).toContain('line 5');
    expect(message.text).toContain('Showing 2 lines');
  });

  it('keeps the end of an output too long for one message', () => {
    const long = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const { message } = _renderClaudeDetail({ title: 'Shell details', fields: [], output: long }, { refresh: 'x' });
    expect(message.text).toContain('line 499');
    expect(message.text).not.toContain('line 0\n');
  });
});
