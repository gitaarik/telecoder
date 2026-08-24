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

  it('tells the user which native commands pass through and which are shadowed', () => {
    const out = getAvailableCommands();
    expect(out).toContain('/code-review');
    expect(out).toContain('the bot wins');
    expect(out).toContain('/projectcommands');
  });

  it('is valid MarkdownV2 — Telegram rejects the whole message otherwise', () => {
    const out = getAvailableCommands();
    const ticks = out.match(/(?<!\\)`/g)?.length ?? 0;
    expect(ticks % 2, 'unbalanced backticks').toBe(0);

    out.split(/(?<!\\)`/).forEach((segment, i) => {
      if (i % 2 === 1) {
        // A backslash inside a code span renders literally, so escaping there
        // is what put a visible `\\-` in the middle of `/code-review`.
        expect(segment.includes('\\'), `stray backslash in code span: ${segment}`).toBe(false);
        return;
      }
      const unescaped = segment.match(/(?<!\\)[.\-!+=|{}~>#()[\]]/g) ?? [];
      expect(unescaped, `unescaped specials in: ${segment}`).toEqual([]);
      const stars = segment.match(/(?<!\\)\*/g)?.length ?? 0;
      expect(stars % 2, `unbalanced bold markers in: ${segment}`).toBe(0);
    });
  });
});

describe('bot command registry', () => {
  it('records the names bot.ts registers, so the shadow list cannot drift', () => {
    registerBotCommandName('loop');
    registerBotCommandName('schedule');
    expect(getBotCommandNames().has('loop')).toBe(true);
    expect(getBotCommandNames().has('schedule')).toBe(true);
  });

  it('reports nothing for a name never registered', () => {
    expect(getBotCommandNames().has('code-review')).toBe(false);
  });

  it('deduplicates repeat registrations', () => {
    const before = getBotCommandNames().size;
    registerBotCommandName('loop');
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
