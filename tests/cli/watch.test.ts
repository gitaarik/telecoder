import { describe, expect, it } from 'vitest';
import { cropStart, formatList, pickSession, type FoundSession } from '../../src/cli/commands/watch.js';
import { COMMANDS, parseArgs } from '../../src/cli/dispatch.js';

const session = (over: Partial<FoundSession>): FoundSession => ({
  key: '1', cwd: '/home/alex/mealplan', cols: 120, rows: 40, startedAt: 0, lastActiveAt: 0, bot: 'demo_bot', socket: '/x', ...over,
});

describe('telecoder watch', () => {
  it('is a command', () => {
    expect(parseArgs(['watch', 'mealplan'], COMMANDS)).toEqual({ kind: 'command', name: 'watch', args: ['mealplan'] });
  });

  it('picks the most recently active session', () => {
    const a = session({ key: 'a', lastActiveAt: 10 });
    const b = session({ key: 'b', lastActiveAt: 20 });
    expect(pickSession([a, b])).toBe(b);
    expect(pickSession([])).toBeUndefined();
  });

  it('filters by project folder, bot name or chat', () => {
    const a = session({ key: 'a', cwd: '/w/Mealplan', lastActiveAt: 10 });
    const b = session({ key: 'b', cwd: '/w/blog', bot: 'other_bot', lastActiveAt: 20 });
    expect(pickSession([a, b], 'mealplan')).toBe(a);
    expect(pickSession([a, b], '@other_bot')).toBe(b);
    expect(pickSession([a, b], 'a')).toBe(a);
    expect(pickSession([a, b], 'nothing')).toBeUndefined();
  });

  it('lists sessions, newest first', () => {
    const lines = formatList([
      session({ key: '5', lastActiveAt: 1000 }),
      session({ key: '5:9', cwd: '/w/blog', lastActiveAt: 59_000 }),
    ], 61_000);
    expect(lines).toEqual([
      '@demo_bot  blog      chat 5:9  active 2s ago',
      '@demo_bot  mealplan  chat 5    active 1m ago',
    ]);
    expect(formatList([])[0]).toMatch(/No Claude Code session/);
  });

  it('keeps the used part of the screen in view when it does not fit', () => {
    expect(cropStart(40, 40, 10)).toBe(0);
    expect(cropStart(40, 20, 10)).toBe(0);
    expect(cropStart(40, 20, 25)).toBe(6);
    expect(cropStart(40, 20, 39)).toBe(20);
  });
});
