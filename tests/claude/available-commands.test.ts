import { describe, it, expect } from 'vitest';
import {
  recordAvailableCommands,
  getCachedAvailableCommands,
  groupAvailableCommands,
} from '../../src/claude/available-commands.js';

const BIN = '/usr/bin/claude';
const OTHER_BIN = '/opt/bundled/claude';

describe('recordAvailableCommands', () => {
  it('caches what an init message reported, keyed by working directory', () => {
    recordAvailableCommands('/proj/a', BIN, ['clear', 'code-review'], ['code-review']);
    const hit = getCachedAvailableCommands('/proj/a', BIN);
    expect(hit?.slashCommands).toEqual(['clear', 'code-review']);
    expect(hit?.skills).toEqual(['code-review']);
  });

  it('keeps directories independent', () => {
    recordAvailableCommands('/proj/b', BIN, ['init'], []);
    expect(getCachedAvailableCommands('/proj/b', BIN)?.slashCommands).toEqual(['init']);
    expect(getCachedAvailableCommands('/proj/a', BIN)?.slashCommands).toContain('code-review');
  });

  it('copies the arrays so a later mutation cannot corrupt the cache', () => {
    const commands = ['clear'];
    recordAvailableCommands('/proj/c', BIN, commands, []);
    commands.push('mutated');
    expect(getCachedAvailableCommands('/proj/c', BIN)?.slashCommands).toEqual(['clear']);
  });

  it('ignores an init message with no command list', () => {
    recordAvailableCommands('/proj/d', BIN, undefined, ['skill']);
    expect(getCachedAvailableCommands('/proj/d', BIN)).toBeUndefined();
  });

  it('does not serve one binary\'s commands for another', () => {
    recordAvailableCommands('/proj/e', BIN, ['code-review'], ['code-review']);
    expect(getCachedAvailableCommands('/proj/e', BIN)?.slashCommands).toEqual(['code-review']);
    // The bundled CLI and the one on PATH drift apart between releases; a hit
    // recorded under one must not answer for the other.
    expect(getCachedAvailableCommands('/proj/e', OTHER_BIN)).toBeUndefined();
  });

  it('returns undefined for a directory never seen', () => {
    expect(getCachedAvailableCommands('/proj/never', BIN)).toBeUndefined();
  });
});

describe('groupAvailableCommands', () => {
  it('splits skills, plugin commands and built-ins', () => {
    const grouped = groupAvailableCommands({
      slashCommands: ['compact', 'code-review', 'ctx:doctor', 'clear', 'simplify'],
      skills: ['code-review', 'simplify'],
      recordedAtMs: Date.now(),
    });
    expect(grouped.skills).toEqual(['code-review', 'simplify']);
    expect(grouped.plugins).toEqual(['ctx:doctor']);
    expect(grouped.builtIns).toEqual(['clear', 'compact']);
  });

  it('treats a namespaced name as a plugin command even when listed as a skill', () => {
    const grouped = groupAvailableCommands({
      slashCommands: ['ctx:stats'],
      skills: ['ctx:stats'],
      recordedAtMs: Date.now(),
    });
    expect(grouped.plugins).toEqual(['ctx:stats']);
    expect(grouped.skills).toEqual([]);
  });

  it('puts everything in built-ins when no skills are reported', () => {
    const grouped = groupAvailableCommands({
      slashCommands: ['model', 'clear'],
      skills: [],
      recordedAtMs: Date.now(),
    });
    expect(grouped.builtIns).toEqual(['clear', 'model']);
    expect(grouped.skills).toEqual([]);
  });
});
