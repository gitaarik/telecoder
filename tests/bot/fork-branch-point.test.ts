/**
 * A fork's confirmations carry a 🍴 Fork button of their own — in the chat
 * that received the fork and in the one it was sent from — so the same point
 * can be forked again without scrolling back to the message it was taken from.
 *
 * What makes those buttons worth having is that they fork the fork point: the
 * transcript exactly as it was cut, whatever either conversation has added
 * since. These tests drive the real handlers, stores and session manager, with
 * home redirected to a scratch dir, and check what a second fork carries.
 */

import { describe, it, expect, vi, afterAll } from 'vitest';
import type { Context } from 'grammy';
import type { PendingFork } from '../../src/claude/pending-forks.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Transcripts and the bot's state files both resolve under os.homedir(); point
// it at a scratch dir so nothing here touches the real ~/.claude or
// ~/.claudegram. Read at call time, so the env var set below — before any
// module under test is imported — is what the stores pick up.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const mocked = { ...actual, homedir: () => process.env.TELECODER_TEST_HOME ?? actual.homedir() };
  return { ...mocked, default: mocked };
});

vi.mock('../../src/utils/instances.js', () => ({
  listSiblingBots: () => [],
  findBotById: (botId: string) => ({ botId, name: botId === 'b2' ? 'Research bot' : 'TeleCoder' }),
}));

// There is no live process to tear down, and no Telegram to rename the bot on.
vi.mock('../../src/providers/provider-router.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/providers/provider-router.js')>()),
  clearConversation: vi.fn(),
}));
vi.mock('../../src/bot/handlers/command.handler.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/bot/handlers/command.handler.js')>()),
  restoreTopicAndRefreshBotName: vi.fn(async () => {}),
  getSessionTopic: vi.fn(() => undefined),
}));

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-fork-'));
process.env.TELECODER_TEST_HOME = home;
const PROJECT = path.join(home, 'project');
fs.mkdirSync(PROJECT);

const { handleForkCallback, handleAcceptCommand, buildForkMarker } = await import('../../src/bot/handlers/fork.handler.js');
const { putPendingFork, getPendingFork } = await import('../../src/claude/pending-forks.js');
const { messageOffsets } = await import('../../src/claude/message-offsets.js');
const { sessionManager } = await import('../../src/claude/session-manager.js');
const { sessionJsonlPath } = await import('../../src/claude/session-jsonl.js');
const { BOT_ID } = await import('../../src/config.js');

