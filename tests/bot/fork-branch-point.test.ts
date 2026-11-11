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
import { GrammyError, type Context } from 'grammy';
import type { MessageEntity } from 'grammy/types';
import type { EntityMessage } from '../../src/telegram/entities.js';
import { marked } from '../helpers/entity-marks.js';
import type { PendingFork } from '../../src/claude/pending-forks.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Transcripts and the bot's state files both resolve under os.homedir(); point
// it at a scratch dir so nothing here touches the real ~/.claude or
// ~/.telecoder. Read at call time, so the env var set below — before any
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

const { handleForkCallback, handleAcceptCommand, handleForkCommand, buildForkMarker, replyQuote } = await import('../../src/bot/handlers/fork.handler.js');
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
/** A loaded fork's marker: 🍴 to fork that point again, 🌳 for the tree it is part of. */
const MARKER_BUTTONS = {
  reply_markup: {
    inline_keyboard: [[
      { text: '🍴 Fork', callback_data: 'fork:pick' },
      { text: '🌳 Tree', callback_data: 'tree:show' },
    ]],
  },
};
/** How a loaded fork's marker goes out: formatted, with its buttons under it. */
const MARKER_OPTIONS = { entities: expect.any(Array), ...MARKER_BUTTONS };

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
  // An edit of the tapped message, as the bot makes it through ctx.api,
  // recorded as (text, options) like ctx.editMessageText takes them.
  const editMessageText = vi.fn(async (_text: string, _options: object) => true);
  return {
    chat: { id: chatId },
    from: { id: userId },
    callbackQuery: { data, message: { message_id: messageId, chat: { id: chatId } } },
    answerCallbackQuery: vi.fn(async () => true),
    editMessageText,
    api: {
      editMessageText: (_chat: number, _id: number, text: string, options: object) => editMessageText(text, options),
    },
  };
}

