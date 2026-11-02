/**
 * A turn ends in one message: the usage footer sits at the bottom of the status
 * line, instead of following it as a second message with the same figures.
 * /statusline and /verbosity set the two apart, so either can still show alone.
 *
 * Drives the real sendStatusLine, with the chat's preferences kept under a
 * scratch home, so nothing here touches the real ~/.claudegram.
 */

import { describe, it, expect, vi, afterAll } from 'vitest';
import type { Context } from 'grammy';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentUsage } from '../../src/providers/types.js';
import type { VerbosityLevel } from '../../src/utils/verbosity.js';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const mocked = { ...actual, homedir: () => process.env.TELECODER_TEST_HOME ?? actual.homedir() };
  return { ...mocked, default: mocked };
});

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-status-footer-'));
process.env.TELECODER_TEST_HOME = home;

const { sendStatusLine } = await import('../../src/bot/handlers/command/settings.js');
const { userPreferences } = await import('../../src/providers/user-preferences.js');

afterAll(() => {
  delete process.env.TELECODER_TEST_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

const USAGE: AgentUsage = {
  inputTokens: 500,
  outputTokens: 1_000,
  cacheReadTokens: 119_000,
  cacheWriteTokens: 0,
  totalCostUsd: 0.1234,
  sessionCostUsd: 0,
  sessionCostTurns: 0,
  contextWindow: 1_000_000,
  numTurns: 3,
  model: 'claude-opus-5-5',
};

const FOOTER = '🟢 [█░░░░░░░░░] 12% context · 120.5k/1.0M · $0.1234 · 3 turns';
const ESCAPED_FOOTER = '🟢 \\[█░░░░░░░░░\\] 12% context · 120\\.5k/1\\.0M · $0\\.1234 · 3 turns';

let nextChat = 7000;

/** What a turn closes with, in a chat with these settings. */
async function closingMessages(
  statusLine: boolean,
  verbosity: VerbosityLevel,
  usage: AgentUsage | null = USAGE,
): Promise<[string, { parse_mode?: string } | undefined][]> {
  const chat = nextChat++;
  userPreferences.setShowStatusLine(chat, statusLine);
  userPreferences.setVerbosity(chat, verbosity);
  const reply = vi.fn(async (_text: string, _opts?: { parse_mode?: string }) => ({}));
  await sendStatusLine({ reply } as unknown as Context, chat, String(chat), usage ?? undefined, 'a prompt');
  return reply.mock.calls;
}

describe('the message that closes a turn', () => {
  it('with both on, is one message with the footer at its bottom', async () => {
    const sent = await closingMessages(true, 'verbose');
    expect(sent).toHaveLength(1);
    const [text, options] = sent[0]!;
    expect(text.split('\n').at(-1)).toBe(ESCAPED_FOOTER);
    expect(options?.parse_mode).toBe('MarkdownV2');
  });

  it('with both on, leaves the context and the cost to the footer', async () => {
    const [[text]] = await closingMessages(true, 'verbose');
    expect(text).toContain('🤖 opus\\-5\\-5');
    expect(text).not.toContain('📊');
    expect(text).not.toContain('💰');
  });

  it('with only the status line on, gives the context and the cost itself', async () => {
    const sent = await closingMessages(true, 'normal');
    expect(sent).toHaveLength(1);
    const [text] = sent[0]!;
    expect(text).toContain('📊 12%');
    expect(text).toContain('💰 $0\\.12');
    expect(text).not.toContain('% context');
  });

  it('with only the footer on, is the footer alone, as plain text', async () => {
    const sent = await closingMessages(false, 'verbose');
    expect(sent).toHaveLength(1);
    const [text, options] = sent[0]!;
    expect(text).toBe(FOOTER);
    expect(options?.parse_mode).toBeUndefined();
  });

  it('with both off, is nothing', async () => {
    expect(await closingMessages(false, 'normal')).toHaveLength(0);
  });

  it('with no figure yet, has no footer to show', async () => {
    const sent = await closingMessages(true, 'verbose', null);
    expect(sent).toHaveLength(1);
    expect(sent[0]![0]).not.toContain('% context');
    expect(await closingMessages(false, 'verbose', null)).toHaveLength(0);
  });
});
