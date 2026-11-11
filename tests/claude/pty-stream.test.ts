import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { lastAssistantTurnText } from '../../src/claude/session-jsonl.js';
import {
  PtyTurnStream, TurnProseReader, comparable, inflightBlockRows, unwrapRows,
} from '../../src/claude/pty-stream.js';

// ---- Log records, in the shapes Claude Code writes them ----------------------

const prompt = (text: string) => ({
  type: 'user', uuid: `u-${text}`, promptSource: 'typed', origin: { kind: 'human' },
  message: { role: 'user', content: [{ type: 'text', text }] },
});
const said = (text: string) => ({
  type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const thought = () => ({
  type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '' }] },
});
const toolUse = () => ({
  type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] },
});
const toolResult = () => ({
  type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'hello' }] },
});
const taskNotification = () => ({
  type: 'user', promptSource: 'system', origin: { kind: 'task-notification' },
  message: { role: 'user', content: '<task-notification><status>completed</status></task-notification>' },
});
const apiError = () => ({
  type: 'assistant', isApiErrorMessage: true,
  message: { role: 'assistant', content: [{ type: 'text', text: 'API Error: socket hang up' }] },
});
const turnDuration = () => ({ type: 'system', subtype: 'turn_duration', durationMs: 6000 });

const lines = (...records: unknown[]) => records.map((r) => JSON.stringify(r) + '\n').join('');

// ---- Screens, as a 120x40 claude 2.1.3xx draws them -------------------------

const COLS = 120;
const RULE = '─'.repeat(COLS);
const STATUS_ROW = `${' '.repeat(100)}◐ medium · /effort`;

/** The transcript rows given, then the chrome claude draws below them. */
function screen(transcript: string[], statusRow = STATUS_ROW): string {
  return [
    ...transcript,
    '',
    statusRow,
    RULE,
    '❯ ',
    RULE,
    '  ◇ Haiku 5.5  work  ⚡ 9 agents',
    '  -- INSERT -- ⏵⏵ bypass permissions on (shift+tab to cycle)',
  ].join('\n');
}

const PROMPT_ECHO = ['❯ Say one short sentence about what you will do. Then run the Bash command: echo hello.'];

describe('TurnProseReader', () => {
  it('collects the turn\'s text records the way the end-of-turn read joins them', () => {
    const turn = lines(
      prompt('do it'), thought(), said('I\'ll run it.'), toolUse(), toolResult(),
      taskNotification(), apiError(), said('## Result\n\nIt printed **hello**.'), turnDuration(),
    );
    const reader = new TurnProseReader('/nonexistent', 0);
    reader.consume(Buffer.from(turn));
    expect(reader.started).toBe(true);
    expect(reader.records.join('\n\n')).toBe(lastAssistantTurnText(turn));
    expect(reader.records).toEqual(['I\'ll run it.', '## Result\n\nIt printed **hello**.']);
  });

  it('holds back a record until its line is complete, even split inside a character', () => {
    const reader = new TurnProseReader('/nonexistent', 0);
    const bytes = Buffer.from(lines(prompt('go'), said('Café ✓ done')));
    const cut = bytes.indexOf(Buffer.from('✓')) + 1;
    reader.consume(bytes.subarray(0, cut));
    expect(reader.records).toEqual([]);
    reader.consume(bytes.subarray(cut));
    expect(reader.records).toEqual(['Café ✓ done']);
  });

  it('reads nothing before the turn\'s prompt reaches the log', () => {
    const reader = new TurnProseReader('/nonexistent', 0);
    reader.consume(Buffer.from(lines(said('the previous turn\'s answer'))));
    expect(reader.started).toBe(false);
    expect(reader.records).toEqual([]);
  });

  it('takes every text record for a slash command, prompt or not', () => {
    const reader = new TurnProseReader('/nonexistent', 0, true);
    reader.consume(Buffer.from(lines(said('review starts'), prompt('<command-name>/review</command-name>'), said('found two issues'))));
    expect(reader.records).toEqual(['review starts', 'found two issues']);
  });

  describe('poll', () => {
    let dir: string;
    let file: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-ptystream-'));
      file = path.join(dir, 'session.jsonl');
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('reads only what the turn appended after submit, as it is appended', () => {
      fs.writeFileSync(file, lines(prompt('earlier'), said('earlier answer')));
      const reader = new TurnProseReader(file, fs.statSync(file).size);
      reader.poll();
      expect(reader.records).toEqual([]);
      fs.appendFileSync(file, lines(prompt('now'), said('first block')));
      reader.poll();
      expect(reader.records).toEqual(['first block']);
      fs.appendFileSync(file, lines(toolUse(), toolResult(), said('second block')));
      reader.poll();
      expect(reader.records).toEqual(['first block', 'second block']);
    });

    it('survives a log that is not there yet', () => {
      const reader = new TurnProseReader(path.join(dir, 'missing.jsonl'), 0);
      expect(() => reader.poll()).not.toThrow();
      expect(reader.records).toEqual([]);
    });
  });
});

