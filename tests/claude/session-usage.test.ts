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

const { readLastCompactionFromJsonl, readLastUsageFromJsonl } = await import('../../src/claude/session-jsonl.js');

const CWD = '/home/someone/dev/telecoder';
const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-111111111111';
let home: string;

function writeLog(records: unknown[]): void {
  const file = path.join(home, '.claude', 'projects', CWD.replace(/\//g, '-'), `${SESSION}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

const userPrompt = (uuid: string, text: string) => ({
  type: 'user', uuid, timestamp: '2026-10-26T10:00:00.000Z',
  promptSource: 'typed', origin: { kind: 'human' },
  message: { role: 'user', content: [{ type: 'text', text }] },
});
const assistant = (uuid: string, usage: Record<string, number>) => ({
  type: 'assistant', uuid, timestamp: '2026-10-26T10:00:02.000Z',
  message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'ok' }], usage },
});
/** The usage block on the last reply before the /compact, from a real log. */
const bigContext = { input_tokens: 2, cache_read_input_tokens: 535221, cache_creation_input_tokens: 876, output_tokens: 320 };
const boundary = (compactMetadata: Record<string, unknown>) => ({
  type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted',
  timestamp: '2026-10-26T10:05:00.000Z', compactMetadata,
});
/** Everything a manual /compact appends after its boundary. None of it carries usage. */
const compactTail = () => [
  {
    type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true,
    message: { role: 'user', content: 'This session is being continued from a previous conversation…' },
  },
  { type: 'user', isMeta: true, message: { role: 'user', content: '<local-command-caveat>…</local-command-caveat>' } },
  { type: 'user', message: { role: 'user', content: '<command-name>/compact</command-name>' } },
  { type: 'user', message: { role: 'user', content: '<local-command-stdout>Compacted</local-command-stdout>' } },
  { type: 'attachment', attachment: { type: 'compact_file_reference', filename: '/home/someone/PLAN.md' } },
];

beforeAll(() => {
  home = fs.mkdtempSync(path.join(realOs.tmpdir(), 'telecoder-usage-'));
  process.env.TELECODER_TEST_HOME = home;
});

afterAll(() => {
  delete process.env.TELECODER_TEST_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('readLastUsageFromJsonl', () => {
  it('returns the last reply\'s usage', () => {
    writeLog([userPrompt('u1', 'hi'), assistant('a1', bigContext)]);
    expect(readLastUsageFromJsonl(CWD, SESSION)).toMatchObject({
      inputTokens: 2, cacheReadTokens: 535221, cacheWriteTokens: 876, outputTokens: 320, model: 'claude-opus-5-5',
    });
  });

  it('sizes the context by what a /compact left, not by the conversation it replaced', () => {
    writeLog([
      userPrompt('u1', 'hi'),
      assistant('a1', bigContext),
      boundary({ trigger: 'manual', preTokens: 536419, postTokens: 13687 }),
      ...compactTail(),
    ]);
    expect(readLastUsageFromJsonl(CWD, SESSION)).toMatchObject({
      inputTokens: 13687, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, model: 'claude-opus-5-5',
    });
  });

  it('goes back to the replies once one follows the compaction', () => {
    const after = { input_tokens: 2, cache_read_input_tokens: 27144, cache_creation_input_tokens: 25038, output_tokens: 273 };
    writeLog([
      userPrompt('u1', 'hi'),
      assistant('a1', bigContext),
      boundary({ trigger: 'auto', preTokens: 536419, postTokens: 13687 }),
      ...compactTail(),
      userPrompt('u2', 'carry on'),
      assistant('a2', after),
    ]);
    expect(readLastUsageFromJsonl(CWD, SESSION)).toMatchObject({
      inputTokens: 2, cacheReadTokens: 27144, cacheWriteTokens: 25038, outputTokens: 273,
    });
  });

  it('reads the older snake_case boundary', () => {
    writeLog([
      assistant('a1', bigContext),
      { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 536419, post_tokens: 9000 } },
    ]);
    expect(readLastUsageFromJsonl(CWD, SESSION)?.inputTokens).toBe(9000);
  });

  it('keeps the last reply\'s usage when the boundary does not say what was left', () => {
    writeLog([
      assistant('a1', bigContext),
      boundary({ trigger: 'manual', preTokens: 536419 }),
      ...compactTail(),
    ]);
    expect(readLastUsageFromJsonl(CWD, SESSION)).toMatchObject({ inputTokens: 2, cacheReadTokens: 535221 });
  });
});

describe('readLastCompactionFromJsonl', () => {
  it('returns undefined when the log has no compaction', () => {
    writeLog([userPrompt('u1', 'hi'), assistant('a1', bigContext)]);
    expect(readLastCompactionFromJsonl(CWD, SESSION)).toBeUndefined();
  });

  it('returns the newest boundary', () => {
    writeLog([
      boundary({ trigger: 'auto', preTokens: 300000, postTokens: 12000 }),
      assistant('a1', bigContext),
      boundary({ trigger: 'manual', preTokens: 536419, postTokens: 13687 }),
    ]);
    expect(readLastCompactionFromJsonl(CWD, SESSION)).toEqual({
      trigger: 'manual', preTokens: 536419, postTokens: 13687, timestampMs: Date.parse('2026-10-26T10:05:00.000Z'),
    });
  });
});
