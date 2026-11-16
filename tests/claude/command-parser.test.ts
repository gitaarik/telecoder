import { describe, it, expect } from 'vitest';
import {
  parseClaudeCommand,
  isClaudeCommand,
  getAvailableCommands,
  stripCommandBotMention,
  isNativeCompactCommand,
  registerBotCommandName,
  getBotCommandNames,
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
    expect(parseClaudeCommand('/resume')).toEqual({ command: 'resume', args: '', model: null });
  });

  it('parses a recognized command with args', () => {
    expect(parseClaudeCommand('/resume checkout bug')).toEqual({
      command: 'resume',
      args: 'checkout bug',
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
    for (const cmd of ['model', 'commands', 'resume', 'provider']) {
      expect(parseClaudeCommand(`/${cmd}`).command).toBe(cmd);
    }
  });
});

describe('isClaudeCommand', () => {
  it('is true for recognized commands', () => {
    expect(isClaudeCommand('/model opus')).toBe(true);
    expect(isClaudeCommand('/resume')).toBe(true);
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
    const { text } = getAvailableCommands();
    expect(text).toContain('Claude Commands');
    expect(text).toContain('/model');
    expect(text).toContain('/clear');
    expect(text).toContain('Bot Commands');
  });

  it('tells the user which native commands pass through and which are shadowed', () => {
    const { text } = getAvailableCommands();
    expect(text).toContain('/code-review');
    expect(text).toContain('the bot wins');
    expect(text).toContain('/projectcommands');
  });

  it('carries its formatting as entities, with no markup left in the text', () => {
    const { text, entities } = getAvailableCommands();
    expect(text).not.toMatch(/[`\\]/);
    expect(text).not.toContain('*');

    const spans = (type: string) =>
      entities.filter((e) => e.type === type).map((e) => text.slice(e.offset, e.offset + e.length));
    expect(spans('bold')).toContain('Claude Commands:');
    expect(spans('code')).toContain('/model [name]');
    // Code spans hold the command and nothing else: a stray escape there is
    // what once put a visible `\-` in the middle of `/code-review`.
    expect(spans('code')).toContain('/code-review');
    expect(text).toContain('• /rebuildbot - Rebuild and restart with auto-resume;');
  });
});

describe('bot command registry', () => {
  it('records the names bot.ts registers, so the shadow list cannot drift', () => {
    registerBotCommandName('steer');
    registerBotCommandName('schedule');
    expect(getBotCommandNames().has('steer')).toBe(true);
    expect(getBotCommandNames().has('schedule')).toBe(true);
  });

  it('reports nothing for a name never registered', () => {
    expect(getBotCommandNames().has('code-review')).toBe(false);
  });

  it('deduplicates repeat registrations', () => {
    const before = getBotCommandNames().size;
    registerBotCommandName('steer');
    expect(getBotCommandNames().size).toBe(before);
  });

  it('excludes a name registered only to forward the command to Claude Code', () => {
    // /compact is registered so grammY routes it (and /compact@BotName) into
    // the message pipeline, which hands it to Claude Code unchanged. Reporting
    // it as shadowed would be backwards.
    registerBotCommandName('compact', true);
    expect(getBotCommandNames().has('compact')).toBe(false);
  });

  it('does not let an earlier plain registration keep a forwarder shadowed', () => {
    registerBotCommandName('handoff');
    registerBotCommandName('handoff', true);
    expect(getBotCommandNames().has('handoff')).toBe(false);
  });
});
