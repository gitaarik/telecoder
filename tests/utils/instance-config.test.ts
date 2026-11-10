import { describe, it, expect } from 'vitest';
import {
  stripJsonComments,
  expandName,
  resolveInstances,
  diffInstances,
  botIdOf,
  InstancesConfigError,
  type ResolvedInstance,
} from '../../src/utils/instance-config.js';

describe('stripJsonComments', () => {
  it('removes full-line // comments', () => {
    const input = '// header comment\n{\n  "a": 1\n}';
    const out = stripJsonComments(input);
    expect(out).not.toContain('header comment');
    expect(JSON.parse(out)).toEqual({ a: 1 });
  });

  it('removes indented comment lines', () => {
    const input = '{\n    // note\n  "a": 1\n}';
    expect(JSON.parse(stripJsonComments(input))).toEqual({ a: 1 });
  });

  it('does not strip // inside string values (not a full-line comment)', () => {
    const input = '{ "url": "http://example.com" }';
    expect(stripJsonComments(input)).toBe(input);
  });
});

describe('expandName', () => {
  it('substitutes {n} with the raw index', () => {
    expect(expandName('bot-{n}', 3, 10)).toBe('bot-3');
  });

  it('pads {N} to the width of the total count', () => {
    expect(expandName('bot-{N}', 3, 10)).toBe('bot-03');
    expect(expandName('bot-{N}', 3, 100)).toBe('bot-003');
    expect(expandName('bot-{N}', 7, 9)).toBe('bot-7');
  });

  it('replaces all occurrences of both placeholders', () => {
    expect(expandName('{n}-{N}-{n}', 2, 10)).toBe('2-02-2');
  });

  it('leaves templates without placeholders unchanged', () => {
    expect(expandName('static', 1, 1)).toBe('static');
  });
});

const T1 = '111:aaa';
const T2 = '222:bbb';
const T3 = '333:ccc';

describe('botIdOf', () => {
  it('reads the bot id off a token', () => {
    expect(botIdOf('8603276066:AAH-x_y')).toBe('8603276066');
  });

  it('is empty for anything not shaped <id>:<secret>', () => {
    for (const bad of ['', '<bot-token-1>', 'abc:def', '123', '123:', ' 123:abc']) {
      expect(botIdOf(bad), bad).toBe('');
    }
  });
});

describe('resolveInstances', () => {
  it('expands a tokens list into numbered bots and applies defaults under overrides', () => {
    const text = `{
      // shared
      "defaults": { "A": "1", "B": "1" },
      "instances": [
        { "name": "TeleCoder {n}", "tokens": ["${T1}", "${T2}"], "overrides": { "B": "2" } },
        { "name": "Admin", "token": "${T3}" }
      ]
    }`;
    expect(resolveInstances(text)).toEqual([
      { name: 'TeleCoder 1', token: T1, overrides: { A: '1', B: '2' } },
      { name: 'TeleCoder 2', token: T2, overrides: { A: '1', B: '2' } },
      { name: 'Admin', token: T3, overrides: { A: '1', B: '1' } },
    ]);
  });

  it('skips entries it cannot run, and says why', () => {
    const warnings: string[] = [];
    const text = JSON.stringify({
      instances: [
        { name: 'No token' },
        { name: 'Placeholder', token: '<bot-token-4>' },
        { name: 'Good', token: T1 },
      ],
    });
    expect(resolveInstances(text, (w) => warnings.push(w)).map((i) => i.name)).toEqual(['Good']);
    expect(warnings).toHaveLength(2);
    expect(warnings.join('\n')).toContain('No token');
    expect(warnings.join('\n')).toContain('Placeholder');
  });

  it('refuses text that is not JSON — a half-saved edit', () => {
    expect(() => resolveInstances('{ "instances": [ { "name": "x", "tok')).toThrow(InstancesConfigError);
  });

  it('refuses a file with no bot it could run', () => {
    expect(() => resolveInstances('{ "instances": [] }')).toThrow(/no bots to run/);
    expect(() => resolveInstances('{}')).toThrow(InstancesConfigError);
  });

  it('refuses two bots with one name, since workers are keyed by name', () => {
    const text = JSON.stringify({ instances: [{ name: 'Same', token: T1 }, { name: 'Same', token: T2 }] });
    expect(() => resolveInstances(text)).toThrow(/two bots are named "Same"/);
  });

  it('refuses one bot listed twice, under any token', () => {
    const text = JSON.stringify({ instances: [{ name: 'A', token: '111:x' }, { name: 'B', token: '111:y' }] });
    expect(() => resolveInstances(text)).toThrow(/bot 111 is listed twice/);
  });
});

describe('diffInstances', () => {
  const bot = (name: string, token: string, overrides: Record<string, string> = {}): ResolvedInstance => ({ name, token, overrides });

  it('finds nothing between identical lists', () => {
    const list = [bot('A', T1), bot('B', T2)];
    expect(diffInstances(list, list.map((i) => ({ ...i, overrides: { ...i.overrides } })))).toEqual({ added: [], removed: [], changed: [] });
  });

  it('sees a bot appended to the file as added, leaving the others alone', () => {
    const before = [bot('TeleCoder 1', T1)];
    const after = [bot('TeleCoder 1', T1), bot('TeleCoder 2', T2)];
    expect(diffInstances(before, after)).toEqual({ added: [after[1]], removed: [], changed: [] });
  });

  it('sees a bot taken out of the file as removed', () => {
    const before = [bot('A', T1), bot('B', T2)];
    expect(diffInstances(before, [before[0]])).toEqual({ added: [], removed: [before[1]], changed: [] });
  });

  it('treats a new token for the same bot as a change to that bot, not a swap', () => {
    const before = [bot('A', '111:old')];
    const after = [bot('A', '111:new')];
    expect(diffInstances(before, after)).toEqual({ added: [], removed: [], changed: [{ from: before[0], to: after[0] }] });
  });

  it('treats a renamed bot or a changed setting as a change', () => {
    const before = [bot('A', T1, { X: '1' }), bot('B', T2)];
    const after = [bot('A', T1, { X: '2' }), bot('Bee', T2)];
    const { changed } = diffInstances(before, after);
    expect(changed.map((c) => [c.from.name, c.to.name])).toEqual([['A', 'A'], ['B', 'Bee']]);
  });

  it('renumbers the bots after one taken out of the middle of a tokens list', () => {
    const before = resolveInstances(JSON.stringify({ instances: [{ name: 'TC {n}', tokens: [T1, T2, T3] }] }));
    const after = resolveInstances(JSON.stringify({ instances: [{ name: 'TC {n}', tokens: [T1, T3] }] }));
    const diff = diffInstances(before, after);
    expect(diff.removed.map((i) => i.name)).toEqual(['TC 2']);
    expect(diff.changed.map((c) => [c.from.name, c.to.name])).toEqual([['TC 3', 'TC 2']]);
    expect(diff.added).toEqual([]);
  });
});