describe('inflightBlockRows', () => {
  // Measured: a list streaming, a finished line at a time, with no spinner.
  const streamingList = screen([
    ...PROMPT_ECHO,
    '● 1. aardvark',
    '  2. albatross',
    '  3. alligator',
    '  4. alpaca',
    '  5.',
  ]);

  it('reads the block claude is streaming, head first, without its indent', () => {
    expect(inflightBlockRows(streamingList)).toEqual(['1. aardvark', '2. albatross', '3. alligator', '4. alpaca', '5.']);
  });

  it('reads a block streaming under one that ended before a tool call', () => {
    const rows = inflightBlockRows(screen([
      ...PROMPT_ECHO,
      '● I\'ll run the echo hello command first, then write the Mars answer.',
      '  Ran 1 shell command ',
      '● Result',
      '  The shell command printed hello.',
      '  1. Mars is the fourth planet from the Sun.',
      '  2.',
    ]));
    expect(rows).toEqual(['Result', 'The shell command printed hello.', '1. Mars is the fourth planet from the Sun.', '2.']);
  });

  it('leaves out a notice claude draws flush right above the input box', () => {
    const rows = inflightBlockRows(screen(
      ['● 23. The Moon\'s escape velocity is about 2.38 km/s.', '  24. Its orbit is tilted about 5.1 degrees.'],
      `${' '.repeat(80)}✔ Update installed · /restart to apply`,
    ));
    expect(rows).toEqual(['23. The Moon\'s escape velocity is about 2.38 km/s.', '24. Its orbit is tilted about 5.1 degrees.']);
  });

  it.each([
    ['a live spinner (thinking or a tool running)', [
      '● I\'ll run the echo hello command first.',
      '● Printing hello to stdout',
      '  ⎿  $ echo hello',
      '✶ Cultivating… (running PreToolUse hook · 2s · ↓ 175 tokens · thinking)',
    ]],
    ['a call whose bullet has blinked off', [
      '● I\'ll run the echo hello command first.',
      '  Printing hello to stdout',
      '  ⎿  $ echo hello',
    ]],
    ['the turn\'s summary, once it is over', [
      '● Result',
      '  Mars remains one of the most studied planets.',
      '✻ Baked for 6s · done 2:35 PM',
    ]],
    ['a call still running', ['● Running 1 shell command…']],
    ['a call', ['● Bash(echo hello)']],
    ['calls collapsed into one row', ['● Read 1 file (ctrl+o to expand)']],
    ['an agent\'s notice', ['● Agent "Run the checks" finished · 4s']],
    ['a bullet with nothing after it yet', ['●']],
    ['the prompt just submitted, below the previous answer', ['● The previous answer.', ...PROMPT_ECHO]],
    ['a block whose head has scrolled off the screen', ['  10. badger', '  11. barracuda', '  12.']],
  ])('reads nothing under %s', (_name, transcript) => {
    expect(inflightBlockRows(screen(transcript))).toBeUndefined();
  });

  it('reads nothing while a dialog covers the input box', () => {
    const dialog = [
      '● Let me check.',
      RULE,
      ' Bash command',
      '   rm -rf build',
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. No',
    ].join('\n');
    expect(inflightBlockRows(dialog)).toBeUndefined();
  });
});

describe('unwrapRows', () => {
  it('joins rows claude wrapped at the terminal width, and only those', () => {
    const rows = [
      '1. The Moon is Earth\'s only natural satellite and the fifth-largest moon in the Solar System.',
      '5. The Moon takes about 27.3 days to orbit Earth, but about 29.5 days to cycle through its phases, because Earth also',
      '   moves around the Sun.',
      '6. The Moon\'s surface gravity is about one-sixth of Earth\'s.',
    ];
    expect(unwrapRows(rows, COLS)).toBe([
      rows[0],
      `${rows[1]} moves around the Sun.`,
      rows[3],
    ].join('\n'));
  });

  it('leaves a table drawn in box drawing as it is', () => {
    const table = ['┌───────┬───────┐', '│ cell1 │ cell2 │', '└───────┴───────┘'];
    expect(unwrapRows(table, 17)).toBe(table.join('\n'));
  });
});

describe('comparable', () => {
  it('reads a drawn block and its Markdown record as the same words', () => {
    expect(comparable('Result\nIt printed hello in code.'))
      .toBe(comparable('## Result\n\nIt printed **hello** in `code`.'));
  });
});

