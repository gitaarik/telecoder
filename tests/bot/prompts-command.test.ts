/**
 * /prompts lists what you typed, a prompt a line, read off the session log.
 *
 * Drives the real handler against transcripts written under a scratch home,
 * so nothing here touches the real ~/.claude or ~/.claudegram.
 */

import { describe, it, expect, vi, afterAll } from 'vitest';
import type { Context } from 'grammy';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const mocked = { ...actual, homedir: () => process.env.TELECODER_TEST_HOME ?? actual.homedir() };
  return { ...mocked, default: mocked };
});

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-prompts-'));
process.env.TELECODER_TEST_HOME = home;
const PROJECT = path.join(home, 'project');
fs.mkdirSync(PROJECT);

const { handlePrompts } = await import('../../src/bot/handlers/command/session.js');
const { sessionManager } = await import('../../src/claude/session-manager.js');
const { sessionJsonlPath } = await import('../../src/claude/session-jsonl.js');

afterAll(() => {
  delete process.env.TELECODER_TEST_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

let uuid = 0;
/** A transcript record, the way Claude Code writes one. */
const rec = (type: 'user' | 'assistant', text: string) => JSON.stringify({
  type,
  uuid: `r${uuid++}`,
  sessionId: 'whichever',
  message: { role: type, content: [{ type: 'text', text }] },
});

/** What a /compact leaves in the transcript: three user records and no reply. */
const COMPACT = [
  rec('user', '/compact'),
  rec('user', '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>'),
  rec('user', '<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>'),
];

let chatId = 200;
/** Send `command` in a chat whose session has `lines` as its transcript; the listed prompts come back. */
async function listed(lines: string[], command = '/prompts'): Promise<string[]> {
  const chat = chatId++;
  const sessionId = `talk-${chat}`;
  const file = sessionJsonlPath(PROJECT, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n');
  sessionManager.createSession(String(chat), PROJECT);
  sessionManager.setClaudeSessionId(String(chat), sessionId);

  const reply = vi.fn(async (_text: string, _opts?: unknown) => ({}));
  await handlePrompts({ chat: { id: chat }, message: { text: command }, reply } as unknown as Context);
  expect(reply).toHaveBeenCalledTimes(1);
  return reply.mock.calls[0]![0].split('\n').filter((line) => line.startsWith('• '));
}

describe('/prompts', () => {
  it('gives the prompt after a /compact a line of its own', async () => {
    expect(await listed([
      rec('user', 'Plan the parser'), rec('assistant', 'Two stages.'),
      ...COMPACT,
      rec('user', 'Now add tests'), rec('assistant', 'Added.'),
    ])).toEqual([
      '• _earlier_ — Plan the parser',
      '• _earlier_ — Now add tests',
    ]);
  });

  it('counts only prompts toward N', async () => {
    expect(await listed([
      rec('user', 'one'), rec('assistant', 'r1'),
      rec('user', 'two'), rec('assistant', 'r2'),
      ...COMPACT,
      rec('user', 'three'), rec('assistant', 'r3'),
      ...COMPACT,
    ], '/prompts 2')).toEqual([
      '• _earlier_ — two',
      '• _earlier_ — three',
    ]);
  });

  it('marks a prompt that was interrupted, and leaves out the note', async () => {
    expect(await listed([
      rec('user', 'do it this way'),
      rec('user', '[Request interrupted by user]'),
      rec('user', 'no, the other way'), rec('assistant', 'Done.'),
    ])).toEqual([
      '• _earlier_ ⏳ — do it this way',
      '• _earlier_ — no, the other way',
    ]);
  });

  it('shows a paste without the tags it was wrapped in', async () => {
    expect(await listed([
      rec('user', '<pasted_content id="a43f">\nBuild log:\nall green\n</pasted_content id="a43f">'),
      rec('assistant', 'Good.'),
    ])).toEqual([
      '• _earlier_ — Build log: all green',
    ]);
  });
});
