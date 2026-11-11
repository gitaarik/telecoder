/**
 * Coverage for the task-list card: reading Claude Code's task files, drawing
 * them the way its terminal panel does, and the live card that is posted once
 * per turn and edited in place after that.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GrammyError, type Api } from 'grammy';

vi.mock('../../src/claude/session-manager.js', () => ({
  sessionManager: { getSession: () => undefined },
}));

const {
  readTaskList, renderTaskList, parseTask, taskListDir, TaskListDisplay,
} = await import('../../src/telegram/task-list.js');
type TaskItem = import('../../src/telegram/task-list.js').TaskItem;
type TaskListRead = import('../../src/telegram/task-list.js').TaskListRead;

function task(id: string, status: TaskItem['status'], subject: string, blockedBy: string[] = []): TaskItem {
  return { id, subject, status, blocks: [], blockedBy };
}

/** The entities of `message` as [type, covered text] pairs. */
function styled(message: { text: string; entities: { type: string; offset: number; length: number }[] }) {
  return message.entities.map((e) => [e.type, message.text.slice(e.offset, e.offset + e.length)]);
}

describe('readTaskList', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const write = (name: string, body: unknown) =>
    fs.writeFileSync(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));

  it('reads every task file, in numeric id order, skipping the lock', () => {
    write('10.json', task('10', 'pending', 'Ten'));
    write('2.json', task('2', 'completed', 'Two'));
    write('1.json', { id: '1', subject: 'One', description: 'd', status: 'in_progress', blocks: [], blockedBy: [] });
    write('.lock', '');
    const { tasks, partial } = readTaskList('x', dir);
    expect(tasks.map((t) => t.id)).toEqual(['1', '2', '10']);
    expect(tasks[0].activeForm).toBeUndefined();
    expect(partial).toBe(false);
  });

  it('is empty for a missing directory', () => {
    expect(readTaskList('x', path.join(dir, 'nope'))).toEqual({ tasks: [], partial: false });
  });

  it('leaves out a half-written file and reports the read as partial', () => {
    write('1.json', task('1', 'pending', 'One'));
    write('2.json', '{"id":"2","subj');
    const { tasks, partial } = readTaskList('x', dir);
    expect(tasks.map((t) => t.id)).toEqual(['1']);
    expect(partial).toBe(true);
  });

  it('rejects a file that is not a task', () => {
    expect(parseTask('{"id":"1","subject":"a","status":"deleted"}')).toBeNull();
    expect(parseTask('[]')).toBeNull();
    expect(parseTask('{"id":1,"subject":"a","status":"pending"}')).toBeNull();
  });

  it("builds the path the way Claude Code does", () => {
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = '/cfg';
    try {
      expect(taskListDir('abc-123_x')).toBe('/cfg/tasks/abc-123_x');
      expect(taskListDir('a/../b')).toBe('/cfg/tasks/a----b');
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });
});

describe('renderTaskList', () => {
  it("draws Claude Code's panel: header, glyphs, strikethrough and bold", () => {
    const message = renderTaskList([
      task('3', 'pending', 'Tag the release', ['1', '2']),
      task('1', 'completed', 'Write the changelog'),
      task('2', 'in_progress', 'Run the tests'),
    ])!;
    expect(message.text).toBe([
      '3 tasks (1 done, 1 in progress, 1 open)',
      '✔︎ Write the changelog',
      '◼︎ Run the tests',
      '◻︎ Tag the release › blocked by #2',
    ].join('\n'));
    expect(styled(message)).toEqual([
      ['italic', '3 tasks (1 done, 1 in progress, 1 open)'],
      ['bold', '3'],
      ['bold', '1'],
      ['bold', '1'],
      ['bold', '1'],
      ['strikethrough', 'Write the changelog'],
      ['bold', 'Run the tests'],
      ['italic', ' › blocked by #2'],
    ]);
  });

  it('leaves "in progress" out of the header when nothing is', () => {
    const message = renderTaskList([task('1', 'pending', 'A'), task('2', 'completed', 'B')])!;
    expect(message.text.split('\n')[0]).toBe('2 tasks (1 done, 1 open)');
  });

  it('lists open blockers in id order and ignores unknown ones', () => {
    const message = renderTaskList([
      task('2', 'pending', 'B'),
      task('10', 'pending', 'J'),
      task('11', 'pending', 'K', ['10', '2', '99']),
    ])!;
    expect(message.text.split('\n')[3]).toBe('◻︎ K › blocked by #2, #10');
  });

  it('is null for an empty list', () => {
    expect(renderTaskList([])).toBeNull();
  });
});