afterAll(() => {
  delete process.env.TELECODER_TEST_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

const FORK_BUTTON = { reply_markup: { inline_keyboard: [[{ text: '🍴 Fork', callback_data: 'fork:pick' }]] } };
/** How a loaded fork's marker goes out: formatted, with the button under it. */
const MARKER_OPTIONS = { parse_mode: 'MarkdownV2', ...FORK_BUTTON };

const record = (uuid: string, type: 'user' | 'assistant', text: string) => JSON.stringify({
  type,
  uuid,
  sessionId: 'source-session',
  message: { role: type, content: [{ type: 'text', text }] },
});
const jsonl = (...lines: string[]) => lines.join('\n') + '\n';

/** The three records every fork below starts from. */
const BRANCH_POINT = jsonl(
  record('u1', 'user', 'Split the parser in two'),
  record('a1', 'assistant', 'Looking at the parser first.'),
  record('a2', 'assistant', 'Done — tokenizer and parser are separate now.'),
);

/**
 * A source chat two turns in, with the Fork button on its first reply
 * (`messageId`) recorded at the end of that turn. Returns the transcript file.
 */
function sourceChat(chatId: number, messageId: number): string {
  const sessionId = `source-${chatId}`;
  const file = sessionJsonlPath(PROJECT, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    BRANCH_POINT + jsonl(record('u2', 'user', 'Now add tests'), record('a3', 'assistant', 'Added the tests.')),
  );
  messageOffsets.record(String(chatId), messageId, { claudeSessionId: sessionId, projectPath: PROJECT, lineCount: 3 });
  return file;
}

function sendFork(userId: number): void {
  putPendingFork(BOT_ID, userId, {
    fromBotName: 'Research bot',
    fromBotId: 'b2',
    projectPath: PROJECT,
    jsonl: BRANCH_POINT,
    createdAt: new Date().toISOString(),
  });
}

/** A tap on an inline button under `messageId`. */
function tap(chatId: number, userId: number, data: string, messageId: number) {
  return {
    chat: { id: chatId },
    from: { id: userId },
    callbackQuery: { data, message: { message_id: messageId } },
    answerCallbackQuery: vi.fn(async () => true),
    editMessageText: vi.fn(async () => true),
  };
}

const asCtx = (fake: object) => fake as unknown as Context;
const loadedSessionId = (chatId: number) => sessionManager.getSession(String(chatId))!.claudeSessionId!;
const uuidsIn = (file: string) => fs.readFileSync(file, 'utf-8')
  .split('\n')
  .filter(Boolean)
  .map((line) => (JSON.parse(line) as { uuid: string }).uuid);

describe('the confirmation of a loaded fork', () => {
  it('carries a Fork button anchored at the branch point', async () => {
    const chatId = 101;
    sendFork(1);

    const accept = tap(chatId, 1, 'fork:accept', 55);
    await handleForkCallback(asCtx(accept));

    expect(accept.editMessageText).toHaveBeenCalledWith(
      expect.stringContaining('Forked from Research bot'),
      MARKER_OPTIONS,
    );
    expect(messageOffsets.lookup(String(chatId), 55)).toMatchObject({
      claudeSessionId: loadedSessionId(chatId),
      projectPath: PROJECT,
      lineCount: 3,
    });
  });

  it('forks the transcript as loaded, not what the conversation added since', async () => {
    const chatId = 102;
    sendFork(2);
    await handleForkCallback(asCtx(tap(chatId, 2, 'fork:accept', 55)));
    const loaded = loadedSessionId(chatId);

    // The conversation carries on in the bot that received the fork.
    fs.appendFileSync(
      sessionJsonlPath(PROJECT, loaded),
      jsonl(record('u2', 'user', 'Now add tests'), record('a3', 'assistant', 'Added.')),
    );

    // Fork from the loaded message, into a new branch on this same bot.
    const branch = tap(chatId, 2, `fork:confirm:${BOT_ID}:55`, 60);
    await handleForkCallback(asCtx(branch));

    const branched = loadedSessionId(chatId);
    expect(branched).not.toBe(loaded);
    expect(uuidsIn(sessionJsonlPath(PROJECT, branched))).toEqual(['u1', 'a1', 'a2']);

    // A branch taken here is anchored the same way, so it can be forked on.
    expect(branch.editMessageText).toHaveBeenCalledWith(expect.stringContaining('New branch'), MARKER_OPTIONS);
    expect(messageOffsets.lookup(String(chatId), 60)).toMatchObject({
      claudeSessionId: branched,
      lineCount: 3,
    });
  });

  it('anchors the button on the reply when the fork is accepted with /accept', async () => {
    const chatId = 103;
    sendFork(3);

    const command = {
      chat: { id: chatId },
      from: { id: 3 },
      message: { message_id: 70, text: '/accept' },
      reply: vi.fn(async () => ({ message_id: 71 })),
    };
    await handleAcceptCommand(asCtx(command));

    expect(command.reply).toHaveBeenCalledWith(expect.stringContaining('Forked from Research bot'), MARKER_OPTIONS);
    expect(messageOffsets.lookup(String(chatId), 71)).toMatchObject({
      claudeSessionId: loadedSessionId(chatId),
      lineCount: 3,
    });
  });

  it('still lands, in plain text, when Telegram rejects the formatting', async () => {
    const chatId = 106;
    sendFork(6);

    const accept = tap(chatId, 6, 'fork:accept', 55);
    accept.editMessageText.mockRejectedValueOnce(new Error("Bad Request: can't parse entities"));
    await handleForkCallback(asCtx(accept));

    // Left as it was, the offer would go on showing Accept and Decline.
    expect(accept.editMessageText).toHaveBeenLastCalledWith(
      expect.stringContaining('Forked from Research bot'),
      FORK_BUTTON,
    );
    const plain = accept.editMessageText.mock.lastCall?.[0] as string;
    expect(plain).not.toMatch(/\\|\*\*>|\|\||^>/m);
    expect(plain).toContain('You: Split the parser in two');
    expect(plain).toContain('Done — tokenizer and parser are separate now.');
    expect(messageOffsets.lookup(String(chatId), 55)).toMatchObject({ lineCount: 3 });
  });
});

describe('buildForkMarker', () => {
  const fork = (overrides: Partial<PendingFork> = {}): PendingFork => ({
    fromBotName: 'Research bot',
    fromBotId: 'b2',
    projectPath: '/home/someone/dev/telecoder',
    jsonl: BRANCH_POINT,
    topic: 'Split the parser',
    createdAt: '2026-09-24T20:00:00.000Z',
    ...overrides,
  });
  /** A fork whose transcript is one exchange: `prompt`, answered by `reply`. */
  const forkOf = (prompt: string, reply: string) =>
    fork({ jsonl: jsonl(record('u1', 'user', prompt), record('a1', 'assistant', reply)) });
  /** The collapsed quote's lines, from its opening `**>` to its closing `||`. */
  const quoteIn = (marker: string) => {
    const lines = marker.split('\n');
    const start = lines.findIndex((line) => line.startsWith('**>'));
    if (start === -1) return undefined;
    return lines.slice(start, lines.findIndex((line, i) => i >= start && line.endsWith('||')) + 1);
  };

  it('reads as a break between two conversations', () => {
    expect(buildForkMarker(fork())).toBe([
      '━━━━━━━━━━━━━━━━',
      '*🍴 Forked from Research bot*',
      '━━━━━━━━━━━━━━━━',
      'telecoder · Split the parser',
      '',
      'A new conversation starts here\\. It picks up after:',
      '*You:* Split the parser in two',
      '**>Looking at the parser first\\.',
      '>',
      '>Done — tokenizer and parser are separate now\\.||',
      '',
      "_What's above is this bot's previous conversation — it's in /resume\\._",
    ].join('\n'));
  });

  it('calls a branch taken in this chat a branch', () => {
    const marker = buildForkMarker(fork({ fromBotId: BOT_ID, fromBotName: 'TeleCoder' }));
    expect(marker).toContain('*🌱 New branch*');
    expect(marker).toContain('the conversation you branched from');
  });

  it('still says a new conversation starts when there is no exchange to show', () => {
    const marker = buildForkMarker(fork({ jsonl: jsonl(record('u1', 'user', 'Still thinking?')) }));
    expect(marker).toContain('A new conversation starts here\\.');
    expect(marker).not.toContain('You:');
    expect(quoteIn(marker)).toBeUndefined();
  });

  it('collapses the whole reply, without its markdown', () => {
    const reply = '## Status\n\n**Done** — `parser.ts` is split:\n\n```ts\nexport const x = 1;\n```\n\nNext: tests.';
    expect(quoteIn(buildForkMarker(forkOf('Where are we?', reply)))).toEqual([
      '**>Status',
      '>',
      '>Done — parser\\.ts is split:',
      '>',
      '>export const x \\= 1;',
      '>',
      '>Next: tests\\.||',
    ]);
  });

  it('cuts a reply too long for one message, and says where the rest is', () => {
    const marker = buildForkMarker(forkOf('Long one?', 'All good here. '.repeat(400)));
    expect(quoteIn(marker)!.at(-1)!.endsWith('here\\. …||')).toBe(true);
    expect(marker).toContain('The rest of the reply is in /recap\\.');
    // Telegram counts the text once parsed; unescaped, with markup still in,
    // is an upper bound on that.
    expect(marker.replace(/\\(.)/g, '$1').length).toBeLessThanOrEqual(4096);
  });

  it('keeps the prompt to one line', () => {
    const marker = buildForkMarker(forkOf('First line\nsecond line ' + 'word '.repeat(50), 'Ok.'));
    const you = marker.split('\n').find((line) => line.startsWith('*You:*'))!;
    expect(you.startsWith('*You:* First line second line word')).toBe(true);
    expect(you.endsWith('…')).toBe(true);
  });

  it('escapes what it shows', () => {
    const marker = buildForkMarker({ ...forkOf('Is a-b > c?', 'Use [c]!'), topic: 'v2.1 (draft)' });
    expect(marker).toContain('telecoder · v2\\.1 \\(draft\\)');
    expect(marker).toContain('*You:* Is a\\-b \\> c?');
    expect(quoteIn(marker)).toEqual(['**>Use \\[c\\]\\!||']);
  });
});

describe('the offer a fork arrives with', () => {
  it('previews the reply the fork was taken from, not the latest one', async () => {
    const chatId = 104;
    const key = String(chatId);

    // Two turns in, with the chat's stored preview on the second reply — and
    // the fork taken from the first.
    sourceChat(chatId, 40);
    sessionManager.setWorkingDirectory(key, PROJECT);
    sessionManager.updateLastAssistantMessage(key, 'Added the tests.');

    await handleForkCallback(asCtx(tap(chatId, 4, 'fork:confirm:b2:40', 41)));

    const preview = getPendingFork('b2', 4)?.assistantPreview;
    expect(preview).toContain('Done — tokenizer and parser are separate now.');
    expect(preview).not.toContain('Added the tests.');
  });
});

describe('the confirmation in the chat a fork was sent from', () => {
  it('carries a Fork button for the same point', async () => {
    const chatId = 105;
    const sourceFile = sourceChat(chatId, 40);

    const confirm = tap(chatId, 5, 'fork:confirm:b2:40', 41);
    await handleForkCallback(asCtx(confirm));
    expect(confirm.editMessageText).toHaveBeenCalledWith(
      expect.stringContaining('Forked to Research bot'),
      expect.objectContaining(FORK_BUTTON),
    );
    // Unlike the chat the fork lands in, this one is still the same conversation.
    expect(confirm.editMessageText.mock.lastCall?.[0]).toContain('This conversation carries on here unchanged');

    // The source conversation carries on, then the same point goes to a third
    // bot — from the confirmation this time, not the original message.
    fs.appendFileSync(sourceFile, jsonl(record('u3', 'user', 'Ship it'), record('a4', 'assistant', 'Shipped.')));
    await handleForkCallback(asCtx(tap(chatId, 5, 'fork:confirm:b3:41', 42)));

    expect(getPendingFork('b2', 5)?.jsonl).toBe(BRANCH_POINT);
    expect(getPendingFork('b3', 5)?.jsonl).toBe(BRANCH_POINT);
  });
});
