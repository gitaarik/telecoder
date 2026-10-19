/**
 * /tree draws a forked conversation's branches in one message and takes the
 * chat back to any point in them.
 *
 * These drive the real handlers, stores and session manager against
 * transcripts written under a scratch home, the way loadFork writes them.
 */

import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest';
import type { Context } from 'grammy';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const mocked = { ...actual, homedir: () => process.env.TELECODER_TEST_HOME ?? actual.homedir() };
  return { ...mocked, default: mocked };
});

vi.mock('../../src/utils/instances.js', () => ({
  listSiblingBots: () => [],
  findBotById: (botId: string) => ({ botId, name: botId === 'b2' ? 'Research bot' : 'TeleCoder' }),
}));

// No live process to tear down, and no Telegram to rename the bot on.
vi.mock('../../src/providers/provider-router.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/providers/provider-router.js')>()),
  clearConversation: vi.fn(),
}));
vi.mock('../../src/bot/handlers/command.handler.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/bot/handlers/command.handler.js')>()),
  restoreTopicAndRefreshBotName: vi.fn(async () => {}),
  getSessionTopic: vi.fn(() => undefined),
}));

const busy = new Set<string>();
vi.mock('../../src/claude/request-queue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/claude/request-queue.js')>()),
  isProcessing: (sessionKey: string) => busy.has(sessionKey),
}));

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-tree-'));
process.env.TELECODER_TEST_HOME = home;
const PROJECT = path.join(home, 'project');
fs.mkdirSync(PROJECT);

const { handleTreeCommand, handleTreeCallback, renderTree } = await import('../../src/bot/handlers/tree.handler.js');
const { treeOf, preorder } = await import('../../src/claude/fork-tree.js');
const { sessionManager } = await import('../../src/claude/session-manager.js');
const { sessionHistory } = await import('../../src/claude/session-history.js');
const { messageOffsets } = await import('../../src/claude/message-offsets.js');
const { sessionJsonlPath } = await import('../../src/claude/session-jsonl.js');
const { restoreTopicAndRefreshBotName } = await import('../../src/bot/handlers/command.handler.js');

