/**
 * The status line lists the last few prompts, not only the latest: a turn
 * that starts from an "ok" or a "yeah" says nothing on its own.
 *
 * Drives the real sendStatusLine against transcripts written under a scratch
 * home, with the chat's preferences kept there too, so nothing here touches
 * the real ~/.claude or ~/.claudegram.
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

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-status-line-'));
process.env.TELECODER_TEST_HOME = home;
const PROJECT = path.join(home, 'project');
fs.mkdirSync(PROJECT);

const { formatRecentPrompts, sendStatusLine } = await import('../../src/bot/handlers/command/settings.js');
const { userPreferences } = await import('../../src/providers/user-preferences.js');
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

/** Start a session in `key` whose Claude session is `sessionId`, with `lines` as its transcript if given. */
function converse(key: string, sessionId: string, lines?: string[]): void {
  if (lines) {
    const file = sessionJsonlPath(PROJECT, sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.join('\n') + '\n');
  }
  sessionManager.createSession(key, PROJECT);
  sessionManager.setClaudeSessionId(key, sessionId);
}

/** The prompt lines of the status line sendStatusLine posts after a turn. */
async function promptLines(chatId: number, key: string, lastPrompt: string): Promise<string[]> {
  const reply = vi.fn(async (_text: string, _opts?: unknown) => ({}));
  await sendStatusLine({ reply } as unknown as Context, chatId, key, undefined, lastPrompt);
  expect(reply).toHaveBeenCalledTimes(1);
  return reply.mock.calls[0]![0].split('\n').filter((line) => line.startsWith('_▸ '));
}

describe('formatRecentPrompts', () => {
  it('lists the last five prompts, oldest first, a line each', () => {
    expect(formatRecentPrompts(['one', 'two', 'three', 'four', 'five', 'six']).split('\n')).toEqual([
      '_▸ two_',
      '_▸ three_',
      '_▸ four_',
      '_▸ five_',
      '_▸ six_',
    ]);
  });

  it('gives a line only to prompts that were turns', () => {
    const prompts = [
      'Plan the parser',
      'Split it',
      '/compact',
      '<command-name>/compact</command-name>\n<command-message>compact</command-message>',
      '<local-command-stdout>Compacted</local-command-stdout>',
      'Now add tests',
      '[Request interrupted by user]',
      'ok',
      'yeah',
    ];
    expect(formatRecentPrompts(prompts).split('\n')).toEqual([
      '_▸ Plan the parser_',
      '_▸ Split it_',
      '_▸ Now add tests_',
      '_▸ ok_',
      '_▸ yeah_',
    ]);
  });

  it('shows a paste or an upload the way /tree labels it', () => {
    expect(formatRecentPrompts([
      '<pasted_content id="a43f">Build log:\nall green</pasted_content id="a43f">',
      'User uploaded an image to the project.\nSaved at: /x.png\nCaption: "this one"',
    ]).split('\n')).toEqual([
      '_▸ Build log: all green_',
      '_▸ 📷 Image — this one_',
    ]);
  });

  it('cuts a long prompt to 100 characters', () => {
    expect(formatRecentPrompts(['word '.repeat(60)])).toBe(`_▸ ${'word '.repeat(19)}word…_`);
  });

  it('cuts by character, so an emoji at the cut stays whole', () => {
    expect(formatRecentPrompts([`${'a'.repeat(98)}😀 and more`])).toBe(`_▸ ${'a'.repeat(98)}😀…_`);
  });

  it('escapes MarkdownV2 so a prompt full of punctuation still sends', () => {
    expect(formatRecentPrompts(['fix src/a_b.ts (the *bold* one!)']))
      .toBe('_▸ fix src/a\\_b\\.ts \\(the \\*bold\\* one\\!\\)_');
  });

  it('is empty when nothing was a turn', () => {
    expect(formatRecentPrompts(['/compact'])).toBe('');
  });
});

describe('the prompts on the status line', () => {
  const chatId = 101;
  userPreferences.setShowStatusLine(chatId, true);
  userPreferences.setShowPromptInStatusLine(chatId, true);

  it('come from the session log, so they reach back past this turn', async () => {
    converse('101:1', 'talk', [
      rec('user', 'Plan the parser'), rec('assistant', 'Two stages.'),
      rec('user', 'Split it'), rec('assistant', 'Split.'),
      // A /compact leaves three user records and no reply between them and
      // the next prompt, which still gets a line of its own.
      rec('user', '/compact'),
      rec('user', '<command-name>/compact</command-name>'),
      rec('user', '<local-command-stdout>Compacted</local-command-stdout>'),
      rec('user', 'Now add tests'), rec('assistant', 'Added.'),
      rec('user', 'Do they pass?'), rec('assistant', 'Yes.'),
      rec('user', 'ok'), rec('assistant', 'Merged.'),
      rec('user', 'yeah'), rec('assistant', 'Pushed.'),
    ]);
    expect(await promptLines(chatId, '101:1', 'yeah')).toEqual([
      '_▸ Split it_',
      '_▸ Now add tests_',
      '_▸ Do they pass?_',
      '_▸ ok_',
      '_▸ yeah_',
    ]);
  });

  it("fall back to the turn's own prompt when the log isn't there", async () => {
    converse('101:2', 'never-written');
    expect(await promptLines(chatId, '101:2', 'first thing I asked')).toEqual(['_▸ first thing I asked_']);
  });

  it('stay off when the chat turned them off', async () => {
    const quiet = 102;
    userPreferences.setShowStatusLine(quiet, true);
    userPreferences.setShowPromptInStatusLine(quiet, false);
    converse('102:1', 'talk');
    expect(await promptLines(quiet, '102:1', 'yeah')).toEqual([]);
  });
});
