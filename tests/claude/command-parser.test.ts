import { describe, it, expect } from 'vitest';
import {
  parseClaudeCommand,
  isClaudeCommand,
  getAvailableCommands,
  stripCommandBotMention,
  isNativeCompactCommand,
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

describe('stripCommandBotMention', () => {
  it('strips a @BotName mention from a bare command', () => {
    expect(stripCommandBotMention('/compact@MyBot')).toBe('/compact');
  });

  it('strips the mention but keeps the command args', () => {
    expect(stripCommandBotMention('/compact@MyBot keep the plan')).toBe('/compact keep the plan');
  });

  it('leaves a command without a mention untouched', () => {
    expect(stripCommandBotMention('/compact keep the plan')).toBe('/compact keep the plan');
  });

  it('leaves ordinary text and slash-paths untouched', () => {
    expect(stripCommandBotMention('email me @ someone please')).toBe('email me @ someone please');
    expect(stripCommandBotMention('/some/path@host')).toBe('/some/path@host');
  });
});

describe('isNativeCompactCommand', () => {
  it('matches /compact and its @mention / args forms', () => {
    expect(isNativeCompactCommand('/compact')).toBe(true);
    expect(isNativeCompactCommand('  /compact  ')).toBe(true);
    expect(isNativeCompactCommand('/compact@MyBot')).toBe(true);
    expect(isNativeCompactCommand('/compact focus on the bug')).toBe(true);
  });

  it('does not match look-alikes or plain text', () => {
    expect(isNativeCompactCommand('/compacted')).toBe(false);
    expect(isNativeCompactCommand('please /compact')).toBe(false);
    expect(isNativeCompactCommand('compact')).toBe(false);
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
