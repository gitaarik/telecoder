/**
 * The short status line a scheduled fire ends with: the stats and the usage
 * footer, without the topic, the prompts or the resume command.
 *
 * A schedule can fire every minute. The whole block under each fire would
 * outweigh the short result it closes, and every fire is logged as a prompt,
 * so the list would soon hold nothing but the schedule's own.
 *
 * Drives the real sendStatusLine against a transcript written under a scratch
 * home, with the chat's preferences kept there too, so nothing here touches
 * the real ~/.claude or ~/.claudegram.
 */

import { describe, it, expect, vi, afterAll } from 'vitest';
import type { Context } from 'grammy';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentUsage } from '../../src/providers/types.js';
import type { VerbosityLevel } from '../../src/utils/verbosity.js';
import type { MessageEntity } from 'grammy/types';
import { marked } from '../helpers/entity-marks.js';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const mocked = { ...actual, homedir: () => process.env.TELECODER_TEST_HOME ?? actual.homedir() };
  return { ...mocked, default: mocked };
});

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-status-brief-'));
process.env.TELECODER_TEST_HOME = home;
const PROJECT = path.join(home, 'shop');
fs.mkdirSync(PROJECT);

const { sendStatusLine } = await import('../../src/bot/handlers/command/settings.js');
const { userPreferences } = await import('../../src/providers/user-preferences.js');
const { sessionManager } = await import('../../src/claude/session-manager.js');
const { sessionJsonlPath } = await import('../../src/claude/session-jsonl.js');
const { setSessionTopic } = await import('../../src/bot/handlers/command/topic-store.js');

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

const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
let nextChat = 9000;

/**
 * A chat with everything the status line can show turned on, in a session that
 * has a topic, a resume command and a schedule's prompts in its log.
 */
function chat(statusLine: boolean, verbosity: VerbosityLevel): { chatId: number; key: string } {
  const chatId = nextChat++;
  const key = String(chatId);
  userPreferences.setShowStatusLine(chatId, statusLine);
  userPreferences.setShowTopicInStatusLine(chatId, true);
  userPreferences.setShowPromptInStatusLine(chatId, true);
  userPreferences.setShowSessionInStatusLine(chatId, true);
  userPreferences.setVerbosity(chatId, verbosity);

  const file = sessionJsonlPath(PROJECT, SESSION_ID);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, ['check the deploy', 'check the deploy', 'check the deploy']
    .map((text, i) => JSON.stringify({ type: 'user', uuid: `p${i}`, message: { role: 'user', content: [{ type: 'text', text }] } }))
    .join('\n') + '\n');
  sessionManager.createSession(key, PROJECT);
  sessionManager.setClaudeSessionId(key, SESSION_ID);
  setSessionTopic(key, 'Deploy watch');
  return { chatId, key };
}

type SendOptions = { parse_mode?: string; entities?: MessageEntity[] };

/**
 * What a turn closes with in that chat: each message, its formatting marked
 * as `_x_` and so on, and how it was sent.
 */
async function closing(
  statusLine: boolean,
  verbosity: VerbosityLevel,
  brief: boolean,
): Promise<[text: string, opts?: SendOptions][]> {
  const { chatId, key } = chat(statusLine, verbosity);
  const reply = vi.fn(async (_text: string, _opts?: SendOptions) => ({}));
  await sendStatusLine({ reply } as unknown as Context, chatId, key, USAGE, 'check the deploy', { brief });
  return reply.mock.calls.map(([text, opts]) => [marked(text, opts?.entities), opts]);
}

describe('the short status line', () => {
  it('is the stats and the usage footer, and nothing above them', async () => {
    const sent = await closing(true, 'verbose', true);
    expect(sent).toHaveLength(1);
    const [text, options] = sent[0]!;
    expect(text.split('\n')).toEqual([
      '_📁 shop · 🧠 Auto · 🤖 opus-5-5_',
      FOOTER,
    ]);
    expect(options?.parse_mode).toBeUndefined();
  });

  it('is the stats alone in a chat that shows no footer, with the context and the cost on them', async () => {
    const [[text]] = await closing(true, 'normal', true);
    expect(text).toBe('_📁 shop · 🧠 Auto · 🤖 opus-5-5 · 📊 12% · 💰 $0.12_');
  });

  it('leaves out what the whole one shows in the same chat', async () => {
    const [[text]] = await closing(true, 'verbose', false);
    expect(text.split('\n')).toEqual([
      '_💬 Deploy watch_',
      '',
      '_▸ check the deploy_',
      '_▸ check the deploy_',
      '_▸ check the deploy_',
      '',
      `🔗 \`claude --resume ${SESSION_ID}\``,
      '_📁 shop · 🧠 Auto · 🤖 opus-5-5_',
      FOOTER,
    ]);
  });

  it('is the footer alone with the status line off, as it is for any turn', async () => {
    const sent = await closing(false, 'verbose', true);
    expect(sent).toHaveLength(1);
    expect(sent[0]![0]).toBe(FOOTER);
    expect(sent[0]![1]?.parse_mode).toBeUndefined();
  });

  it('is nothing with both off', async () => {
    expect(await closing(false, 'normal', true)).toHaveLength(0);
  });
});
