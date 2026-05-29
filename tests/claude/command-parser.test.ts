import { describe, it, expect } from 'vitest';
import {
  parseClaudeCommand,
  isClaudeCommand,
  getAvailableCommands,
} from '../../src/claude/command-parser.js';

describe('parseClaudeCommand', () => {
  it('returns no command for plain text', () => {
    expect(parseClaudeCommand('hello there')).toEqual({
      command: null,
      args: 'hello there',
      model: null,
    });
  });

  it('parses a recognized command without args', () => {
    expect(parseClaudeCommand('/plan')).toEqual({ command: 'plan', args: '', model: null });
  });

  it('parses a recognized command with args', () => {
    expect(parseClaudeCommand('/explore how does auth work')).toEqual({
      command: 'explore',
      args: 'how does auth work',
      model: null,
    });
  });

  it('trims surrounding whitespace from the message and args', () => {
    expect(parseClaudeCommand('   /model   opus   ')).toEqual({
      command: 'model',
      args: 'opus',
      model: null,
    });
  });

  it('treats an unrecognized slash command as plain text', () => {
    const trimmed = '/notacommand do thing';
    expect(parseClaudeCommand(`  ${trimmed}  `)).toEqual({
      command: null,
      args: trimmed,
      model: null,
    });
  });

  it('recognizes every command in the allow-list', () => {
    for (const cmd of ['plan', 'explore', 'model', 'commands', 'loop', 'resume', 'continue', 'sessions', 'provider']) {
      expect(parseClaudeCommand(`/${cmd}`).command).toBe(cmd);
    }
  });
});

describe('isClaudeCommand', () => {
  it('is true for recognized commands', () => {
    expect(isClaudeCommand('/plan something')).toBe(true);
    expect(isClaudeCommand('/sessions')).toBe(true);
  });

  it('is false for plain text and unknown commands', () => {
    expect(isClaudeCommand('hello')).toBe(false);
    expect(isClaudeCommand('/unknown')).toBe(false);
  });
});

describe('getAvailableCommands', () => {
  it('lists always-on sections and core commands', () => {
    const out = getAvailableCommands();
    expect(out).toContain('Claude Commands');
    expect(out).toContain('/plan');
    expect(out).toContain('/clear');
    expect(out).toContain('Bot Commands');
  });
});