describe('TaskListDisplay', () => {
  let tasks: TaskItem[];
  let partial: boolean;
  let nextId: number;
  let api: { sendMessage: ReturnType<typeof vi.fn>; editMessageText: ReturnType<typeof vi.fn> };
  let display: InstanceType<typeof TaskListDisplay>;
  let posts: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    tasks = [task('1', 'pending', 'One')];
    partial = false;
    nextId = 100;
    api = {
      sendMessage: vi.fn(async () => ({ message_id: nextId++ })),
      editMessageText: vi.fn(async () => true),
    };
    display = new TaskListDisplay({
      getClaudeSessionId: () => 'sess',
      read: (): TaskListRead => ({ tasks: [...tasks], partial }),
    });
    posts = [];
    display.onPost((key) => posts.push(key));
  });
  afterEach(() => { vi.useRealTimers(); });

  const asApi = () => api as unknown as Api;

  it('posts once, then edits in place, and skips an unchanged list', async () => {
    expect(await display.refresh(asApi(), '42:7')).toBe(true);
    expect(api.sendMessage).toHaveBeenCalledWith(42, expect.stringContaining('One'), expect.objectContaining({ message_thread_id: 7 }));

    tasks = [task('1', 'in_progress', 'One')];
    expect(await display.refresh(asApi(), '42:7')).toBe(false);
    expect(api.editMessageText).toHaveBeenCalledWith(42, 100, expect.stringContaining('1 in progress'), expect.anything());

    expect(await display.refresh(asApi(), '42:7')).toBe(false);
    expect(api.editMessageText).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(posts).toEqual(['42:7']);
  });

  it('posts a fresh card for the first change of a new turn', async () => {
    await display.refresh(asApi(), '42');
    display.startTurn('42');
    // Unchanged: nothing to post yet.
    expect(await display.refresh(asApi(), '42')).toBe(false);
    tasks = [task('1', 'completed', 'One')];
    expect(await display.refresh(asApi(), '42')).toBe(true);
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(api.editMessageText).not.toHaveBeenCalled();
  });

  it('treats "message is not modified" as done', async () => {
    await display.refresh(asApi(), '42');
    api.editMessageText.mockRejectedValueOnce(new GrammyError('x', {
      ok: false, error_code: 400, description: 'Bad Request: message is not modified',
    }, 'editMessageText', {}));
    tasks = [task('1', 'completed', 'One')];
    expect(await display.refresh(asApi(), '42')).toBe(false);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('posts afresh when the card was deleted', async () => {
    await display.refresh(asApi(), '42');
    api.editMessageText.mockRejectedValueOnce(new GrammyError('x', {
      ok: false, error_code: 400, description: 'Bad Request: message to edit not found',
    }, 'editMessageText', {}));
    tasks = [task('1', 'completed', 'One')];
    expect(await display.refresh(asApi(), '42')).toBe(true);
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('serialises concurrent refreshes so only one card is posted', async () => {
    const [a, b] = await Promise.all([display.refresh(asApi(), '42'), display.refresh(asApi(), '42')]);
    expect([a, b]).toEqual([true, false]);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('draws nothing for a session without tasks', async () => {
    tasks = [];
    expect(await display.refresh(asApi(), '42')).toBe(false);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it('refreshes after a write starts, and looks again until the files change', async () => {
    display.noteToolStart(asApi(), '42', 'TaskCreate');
    await vi.advanceTimersByTimeAsync(300);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);

    display.noteToolStart(asApi(), '42', 'TaskUpdate');
    await vi.advanceTimersByTimeAsync(300);
    expect(api.editMessageText).not.toHaveBeenCalled(); // not written yet
    tasks = [task('1', 'completed', 'One')];
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.editMessageText).toHaveBeenCalledTimes(1);

    // Settled: no more looks.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(api.editMessageText).toHaveBeenCalledTimes(1);
  });

  it('refreshes at tool end when a write is pending, and ignores reads', async () => {
    display.noteToolStart(asApi(), '42', 'TaskList');
    display.noteToolEnd('42');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.sendMessage).not.toHaveBeenCalled();

    display.noteToolStart(asApi(), '42', 'TaskCreate');
    display.noteToolEnd('42');
    await vi.advanceTimersByTimeAsync(0);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('waits out a file caught mid-write instead of drawing the list without it', async () => {
    await display.refresh(asApi(), '42');
    tasks = [task('1', 'pending', 'One')];
    partial = true;
    display.noteToolStart(asApi(), '42', 'TaskCreate');
    await vi.advanceTimersByTimeAsync(300);
    expect(api.editMessageText).not.toHaveBeenCalled();
    partial = false;
    tasks = [task('1', 'pending', 'One'), task('2', 'pending', 'Two')];
    await vi.advanceTimersByTimeAsync(250);
    expect(api.editMessageText).toHaveBeenCalledTimes(1);
    expect(api.editMessageText.mock.calls[0][2]).toContain('Two');
  });

  it('flush does a last refresh and stops the timers', async () => {
    display.noteToolStart(asApi(), '42', 'TaskUpdate');
    expect(await display.flush('42')).toBe(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('shows a restored list and starts a new card for the next change', async () => {
    await display.refresh(asApi(), '42');
    expect(await display.showRestored(asApi(), '42', 'sess')).toBe(true);
    expect(posts).toEqual(['42']); // the restore isn't a live post
    tasks = [task('1', 'completed', 'One')];
    expect(await display.refresh(asApi(), '42')).toBe(true);
    expect(api.sendMessage).toHaveBeenCalledTimes(3);
  });

  it('shows nothing on restore without a session id or tasks', async () => {
    expect(await display.showRestored(asApi(), '42', undefined)).toBe(false);
    tasks = [];
    expect(await display.showRestored(asApi(), '42', 'sess')).toBe(false);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
});