describe('PtyTurnStream', () => {
  function setup(delivered?: () => string | undefined) {
    const reader = new TurnProseReader('/nonexistent', 0);
    const emitted: string[] = [];
    const stream = new PtyTurnStream(reader, (t) => emitted.push(t), delivered ?? (() => undefined));
    const log = (...records: unknown[]) => reader.consume(Buffer.from(lines(...records)));
    const tick = (transcript?: string[]) => stream.tick(transcript ? screen(transcript) : undefined, COLS);
    return { emitted, log, tick };
  }

  it('streams a block once it grows, then hands over to its record without repeating it', () => {
    const { emitted, log, tick } = setup();
    log(prompt('list animals'));
    tick([...PROMPT_ECHO, '✶ Nebulizing… (1s · thinking)']);
    tick([...PROMPT_ECHO, '● 1. aardvark', '  2.']);
    expect(emitted).toEqual([]);
    tick([...PROMPT_ECHO, '● 1. aardvark', '  2. albatross', '  3.']);
    expect(emitted).toEqual(['1. aardvark\n2. albatross\n3.']);
    log(said('1. aardvark\n2. albatross\n3. alligator'), turnDuration());
    tick([...PROMPT_ECHO, '● 1. aardvark', '  2. albatross', '  3. alligator', '✻ Baked for 3s']);
    expect(emitted.at(-1)).toBe('1. aardvark\n2. albatross\n3. alligator');
  });

  it('puts the streaming block after the turn\'s earlier records', () => {
    const { emitted, log, tick } = setup();
    log(prompt('do it'), said('I\'ll run it first.'), toolUse(), toolResult());
    tick([...PROMPT_ECHO, '● I\'ll run it first.', '  Ran 1 shell command ', '● Result']);
    tick([...PROMPT_ECHO, '● I\'ll run it first.', '  Ran 1 shell command ', '● Result', '  It printed hello.']);
    expect(emitted.at(-1)).toBe('I\'ll run it first.\n\nResult\nIt printed hello.');
  });

  it('never streams a call\'s row drawn under a block that has landed', () => {
    const { emitted, log, tick } = setup();
    log(prompt('do it'));
    tick([...PROMPT_ECHO, '● I\'ll run it first.']);
    log(said('I\'ll run it first.'), toolUse());
    // The call finished and collapsed: its row has no bullet and reads like
    // another row of the text above it.
    tick([...PROMPT_ECHO, '● I\'ll run it first.', '  Ran 1 shell command ']);
    tick([...PROMPT_ECHO, '● I\'ll run it first.', '  Ran 1 shell command ', '  Ran 2 shell commands']);
    expect(emitted).toEqual(['I\'ll run it first.']);
  });

  it('never streams a notice, which is drawn whole and does not grow', () => {
    const { emitted, log, tick } = setup();
    log(prompt('do it'));
    const notice = [...PROMPT_ECHO, '● Background shell finished', '  exit code 0'];
    tick(notice);
    tick(notice);
    tick(notice);
    expect(emitted).toEqual([]);
  });

  it('streams nothing before the turn\'s prompt reaches the log', () => {
    const { emitted, tick } = setup();
    tick(['● The previous turn\'s answer.']);
    tick(['● The previous turn\'s answer.', '  Its second line.']);
    expect(emitted).toEqual([]);
  });

  it('keeps a block that scrolled its head off until its record lands', () => {
    const { emitted, log, tick } = setup();
    log(prompt('list'));
    tick([...PROMPT_ECHO, '● 1. aardvark', '  2.']);
    tick([...PROMPT_ECHO, '● 1. aardvark', '  2. albatross', '  3.']);
    tick(['  41. crow', '  42. deer', '  43.']);
    expect(emitted).toEqual(['1. aardvark\n2. albatross\n3.']);
    log(said('1. aardvark\n2. albatross\n3. alligator\n…\n70. zebra'));
    tick(['  69. yak', '  70. zebra']);
    expect(emitted.at(-1)).toBe('1. aardvark\n2. albatross\n3. alligator\n…\n70. zebra');
  });

  it('leaves out what an ask_user flush already sent, and says so when that was all of it', () => {
    let delivered: string | undefined;
    const { emitted, log, tick } = setup(() => delivered);
    log(prompt('pick one'), said('Two options: A or B.'));
    tick();
    expect(emitted).toEqual(['Two options: A or B.']);
    delivered = 'Two options: A or B.';
    tick();
    expect(emitted.at(-1)).toBe('');
    log(said('Going with A.'));
    tick();
    expect(emitted.at(-1)).toBe('Going with A.');
  });

  it('only emits when the prose changed', () => {
    const { emitted, log, tick } = setup();
    log(prompt('hi'), said('Hello.'));
    tick();
    tick();
    tick();
    expect(emitted).toEqual(['Hello.']);
  });
});
