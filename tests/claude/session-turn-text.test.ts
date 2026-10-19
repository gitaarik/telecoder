import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as realOs from 'os';
import { vi } from 'vitest';

// sessionJsonlPath resolves under os.homedir(); point it at a scratch dir so the
// test never reads or writes the developer's real ~/.claude.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: actual, homedir: () => process.env.TELECODER_TEST_HOME ?? actual.homedir() };
});

const { readLastAssistantTurnText, readRecentExchanges, readUserPrompts } = await import('../../src/claude/session-jsonl.js');

const CWD = '/home/someone/dev/telecoder';
const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff';
let home: string;

function writeLog(records: unknown[]): void {
  const file = path.join(home, '.claude', 'projects', CWD.replace(/\//g, '-'), `${SESSION}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

const userPrompt = (uuid: string, text: string) => ({
  type: 'user', uuid, timestamp: '2026-08-24T10:00:00.000Z',
  promptSource: 'typed', origin: { kind: 'human' },
  message: { role: 'user', content: [{ type: 'text', text }] },
});
const assistant = (uuid: string, text: string) => ({
  type: 'assistant', uuid, timestamp: '2026-08-24T10:00:02.000Z',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
/**
 * A user record with no provenance fields: how Claude Code writes a note in the
 * user's place, and its record of a slash command and of what one printed.
 */
const unflagged = (uuid: string, content: string) => ({
  type: 'user', uuid, timestamp: '2026-08-24T10:00:01.000Z',
  message: { role: 'user', content },
});
const toolResult = (uuid: string) => ({
  type: 'user', uuid, timestamp: '2026-08-24T10:00:01.000Z',
  message: { role: 'user', content: [{ type: 'tool_result', text: 'ignored' }] },
});
/** What Claude Code writes when a background task reports in mid-turn. */
const taskNotification = (uuid: string, summary: string) => ({
  type: 'user', uuid, timestamp: '2026-08-24T10:00:03.000Z',
  promptSource: 'system', origin: { kind: 'task-notification' },
  message: {
    role: 'user',
    content: `<task-notification>\n<task-id>${uuid}</task-id>\n<status>completed</status>\n<summary>${summary}</summary>\n</task-notification>`,
  },
});

beforeAll(() => {
  home = fs.mkdtempSync(path.join(realOs.tmpdir(), 'telecoder-turntext-'));
  process.env.TELECODER_TEST_HOME = home;
});

afterAll(() => {
  delete process.env.TELECODER_TEST_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('readLastAssistantTurnText', () => {
  it('returns undefined when the session log is not on disk', () => {
    expect(readLastAssistantTurnText(CWD, 'no-such-session')).toBeUndefined();
  });

  it('joins every assistant block of the turn, not just the last one', () => {
    writeLog([
      userPrompt('u1', 'do the thing'),
      assistant('a1', 'starting'),
      toolResult('tr1'),
      assistant('a2', 'done'),
    ]);
    expect(readLastAssistantTurnText(CWD, SESSION)).toBe('starting\n\ndone');
  });

  it('slices at the last real prompt, dropping the previous turn', () => {
    writeLog([
      userPrompt('u1', 'first'),
      assistant('a1', 'first answer'),
      userPrompt('u2', 'second'),
      assistant('a2', 'second answer'),
    ]);
    expect(readLastAssistantTurnText(CWD, SESSION)).toBe('second answer');
  });

  it('keeps prose written before a mid-turn background task notification', () => {
    // The truncation bug: a task-notification is a *user*-role record carrying
    // real text, so boundary logic that only checks for prose slices the turn
    // there and hands back the tail alone.
    writeLog([
      userPrompt('u1', 'run the audit in the background and summarise'),
      assistant('a1', 'the long answer the user actually asked for'),
      taskNotification('n1', 'Agent "Audit" completed'),
      assistant('a2', 'and a note about the finished background task'),
    ]);
    expect(readLastAssistantTurnText(CWD, SESSION)).toBe(
      'the long answer the user actually asked for\n\nand a note about the finished background task',
    );
  });

  it('ignores a task notification recorded without origin metadata', () => {
    writeLog([
      userPrompt('u1', 'go'),
      assistant('a1', 'answer'),
      { ...taskNotification('n1', 'done'), origin: undefined },
      assistant('a2', 'tail'),
    ]);
    expect(readLastAssistantTurnText(CWD, SESSION)).toBe('answer\n\ntail');
  });

  it('ignores the local-command caveat a slash command writes', () => {
    writeLog([
      userPrompt('u0', 'earlier question'),
      assistant('a0', 'earlier answer'),
      {
        type: 'user', uuid: 'm1', timestamp: '2026-08-24T10:05:00.000Z', isMeta: true,
        message: { role: 'user', content: '<local-command-caveat>Caveat: …</local-command-caveat>' },
      },
      { ...userPrompt('u1', '/code-review'), promptSource: undefined },
      assistant('a1', 'review output'),
    ]);
    expect(readLastAssistantTurnText(CWD, SESSION)).toBe('review output');
  });

  it('still treats a plain prompt with no provenance fields as a boundary', () => {
    // Logs written by older Claude Code versions carry no origin/promptSource;
    // the denylist must leave them working exactly as before.
    writeLog([
      { type: 'user', uuid: 'u1', timestamp: '2026-08-24T10:00:00.000Z', message: { role: 'user', content: 'old-style prompt' } },
      assistant('a1', 'old-style answer'),
    ]);
    expect(readLastAssistantTurnText(CWD, SESSION)).toBe('old-style answer');
  });

  it('returns undefined when the turn produced no prose', () => {
    writeLog([userPrompt('u1', 'just run a tool'), toolResult('tr1')]);
    expect(readLastAssistantTurnText(CWD, SESSION)).toBeUndefined();
  });
});

describe('readRecentExchanges', () => {
  it('keeps one reply as one exchange when a background task reports in', () => {
    writeLog([
      userPrompt('u1', 'run the audit and summarise'),
      assistant('a1', 'first half'),
      taskNotification('n1', 'Agent "Audit" completed'),
      assistant('a2', 'second half'),
    ]);
    expect(readRecentExchanges(CWD, SESSION, 3)).toEqual([
      { user: 'run the audit and summarise', assistant: 'first half\n\nsecond half' },
    ]);
  });

  it('leaves a /compact out of the exchange after it', () => {
    writeLog([
      userPrompt('u1', 'one'), assistant('a1', 'r1'),
      unflagged('c1', '/compact'),
      unflagged('c2', '<command-name>/compact</command-name>\n<command-message>compact</command-message>'),
      unflagged('c3', '<local-command-stdout>Compacted</local-command-stdout>'),
      userPrompt('u2', 'two'), assistant('a2', 'r2'),
    ]);
    expect(readRecentExchanges(CWD, SESSION, 3)).toEqual([
      { user: 'one', assistant: 'r1' },
      { user: 'two', assistant: 'r2' },
    ]);
  });

  it('leaves out an interrupt note, keeping the interrupted prompt with the next', () => {
    writeLog([
      userPrompt('u1', 'do it this way'),
      toolResult('tr1'),
      unflagged('n1', '[Request interrupted by user for tool use]'),
      userPrompt('u2', 'no, the other way'), assistant('a1', 'Done.'),
    ]);
    expect(readRecentExchanges(CWD, SESSION, 3)).toEqual([
      { user: 'do it this way\n\nno, the other way', assistant: 'Done.' },
    ]);
  });

  it('keeps a command that was answered, so its reply stays its own exchange', () => {
    const review = '<command-name>/review</command-name>\n<command-args>high</command-args>';
    writeLog([
      userPrompt('u1', 'one'), assistant('a1', 'r1'),
      unflagged('c1', review),
      assistant('a2', 'Reviewed.'),
    ]);
    expect(readRecentExchanges(CWD, SESSION, 3)).toEqual([
      { user: 'one', assistant: 'r1' },
      { user: review, assistant: 'Reviewed.' },
    ]);
  });
});

describe('readUserPrompts', () => {
  it('keeps the trailing prompt that has no reply yet and flags it pending', () => {
    writeLog([
      userPrompt('u1', 'first question'),
      assistant('a1', 'first answer'),
      userPrompt('u2', 'still running'),
    ]);
    expect(readUserPrompts(CWD, SESSION)).toEqual([
      { text: 'first question', timestamp: '2026-08-24T10:00:00.000Z', pending: false },
      { text: 'still running', timestamp: '2026-08-24T10:00:00.000Z', pending: true },
    ]);
  });

  it('ignores tool results and records Claude Code injected itself', () => {
    writeLog([
      userPrompt('u1', 'run the audit and summarise'),
      assistant('a1', 'first half'),
      toolResult('tr1'),
      taskNotification('n1', 'Agent "Audit" completed'),
      assistant('a2', 'second half'),
    ]);
    expect(readUserPrompts(CWD, SESSION)).toEqual([
      { text: 'run the audit and summarise', timestamp: '2026-08-24T10:00:00.000Z', pending: false },
    ]);
  });

  it('keeps a prompt apart from the records before it that got no reply', () => {
    // What a /compact leaves: nothing answers these before the next prompt.
    writeLog([
      userPrompt('u1', 'one'), assistant('a1', 'r1'),
      unflagged('c1', '/compact'),
      unflagged('c2', '<command-name>/compact</command-name>'),
      unflagged('c3', '<local-command-stdout>Compacted</local-command-stdout>'),
      userPrompt('u2', 'two'), assistant('a2', 'r2'),
    ]);
    // What the command printed is gone already; the commands are the caller's to drop.
    expect(readUserPrompts(CWD, SESSION).map((p) => [p.text, p.pending])).toEqual([
      ['one', false],
      ['/compact', true],
      ['<command-name>/compact</command-name>', true],
      ['two', false],
    ]);
  });

  it('flags a prompt that was interrupted before any reply', () => {
    writeLog([
      userPrompt('u1', 'do it this way'),
      toolResult('tr1'),
      unflagged('n1', '[Request interrupted by user]'),
      userPrompt('u2', 'no, the other way'), assistant('a1', 'Done.'),
    ]);
    expect(readUserPrompts(CWD, SESSION).map((p) => [p.text, p.pending])).toEqual([
      ['do it this way', true],
      ['no, the other way', false],
    ]);
  });

  it('returns nothing when the session log is not on disk', () => {
    expect(readUserPrompts(CWD, 'no-such-session')).toEqual([]);
  });
});