/** A text_link to `url` among a sent message's options. */
const linkTo = (url: string) => expect.objectContaining({
  entities: expect.arrayContaining([expect.objectContaining({ type: 'text_link', url })]),
});

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
    accept.editMessageText.mockRejectedValueOnce(new GrammyError(
      "Call to 'editMessageText' failed!",
      { ok: false, error_code: 400, description: "Bad Request: can't parse entities" },
      'editMessageText',
      {},
    ));
    await handleForkCallback(asCtx(accept));

    // Left as it was, the offer would go on showing Accept and Decline.
    expect(accept.editMessageText).toHaveBeenLastCalledWith(
      expect.stringContaining('Forked from Research bot'),
      { ...MARKER_BUTTONS, entities: [] },
    );
    const plain = accept.editMessageText.mock.lastCall?.[0] as string;
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
  /** The collapsed quote's lines, or undefined when there is none. */
  const quoteIn = (marker: EntityMessage) => {
    const quote = marker.entities.find((e) => e.type === 'expandable_blockquote');
    return quote && marker.text.slice(quote.offset, quote.offset + quote.length).split('\n');
  };
  /** The marker as it reads, its bold and italic marked. */
  const shown = (marker: EntityMessage) => marked(marker.text, marker.entities);

  it('reads as a break between two conversations', () => {
    const marker = buildForkMarker(fork());
    expect(shown(marker)).toBe([
      '━━━━━━━━━━━━━━━━',
      '*🍴 Forked from Research bot*',
      '━━━━━━━━━━━━━━━━',
      'telecoder · Split the parser',
      '',
      'A new conversation starts here. It picks up after:',
      '*You:* Split the parser in two',
      'Looking at the parser first.',
      '',
      'Done — tokenizer and parser are separate now.',
      '',
      "_What's above is this bot's previous conversation — it's in /resume._",
    ].join('\n'));
    expect(quoteIn(marker)).toEqual([
      'Looking at the parser first.',
      '',
      'Done — tokenizer and parser are separate now.',
    ]);
  });

  it('calls a branch taken in this chat a branch', () => {
    const marker = shown(buildForkMarker(fork({ fromBotId: BOT_ID, fromBotName: 'TeleCoder' })));
    expect(marker).toContain('*🌱 New branch*');
    expect(marker).toContain('the conversation you branched from');
  });

  it('still says a new conversation starts when there is no exchange to show', () => {
    const marker = buildForkMarker(fork({ jsonl: jsonl(record('u1', 'user', 'Still thinking?')) }));
    expect(marker.text).toContain('A new conversation starts here.');
    expect(marker.text).not.toContain('You:');
    expect(quoteIn(marker)).toBeUndefined();
  });

  it('collapses the whole reply, without its markdown', () => {
    const reply = '## Status\n\n**Done** — `parser.ts` is split:\n\n```ts\nexport const x = 1;\n```\n\nNext: tests.';
    expect(quoteIn(buildForkMarker(forkOf('Where are we?', reply)))).toEqual([
      'Status',
      '',
      'Done — parser.ts is split:',
      '',
      'export const x = 1;',
      '',
      'Next: tests.',
    ]);
  });

  it('cuts a reply too long for one message, and says where the rest is', () => {
    const marker = buildForkMarker(forkOf('Long one?', 'All good here. '.repeat(400)));
    expect(quoteIn(marker)!.at(-1)!.endsWith('here. …')).toBe(true);
    expect(marker.text).toContain('The rest of the reply is in /recap.');
    expect(marker.text.length).toBeLessThanOrEqual(4096);
  });

  /** The banner's line for the prompt it picks up after. */
  const youIn = (marker: EntityMessage) => shown(marker).split('\n').find((line) => line.startsWith('*You:*'));

  it('keeps the prompt to one line, whole up to 300 characters', () => {
    const marker = buildForkMarker(forkOf('First line\nsecond line ' + 'word '.repeat(55), 'Ok.'));
    expect(youIn(marker)).toBe(`*You:* First line second line ${'word '.repeat(54)}word`);
  });

  it('shows a longer prompt by its start and its end, where the question usually is', () => {
    const prompt = `Plan the parser ${'and more detail '.repeat(30)}so what do you think?`;
    const marker = buildForkMarker(forkOf(prompt, 'All good here. '.repeat(400)));
    expect(youIn(marker)).toMatch(/^\*You:\* Plan the parser and more detail .+ … .+ so what do you think\?$/);
    // With the longest reply a banner holds, it still fits one message.
    expect(marker.text.length).toBeLessThanOrEqual(4096);
  });

  it('shows a paste by its text and a reply by the words under the quote, as /tree does', () => {
    expect(youIn(buildForkMarker(forkOf('<pasted_content id="a43f">\nBuild log:\nall green\n</pasted_content id="a43f">', 'Ok.'))))
      .toBe('*You:* Build log: all green');
    expect(youIn(buildForkMarker(forkOf('> Use a regex here\n\nWhy not a parser?', 'Ok.'))))
      .toBe('*You:* Why not a parser?');
  });

  it('shows what it quotes as it was written, with no formatting of its own', () => {
    const marker = buildForkMarker({ ...forkOf('Is a-b > c? *Not* `this`', 'Use [c]!'), topic: 'v2.1 (draft)' });
    expect(shown(marker)).toContain('telecoder · v2.1 (draft)');
    expect(shown(marker)).toContain('*You:* Is a-b > c? *Not* `this`');
    expect(quoteIn(marker)).toEqual(['Use [c]!']);
    // The title, You:, the quote and the closing line: nothing from the content.
    expect(marker.entities.map((e: MessageEntity) => e.type)).toEqual(['bold', 'bold', 'expandable_blockquote', 'italic']);
  });
});

