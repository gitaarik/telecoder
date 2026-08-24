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

const { readLastUserPromptMarker } = await import('../../src/claude/session-jsonl.js');

const CWD = '/home/someone/dev/telecoder';
const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
let home: string;

function logPath(): string {
  return path.join(home, '.claude', 'projects', CWD.replace(/\//g, '-'), `${SESSION}.jsonl`);
}

function writeLog(records: unknown[]): void {
  const file = logPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

const userPrompt = (uuid: string, text: string) => ({
  type: 'user', uuid, timestamp: '2026-07-29T18:00:00.000Z',
  message: { role: 'user', content: [{ type: 'text', text }] },
});
const toolResult = (uuid: string) => ({
  type: 'user', uuid, timestamp: '2026-07-29T18:00:01.000Z',
  message: { role: 'user', content: [{ type: 'tool_result', text: 'ignored' }] },
});
const assistant = (uuid: string, text: string) => ({
  type: 'assistant', uuid, timestamp: '2026-07-29T18:00:02.000Z',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});

beforeAll(() => {
  home = fs.mkdtempSync(path.join(realOs.tmpdir(), 'telecoder-jsonl-'));
  process.env.TELECODER_TEST_HOME = home;
});

afterAll(() => {
  delete process.env.TELECODER_TEST_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('readLastUserPromptMarker', () => {
  it('returns undefined when the session log is not on disk', () => {
    expect(readLastUserPromptMarker(CWD, 'no-such-session')).toBeUndefined();
  });

  it('returns the last real user prompt', () => {
    writeLog([
      userPrompt('u1', 'first question'),
      assistant('a1', 'first answer'),
      userPrompt('u2', 'second question'),
      assistant('a2', 'second answer'),
    ]);
    expect(readLastUserPromptMarker(CWD, SESSION)).toEqual({ id: 'u2', text: 'second question' });
  });

  it('ignores tool_result records, which are user-role too', () => {
    writeLog([
      userPrompt('u1', 'the real prompt'),
      assistant('a1', 'thinking'),
      toolResult('tr1'),
      assistant('a2', 'done'),
    ]);
    expect(readLastUserPromptMarker(CWD, SESSION)?.id).toBe('u1');
  });

  it('ignores a background task notification, which is user-role and carries text', () => {
    // Otherwise a task finishing between submit and end-of-turn moves the
    // marker by itself, and a prompt the editor swallowed reads as delivered.
    writeLog([
      userPrompt('u1', 'the real prompt'),
      assistant('a1', 'working'),
      {
        type: 'user', uuid: 'n1', timestamp: '2026-07-29T18:00:03.000Z',
        promptSource: 'system', origin: { kind: 'task-notification' },
        message: { role: 'user', content: '<task-notification>\n<status>completed</status>\n</task-notification>' },
      },
    ]);
    expect(readLastUserPromptMarker(CWD, SESSION)?.id).toBe('u1');
  });

  it('changes identity once a new prompt lands — the signal that a turn was delivered', () => {
    writeLog([userPrompt('u1', 'in what dir are you now?')]);
    const before = readLastUserPromptMarker(CWD, SESSION);

    // A resumed pty rewrites bookkeeping records without adding a prompt: the
    // marker must stay put, so end-of-turn can tell the prompt never landed.
    writeLog([
      userPrompt('u1', 'in what dir are you now?'),
      { type: 'system', uuid: 's1', timestamp: '2026-07-29T18:56:48.000Z' },
    ]);
    expect(readLastUserPromptMarker(CWD, SESSION)).toEqual(before);

    writeLog([
      userPrompt('u1', 'in what dir are you now?'),
      userPrompt('u2', 'in what dir are you now?'),
    ]);
    expect(readLastUserPromptMarker(CWD, SESSION)?.id).toBe('u2');
  });

  it('falls back to a timestamp+text digest when no uuid is present', () => {
    writeLog([
      { type: 'user', timestamp: '2026-07-29T18:00:00.000Z', message: { role: 'user', content: 'plain string prompt' } },
    ]);
    expect(readLastUserPromptMarker(CWD, SESSION)).toEqual({
      id: '2026-07-29T18:00:00.000Z|plain string prompt',
      text: 'plain string prompt',
    });
  });
});
