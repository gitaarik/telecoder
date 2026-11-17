import { describe, it, expect } from 'vitest';
import {
  buildCommandMenu,
  buildCommandSearchMessage,
  buildUnknownCommandMessage,
  editDistance,
  findCommandFix,
  searchCommands,
  suggestCommands,
  type CommandMenuEntry,
} from '../../src/bot/command-catalog.js';

const menu: CommandMenuEntry[] = [
  { command: 'status', description: '📊 Show current session status' },
  { command: 'tasks', description: '🔄 List active background tasks' },
  { command: 'shells', description: '🔍 List & kill background shells (PTY mode)' },
  { command: 'schedule', description: '🔔 Schedule a recurring prompt (e.g. every 1h, daily 9am)' },
  { command: 'schedules', description: '🔔 List active scheduled tasks' },
  { command: 'users', description: '👥 Show who can use this bot' },
  { command: 'mode', description: '🔐 How much Claude asks before acting' },
  { command: 'model', description: '🤖 Switch AI model' },
  { command: 'terminal', description: '💻 Continue this session in a terminal' },
  { command: 'topic', description: '💬 Set the conversation topic' },
  { command: 'commands', description: '📜 List all commands' },
];
const names = [...menu.map((e) => e.command), 'stop'];

describe('editDistance', () => {
  it('counts insertions, deletions, substitutions and swaps as one each', () => {
    expect(editDistance('tasks', 'tasks')).toBe(0);
    expect(editDistance('task', 'tasks')).toBe(1);
    expect(editDistance('satus', 'status')).toBe(1);
    expect(editDistance('stauts', 'status')).toBe(1);
    expect(editDistance('comand', 'commands')).toBe(2);
  });
});

describe('suggestCommands', () => {
  it('completes a prefix, shortest completion first', () => {
    expect(suggestCommands('sched', names, menu).map((e) => e.command)).toEqual(['schedule', 'schedules']);
  });

  it('finds a command within a typo', () => {
    expect(suggestCommands('satus', names, menu)[0].command).toBe('status');
    expect(suggestCommands('shel', names, menu)[0].command).toBe('shells');
    expect(suggestCommands('comand', names, menu)[0].command).toBe('commands');
  });

  it('allows one edit on a short token and two on a longer one', () => {
    expect(suggestCommands('mod', names, menu).map((e) => e.command)).toEqual(['mode', 'model']);
    expect(suggestCommands('mdl', names, menu)).toEqual([]);
    expect(suggestCommands('schedlue', names, menu)[0].command).toBe('schedule');
  });

  it('needs three letters before a prefix counts', () => {
    expect(suggestCommands('t', names, menu)).toEqual([]);
    expect(suggestCommands('te', names, menu)).toEqual([]);
    expect(suggestCommands('ter', names, menu).map((e) => e.command)).toEqual(['terminal']);
  });

  it('puts a case variant of the real name first', () => {
    expect(suggestCommands('Tasks', names, menu)[0].command).toBe('tasks');
  });

  it('includes a registered alias missing from the menu, without a description', () => {
    expect(suggestCommands('sto', names, menu)).toEqual([{ command: 'stop', description: '' }]);
  });

  it('caps the list', () => {
    expect(suggestCommands('s', names, menu, 2).length).toBeLessThanOrEqual(2);
    expect(suggestCommands('sche', names, menu, 1).map((e) => e.command)).toEqual(['schedule']);
  });
});

describe('searchCommands', () => {
  it('matches a word in the description', () => {
    expect(searchCommands('kill', menu).map((e) => e.command)).toEqual(['shells']);
  });

  it('ranks a name match above a description match', () => {
    expect(searchCommands('tasks', menu).map((e) => e.command)).toEqual(['tasks', 'schedules']);
  });

  it('requires every word', () => {
    expect(searchCommands('list background', menu).map((e) => e.command)).toEqual(['shells', 'tasks']);
    expect(searchCommands('active background', menu).map((e) => e.command)).toEqual(['tasks']);
    expect(searchCommands('active nonsense', menu)).toEqual([]);
  });

  it('tolerates a typo in a long enough word, in the name or the description', () => {
    expect(searchCommands('shedule', menu).map((e) => e.command)).toEqual(['schedule']);
    expect(searchCommands('terminl', menu).map((e) => e.command)).toEqual(['terminal']);
  });

  it('ignores a leading slash and emoji', () => {
    expect(searchCommands('/model', menu).map((e) => e.command)).toEqual(['model']);
    expect(searchCommands('🔔', menu)).toEqual([]);
  });
});

describe('findCommandFix', () => {
  const opts = { botNames: names, forwarded: ['compact'], entries: menu };

  it('ignores plain text and paths', () => {
    expect(findCommandFix('hello', opts)).toBeNull();
    expect(findCommandFix('/tmp/foo.txt', opts)).toBeNull();
  });

  it('ignores a registered command and one that forwards to the agent', () => {
    expect(findCommandFix('/tasks', opts)).toBeNull();
    expect(findCommandFix('/compact keep the plan', opts)).toBeNull();
  });

  it('ignores a name nothing comes close to', () => {
    expect(findCommandFix('/code-review', opts)).toBeNull();
    expect(findCommandFix('/init', opts)).toBeNull();
  });

  it('keeps the arguments as typed', () => {
    const fix = findCommandFix('/sched every 1h  check the builds', opts);
    expect(fix?.token).toBe('sched');
    expect(fix?.args).toBe('every 1h  check the builds');
    expect(fix?.suggestions.map((e) => e.command)).toEqual(['schedule', 'schedules']);
  });
});

describe('messages', () => {
  it('lists the suggestions as tappable commands', () => {
    const msg = buildUnknownCommandMessage('shel', suggestCommands('shel', names, menu));
    expect(msg.text).toContain("/shel isn't a command here");
    expect(msg.text).toContain('/shells — 🔍 List & kill background shells (PTY mode)');
  });

  it('says when a search finds nothing', () => {
    expect(buildCommandSearchMessage('zzz', []).text).toContain('No command matches zzz');
    expect(buildCommandSearchMessage('kill', searchCommands('kill', menu)).text).toContain('/shells');
  });
});

describe('buildCommandMenu', () => {
  it('has a description for every command and no duplicates', () => {
    const list = buildCommandMenu();
    expect(list.length).toBeGreaterThan(30);
    expect(new Set(list.map((e) => e.command)).size).toBe(list.length);
    for (const e of list) expect(e.description.length).toBeGreaterThan(0);
  });

  it('leaves /teleport to Claude Code: the hand-off to a terminal is /terminal', () => {
    const list = buildCommandMenu();
    const names = list.map((e) => e.command);
    expect(names).toContain('terminal');
    // Claude Code has a /teleport of its own (alias /tp), and a bot command of
    // the same name wins over it. Nor may either read as a typo of a bot
    // command: the headless command list leaves them out, so a "did you mean"
    // would be answered in their place.
    expect(names).not.toContain('teleport');
    const opts = { botNames: names, forwarded: [], entries: list };
    expect(findCommandFix('/teleport', opts)).toBeNull();
    expect(findCommandFix('/tp', opts)).toBeNull();
  });
});