describe('cutting text short', () => {
  /** Half of a surrogate pair: not valid text, and Telegram rejects a message carrying one. */
  const brokenEmoji = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

  it('never cuts an emoji in half in a reply with no space to cut at', () => {
    const [quote] = replyQuote('日本語'.repeat(3) + '😀'.repeat(10), 10);
    expect(quote!.text).not.toMatch(brokenEmoji);
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

describe('a fork into a new thread', () => {
  it('opens a thread, loads the fork there and leaves this conversation as it was', async () => {
    const chatId = 404;
    sourceChat(chatId, 70);
    const before = sessionManager.getSession(String(chatId))?.claudeSessionId;
    const createForumTopic = vi.fn(async () => ({ message_thread_id: 9, name: '🍴 project', icon_color: 0 }));
    const sendMessage = vi.fn(async () => ({ message_id: 501 }));
    const base = tap(chatId, 1, 'fork:confirm:thread:70', 80);
    const confirm = {
      ...base,
      chat: { id: chatId, type: 'private' },
      me: { username: 'telecoder_bot', has_topics_enabled: true },
      api: { ...base.api, createForumTopic, sendMessage },
    };

    await handleForkCallback(asCtx(confirm));

    // Named after the project when the conversation has no topic yet.
    expect(createForumTopic).toHaveBeenCalledWith(chatId, '🍴 project');
    const thread = sessionManager.getSession(`${chatId}:9`)!;
    expect(uuidsIn(sessionJsonlPath(PROJECT, thread.claudeSessionId!))).toEqual(['u1', 'a1', 'a2']);
    // The banner goes into the new thread, not this one.
    expect(sendMessage).toHaveBeenCalledWith(
      chatId,
      expect.stringContaining('New branch'),
      expect.objectContaining({ message_thread_id: 9 }),
    );
    expect(sessionManager.getSession(String(chatId))?.claudeSessionId).toBe(before);
    // And the picker here turns into a link to it, keeping the fork point.
    expect(confirm.editMessageText).toHaveBeenCalledWith(
      expect.stringContaining('🍴 project carries on from that point'),
      expect.objectContaining(FORK_BUTTON),
    );
    expect(confirm.editMessageText).toHaveBeenCalledWith(expect.any(String), linkTo('https://t.me/telecoder_bot/9'));
    expect(messageOffsets.lookup(String(chatId), 80)?.lineCount).toBe(3);
  });

  it('goes straight into a thread from the Fork button on a bot with threads', async () => {
    const chatId = 405;
    sourceChat(chatId, 72);
    const before = sessionManager.getSession(String(chatId))?.claudeSessionId;
    const createForumTopic = vi.fn(async () => ({ message_thread_id: 11, name: '🍴 project', icon_color: 0 }));
    const base = tap(chatId, 1, 'fork:pick', 72);
    const pick = {
      ...base,
      chat: { id: chatId, type: 'private' },
      me: { username: 'telecoder_bot', has_topics_enabled: true },
      api: { ...base.api, createForumTopic, sendMessage: vi.fn(async () => ({ message_id: 502 })) },
      reply: vi.fn(async () => ({ message_id: 90 })),
    };

    await handleForkCallback(asCtx(pick));

    // No picker and no confirmation: the thread is open with the fork in it.
    expect(createForumTopic).toHaveBeenCalledWith(chatId, '🍴 project');
    const thread = sessionManager.getSession(`${chatId}:11`)!;
    expect(uuidsIn(sessionJsonlPath(PROJECT, thread.claudeSessionId!))).toEqual(['u1', 'a1', 'a2']);
    expect(sessionManager.getSession(String(chatId))?.claudeSessionId).toBe(before);
    // The reply it was taken from stays; the link goes under it, keeping the fork point.
    expect(pick.editMessageText).not.toHaveBeenCalled();
    expect(pick.reply).toHaveBeenCalledWith(
      expect.stringContaining('Forked into a new thread'),
      expect.objectContaining({ ...FORK_BUTTON, reply_parameters: { message_id: 72 } }),
    );
    expect(pick.reply).toHaveBeenCalledWith(expect.any(String), linkTo('https://t.me/telecoder_bot/11'));
    expect(messageOffsets.lookup(String(chatId), 90)?.lineCount).toBe(3);
  });

  it('goes straight into a thread from /fork on a bot with threads', async () => {
    const chatId = 406;
    sourceChat(chatId, 74);
    sessionManager.createSession(String(chatId), PROJECT).claudeSessionId = `source-${chatId}`;
    const createForumTopic = vi.fn(async () => ({ message_thread_id: 12, name: '🍴 project', icon_color: 0 }));
    const command = {
      chat: { id: chatId, type: 'private' },
      from: { id: 1 },
      message: { message_id: 75, text: '/fork' },
      me: { username: 'telecoder_bot', has_topics_enabled: true },
      api: { createForumTopic, sendMessage: vi.fn(async () => ({ message_id: 503 })) },
      reply: vi.fn(async () => ({ message_id: 76 })),
    };

    await handleForkCommand(asCtx(command));

    // The whole conversation so far, both turns.
    const thread = sessionManager.getSession(`${chatId}:12`)!;
    expect(uuidsIn(sessionJsonlPath(PROJECT, thread.claudeSessionId!))).toEqual(['u1', 'a1', 'a2', 'u2', 'a3']);
    expect(command.reply).toHaveBeenCalledTimes(1);
    expect(command.reply).toHaveBeenCalledWith(
      expect.stringContaining('Forked into a new thread'),
      expect.objectContaining({ reply_parameters: { message_id: 75 } }),
    );
    expect(command.reply).toHaveBeenCalledWith(expect.any(String), linkTo('https://t.me/telecoder_bot/12'));
  });
});