afterAll(() => {
  delete process.env.TELECODER_TEST_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

beforeEach(() => busy.clear());

let clock = 0;
const rec = (uuid: string, type: 'user' | 'assistant', text: string) => JSON.stringify({
  type,
  uuid,
  timestamp: new Date(Date.UTC(2026, 8, 24, 10, clock++)).toISOString(),
  sessionId: 'whichever',
  message: { role: type, content: [{ type: 'text', text }] },
});
const lines = (...records: string[]) => records.join('\n') + '\n';

const u1 = rec('u1', 'user', 'Plan the parser');
const a1 = rec('a1', 'assistant', 'Two stages: tokenize, then parse.');
const u2 = rec('u2', 'user', 'Split it');
const a2 = rec('a2', 'assistant', 'Split into tokenizer.ts and parser.ts.');
const u3 = rec('u3', 'user', 'Add tests');
const a3 = rec('a3', 'assistant', 'Added the tests.');
const u4 = rec('u4', 'user', 'Write docs');
const a4 = rec('a4', 'assistant', 'Wrote the docs.');
const u5 = rec('u5', 'user', 'Try a regex instead');
const a5 = rec('a5', 'assistant', 'Regex version.');

const HOUR_AGO = new Date(Date.now() - 3600_000);
const write = (sessionId: string, content: string, mtime = HOUR_AGO) => {
  const file = sessionJsonlPath(PROJECT, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  fs.utimesSync(file, mtime, mtime);
  return file;
};

write('docs', lines(u1, a1, u2, a2, u4, a4));
write('tests', lines(u1, a1, u2, a2, u3, a3));
write('regex', lines(u1, a1, u5, a5));
write('solo', lines(rec('x1', 'user', 'Something else'), rec('x2', 'assistant', 'Sure.')));

// Another bot has the regex branch in its /resume.
fs.mkdirSync(path.join(home, '.claudegram'), { recursive: true });
fs.writeFileSync(path.join(home, '.claudegram', 'sessions-b2.json'), JSON.stringify({
  sessions: {
    '7': [{
      conversationId: 'conv-regex',
      claudeSessionId: 'regex',
      projectPath: PROJECT,
      projectName: 'project',
      lastMessagePreview: '',
      topic: 'Parser · regex route',
      createdAt: HOUR_AGO.toISOString(),
      lastActivity: HOUR_AGO.toISOString(),
    }],
  },
}));

/** A chat whose /resume holds `history` (oldest first) and which is now on `current`. */
function chatOn(chatId: number, current: string, history: string[] = []): string {
  const key = String(chatId);
  for (const id of [...history, current]) {
    if (sessionManager.getSession(key)) sessionManager.startNewConversation(key);
    else sessionManager.createSession(key, PROJECT);
    sessionManager.setClaudeSessionId(key, id);
  }
  return key;
}

const nodeRef = (id: string) => `u1:${id}`;

function tap(chatId: number, data: string, messageId = 500) {
  return {
    chat: { id: chatId },
    from: { id: 1 },
    callbackQuery: { data, message: { message_id: messageId } },
    answerCallbackQuery: vi.fn(async () => true),
    editMessageText: vi.fn(async () => true),
    reply: vi.fn(async () => ({ message_id: messageId + 1 })),
  };
}
const asCtx = (fake: object) => fake as unknown as Context;
const plain = (text: string) => text.replace(/\\(.)/g, '$1');
const BRANCH_MARKER_KEYBOARD = {
  inline_keyboard: [[
    { text: '🍴 Fork', callback_data: 'fork:pick' },
    { text: '🌳 Tree', callback_data: 'tree:show' },
  ]],
};

describe('renderTree', () => {
  it('draws the whole tree, a letter per point, and marks where the chat is', () => {
    const view = renderTree(treeOf(PROJECT, 'docs')!, 'docs');
    const drawn = plain(view.text).split('```')[1]!.trim().split('\n');
    expect(drawn).toEqual([
      'A Plan the parser ·1',
      '├B Split it ·1',
      '│├C Add tests ·1 ▸',
      '│└D Write docs ·1 📍',
      '└E Try a regex instead ·1 ▸',
    ]);
    expect(view.keyboard.map((row) => row.map((b) => b.text))).toEqual([['A', 'B', 'C', 'D'], ['E']]);
    expect(view.keyboard[0]![1]!.callback_data).toBe('tree:n:u1:a2');
  });

  it('keeps every line narrow enough for a phone, and every button within Telegram\'s 64 bytes', () => {
    // Long prompts and real uuids, the way a real tree has them.
    const id = (n: number) => `${n}`.padStart(8, '0') + '-1111-2222-3333-444455556666';
    const long = 'please look at the whole scraper pipeline again and tell me what breaks first';
    write('wide-a', lines(rec(id(1), 'user', long), rec(id(2), 'assistant', 'Ok.'), rec(id(3), 'user', long), rec(id(4), 'assistant', 'A.')));
    write('wide-b', lines(rec(id(1), 'user', long), rec(id(2), 'assistant', 'Ok.'), rec(id(5), 'user', long), rec(id(6), 'assistant', 'B.')));

    const view = renderTree(treeOf(PROJECT, 'wide-a')!, 'wide-a');
    for (const line of plain(view.text).split('```')[1]!.trim().split('\n')) {
      expect(Array.from(line).length).toBeLessThanOrEqual(32);
    }
    for (const button of view.keyboard.flat()) {
      expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
    }
    fs.rmSync(sessionJsonlPath(PROJECT, 'wide-a'));
    fs.rmSync(sessionJsonlPath(PROJECT, 'wide-b'));
  });
});

describe('/tree', () => {
  it('draws the tree the chat is in', async () => {
    chatOn(201, 'docs');
    const command = { chat: { id: 201 }, message: { message_id: 1, text: '/tree' }, reply: vi.fn(async () => ({})) };
    await handleTreeCommand(asCtx(command));

    const [text, options] = command.reply.mock.lastCall as unknown as [string, { reply_markup: { inline_keyboard: unknown[][] } }];
    expect(plain(text)).toContain('project* — 3 branches');
    expect(plain(text)).toContain('│└D Write docs ·1 📍');
    expect(options.reply_markup.inline_keyboard.flat()).toHaveLength(5);
  });

  it('lists the forked conversations when the chat is on one never forked', async () => {
    chatOn(202, 'solo');
    const command = { chat: { id: 202 }, message: { message_id: 1, text: '/tree' }, reply: vi.fn(async () => ({})) };
    await handleTreeCommand(asCtx(command));

    const [text, options] = command.reply.mock.lastCall as unknown as [string, { reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> } }];
    expect(plain(text)).toContain("This conversation hasn't been forked yet.");
    expect(plain(text)).toContain('A. Plan the parser — 3 branches');
    expect(options.reply_markup.inline_keyboard.flat()[0]!.callback_data).toBe('tree:f:u1');
  });
});

describe('opening a point', () => {
  it('shows the exchange it ends on, and what can be done from it', async () => {
    chatOn(203, 'docs');
    const open = tap(203, `tree:n:${nodeRef('a2')}`);
    await handleTreeCallback(asCtx(open));

    const [text, options] = open.editMessageText.mock.lastCall as unknown as [string, { reply_markup: { inline_keyboard: Array<Array<{ text: string }>> } }];
    expect(plain(text)).toContain('*B* · Split it');
    expect(plain(text)).toContain('Splits into C and D.');
    expect(plain(text)).toContain('*You:* Split it');
    expect(plain(text)).toContain('Split into tokenizer.ts and parser.ts.');
    // Not a branch end, so there is nothing to carry on — only to branch from.
    expect(options.reply_markup.inline_keyboard.map((row) => row[0]!.text)).toEqual([
      '🌱 New branch from here',
      '⬅️ Back to the tree',
    ]);
  });

  it('says a branch in another bot is carried on as a copy', async () => {
    chatOn(204, 'docs');
    const open = tap(204, `tree:n:${nodeRef('a5')}`);
    await handleTreeCallback(asCtx(open));
    expect(plain(open.editMessageText.mock.lastCall![0] as string))
      .toContain('It lives in Research bot — carrying it on here makes a copy');
  });
});

describe('carrying on a branch', () => {
  it("goes back to one in this chat's /resume", async () => {
    const key = chatOn(205, 'docs', ['tests']);
    const carry = tap(205, `tree:c:${nodeRef('a3')}`, 600);
    await handleTreeCallback(asCtx(carry));

    expect(sessionManager.getSession(key)?.claudeSessionId).toBe('tests');
    expect(sessionHistory.getLastSession(key)?.claudeSessionId).toBe('tests');
    expect(carry.editMessageText).toHaveBeenCalledWith(
      expect.stringContaining('Back on a branch'),
      { parse_mode: 'MarkdownV2', reply_markup: BRANCH_MARKER_KEYBOARD },
    );
    expect(plain(carry.editMessageText.mock.lastCall![0] as string)).toContain('Added the tests.');
    // The banner's 🍴 forks the branch where it stands.
    expect(messageOffsets.lookup(key, 600)).toMatchObject({ claudeSessionId: 'tests', lineCount: 6 });
  });

  it("copies one no chat's /resume has any more — something outside the bot may have it open", async () => {
    const orphanFile = write('orphan', lines(u1, a1, u2, a2, rec('u6', 'user', 'Profile it'), rec('a6', 'assistant', 'Profiled.')));
    const before = fs.readFileSync(orphanFile, 'utf-8');
    const key = chatOn(206, 'solo');

    const open = tap(206, `tree:n:${nodeRef('a6')}`);
    await handleTreeCallback(asCtx(open));
    expect(plain(open.editMessageText.mock.lastCall![0] as string))
      .toContain("No chat's /resume has it any more. Carrying it on here makes a copy");

    const carry = tap(206, `tree:c:${nodeRef('a6')}`);
    await handleTreeCallback(asCtx(carry));

    const copy = sessionManager.getSession(key)!.claudeSessionId!;
    expect(copy).not.toBe('orphan');
    expect(fs.readFileSync(orphanFile, 'utf-8')).toBe(before);
    // The copy ends where the branch does: one branch end in the tree, not two.
    const tree = treeOf(PROJECT, copy)!;
    expect(preorder(tree).find((node) => node.id === 'a6')?.endsHere.sort()).toEqual([copy, 'orphan'].sort());

    // Carried on again from this chat, it's the copy in /resume that comes back.
    chatOn(206, 'solo');
    await handleTreeCallback(asCtx(tap(206, `tree:c:${nodeRef('a6')}`)));
    expect(sessionManager.getSession(key)?.claudeSessionId).toBe(copy);
    fs.rmSync(orphanFile);
    fs.rmSync(sessionJsonlPath(PROJECT, copy));
  });

  it("copies one that lives in another bot, and leaves that bot's alone", async () => {
    const key = chatOn(207, 'docs');
    const regexFile = sessionJsonlPath(PROJECT, 'regex');
    const before = fs.readFileSync(regexFile, 'utf-8');

    const carry = tap(207, `tree:c:${nodeRef('a5')}`);
    await handleTreeCallback(asCtx(carry));

    const copy = sessionManager.getSession(key)!.claudeSessionId!;
    expect(copy).not.toBe('regex');
    const uuids = fs.readFileSync(sessionJsonlPath(PROJECT, copy), 'utf-8').trim().split('\n')
      .map((line) => (JSON.parse(line) as { uuid: string }).uuid);
    expect(uuids).toEqual(['u1', 'a1', 'u5', 'a5']);
    expect(fs.readFileSync(regexFile, 'utf-8')).toBe(before);
    expect(carry.editMessageText).toHaveBeenCalledWith(
      expect.stringContaining('Forked from Research bot'),
      { parse_mode: 'MarkdownV2', reply_markup: BRANCH_MARKER_KEYBOARD },
    );
  });

  it('waits for a running reply rather than cutting it off', async () => {
    const key = chatOn(208, 'docs', ['tests']);
    busy.add(key);
    const carry = tap(208, `tree:c:${nodeRef('a3')}`);
    await handleTreeCallback(asCtx(carry));

    expect(sessionManager.getSession(key)?.claudeSessionId).toBe('docs');
    expect(carry.answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({ show_alert: true }));
    expect(carry.editMessageText).not.toHaveBeenCalled();
  });
});

describe('branching from a point', () => {
  it('starts a new conversation from the transcript as it was there', async () => {
    const key = chatOn(209, 'docs');
    const branch = tap(209, `tree:b:${nodeRef('a2')}`, 700);
    await handleTreeCallback(asCtx(branch));

    const branched = sessionManager.getSession(key)!.claudeSessionId!;
    expect(['docs', 'tests', 'regex']).not.toContain(branched);
    const uuids = fs.readFileSync(sessionJsonlPath(PROJECT, branched), 'utf-8').trim().split('\n')
      .map((line) => (JSON.parse(line) as { uuid: string }).uuid);
    expect(uuids).toEqual(['u1', 'a1', 'u2', 'a2']);

    const [text, options] = branch.editMessageText.mock.lastCall as unknown as [string, object];
    expect(plain(text)).toContain('New branch');
    expect(plain(text)).toContain("What's above is the conversation you were in");
    expect(options).toEqual({ parse_mode: 'MarkdownV2', reply_markup: BRANCH_MARKER_KEYBOARD });
    expect(messageOffsets.lookup(key, 700)).toMatchObject({ claudeSessionId: branched, lineCount: 4 });

    // The new branch is part of the tree now, at the point it came from.
    const tree = treeOf(PROJECT, branched)!;
    expect(preorder(tree).find((node) => node.endsHere.includes(branched))?.id).toBe('a2');

    // No history names that point, so no topic goes with it — and the one the
    // chat had, the conversation it left, doesn't either.
    expect(restoreTopicAndRefreshBotName).toHaveBeenLastCalledWith(expect.anything(), key, undefined);
  });
});

describe('after a restart', () => {
  it('draws where the chat left off without loading it', async () => {
    const key = chatOn(212, 'docs');
    // A restart drops the chat's conversation from memory; its /resume stays.
    sessionManager.clearSession(key);

    const command = { chat: { id: 212 }, message: { message_id: 1, text: '/tree' }, reply: vi.fn(async () => ({})) };
    await handleTreeCommand(asCtx(command));

    const text = plain(command.reply.mock.lastCall![0] as unknown as string);
    expect(text).toContain('│└D Write docs ·1 📍');
    expect(text).toContain('📍 where this chat left off');
    // A standing "Start fresh" counts on nothing being loaded.
    expect(sessionManager.getSession(key)).toBeUndefined();

    // Opening a point doesn't load it either.
    await handleTreeCallback(asCtx(tap(212, `tree:n:${nodeRef('a4')}`)));
    expect(sessionManager.getSession(key)).toBeUndefined();
  });
});

describe('a view Telegram rejects', () => {
  it('goes out as plain text rather than not at all', async () => {
    chatOn(213, 'docs');
    const open = tap(213, `tree:n:${nodeRef('a2')}`);
    open.editMessageText.mockRejectedValueOnce(new Error("Bad Request: can't parse entities"));
    await handleTreeCallback(asCtx(open));

    const [text, options] = open.editMessageText.mock.lastCall as unknown as [string, { parse_mode?: string }];
    expect(options.parse_mode).toBeUndefined();
    expect(text).toContain('B · Split it');
    expect(text).not.toMatch(/\\|\*\*>|\|\|$/m);
  });
});

describe('a stale button', () => {
  it('says to send /tree again when its tree is gone', async () => {
    chatOn(210, 'docs');
    const open = tap(210, 'tree:n:deadbeef:a2');
    await handleTreeCallback(asCtx(open));
    expect(open.answerCallbackQuery).toHaveBeenCalledWith({ text: expect.stringContaining('send /tree again') });
    expect(open.editMessageText).not.toHaveBeenCalled();
  });
});
