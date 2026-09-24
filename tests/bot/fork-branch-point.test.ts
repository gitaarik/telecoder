/**
 * A loaded fork's confirmation carries a 🍴 Fork button of its own, so the
 * same point can be forked again without scrolling back to the message the
 * fork was first taken from.
 *
 * What makes that button worth having is that it forks the branch point: the
 * transcript exactly as it was loaded, whatever the conversation has added
 * since. These tests drive the real handlers, stores and session manager, with
 * home redirected to a scratch dir, and check what a second fork carries.
 */

import { describe, it, expect, vi, afterAll } from 'vitest';
import type { Context } from 'grammy';
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

const { handleForkCallback, handleAcceptCommand } = await import('../../src/bot/handlers/fork.handler.js');
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
      expect.stringContaining('Fork loaded from Research bot'),
      FORK_BUTTON,
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
    expect(branch.editMessageText).toHaveBeenCalledWith(expect.stringContaining('Branched'), FORK_BUTTON);
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

    expect(command.reply).toHaveBeenCalledWith(expect.stringContaining('Fork loaded'), FORK_BUTTON);
    expect(messageOffsets.lookup(String(chatId), 71)).toMatchObject({
      claudeSessionId: loadedSessionId(chatId),
      lineCount: 3,
    });
  });
});

describe('the offer a fork arrives with', () => {
  it('previews the reply the fork was taken from, not the latest one', async () => {
    const chatId = 104;
    const key = String(chatId);

    // Two turns in, with the chat's stored preview on the second reply — and
    // the fork taken from the first.
    const sourceFile = sessionJsonlPath(PROJECT, 'source-104');
    fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
    fs.writeFileSync(
      sourceFile,
      BRANCH_POINT + jsonl(record('u2', 'user', 'Now add tests'), record('a3', 'assistant', 'Added the tests.')),
    );
    sessionManager.setWorkingDirectory(key, PROJECT);
    sessionManager.updateLastAssistantMessage(key, 'Added the tests.');
    messageOffsets.record(key, 40, { claudeSessionId: 'source-104', projectPath: PROJECT, lineCount: 3 });

    await handleForkCallback(asCtx(tap(chatId, 4, 'fork:confirm:b2:40', 41)));

    const preview = getPendingFork('b2', 4)?.assistantPreview;
    expect(preview).toContain('Done — tokenizer and parser are separate now.');
    expect(preview).not.toContain('Added the tests.');
  });
});
