/**
 * /prompts lists what you typed, a prompt a line read off the session log, and
 * goes back to any of them: a letter opens a prompt, and a branch starts from
 * just after its reply.
 *
 * Drives the real handlers, stores and session manager against transcripts
 * written under a scratch home, so nothing here touches the real ~/.claude or
 * ~/.claudegram.
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
  findBotById: (botId: string) => ({ botId, name: 'TeleCoder' }),
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

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-prompts-'));
process.env.TELECODER_TEST_HOME = home;
const PROJECT = path.join(home, 'project');
fs.mkdirSync(PROJECT);

const { handlePromptsCommand, handlePromptsCallback } = await import('../../src/bot/handlers/prompts.handler.js');
const { handleRecap } = await import('../../src/bot/handlers/command/session.js');
const { sessionManager } = await import('../../src/claude/session-manager.js');
const { messageOffsets } = await import('../../src/claude/message-offsets.js');
const { sessionJsonlPath } = await import('../../src/claude/session-jsonl.js');

afterAll(() => {
  delete process.env.TELECODER_TEST_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

beforeEach(() => busy.clear());

let uuid = 0;
/** A transcript record, the way Claude Code writes one. */
const rec = (type: 'user' | 'assistant', text: string, id = `r${uuid++}`) => JSON.stringify({
  type,
  uuid: id,
  sessionId: 'whichever',
  message: { role: type, content: [{ type: 'text', text }] },
});

/** What a /compact leaves in the transcript: three user records and no reply. */
const COMPACT = () => [
  rec('user', '/compact'),
  rec('user', '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>'),
  rec('user', '<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>'),
];

/** A session id whose first 8 characters, all a button carries, are this chat's own. */
const sessionIdFor = (chat: number, n = 0) => `${String(chat).padStart(6, '0')}${n}0-1111-2222-3333-444455556666`;

const write = (sessionId: string, lines: string[]) => {
  const file = sessionJsonlPath(PROJECT, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
};

let chatId = 200;
/** A chat on a conversation whose transcript is `lines`. */
function chatWith(lines: string[]): { chat: number; key: string; sessionId: string } {
  const chat = chatId++;
  const sessionId = sessionIdFor(chat);
  write(sessionId, lines);
  sessionManager.createSession(String(chat), PROJECT);
  sessionManager.setClaudeSessionId(String(chat), sessionId);
  return { chat, key: String(chat), sessionId };
}

type Button = { text: string; callback_data: string };
type Sent = { text: string; keyboard: Button[][] };

/** Send `command` in `chat`; the message it answers with comes back. */
async function send(chat: number, command = '/prompts'): Promise<Sent> {
  const reply = vi.fn(async (_text: string, _opts?: { reply_markup?: { inline_keyboard: Button[][] } }) => ({ message_id: 900 }));
  await handlePromptsCommand({ chat: { id: chat }, message: { text: command }, reply } as unknown as Context);
  expect(reply).toHaveBeenCalledTimes(1);
  const [text, options] = reply.mock.calls[0]!;
  return { text, keyboard: options?.reply_markup?.inline_keyboard ?? [] };
}

function tap(chat: number, data: string, messageId = 500) {
  return {
    chat: { id: chat },
    from: { id: 1 },
    callbackQuery: { data, message: { message_id: messageId } },
    answerCallbackQuery: vi.fn(async (_opts?: { text?: string; show_alert?: boolean }) => true),
    editMessageText: vi.fn(async (_text: string, _opts?: { reply_markup?: { inline_keyboard: Button[][] } }) => true),
    reply: vi.fn(async () => ({ message_id: messageId + 1 })),
  };
}

/** Tap `data` in `chat`; what the tapped message became comes back, with the tap. */
async function press(chat: number, data: string, messageId = 500): Promise<Sent & { fake: ReturnType<typeof tap> }> {
  const fake = tap(chat, data, messageId);
  await handlePromptsCallback(fake as unknown as Context);
  const [text, options] = fake.editMessageText.mock.lastCall ?? ['', undefined];
  return { text, keyboard: options?.reply_markup?.inline_keyboard ?? [], fake };
}

const plain = (text: string) => text.replace(/\\(.)/g, '$1');
/** The list's lines, a prompt each. */
const lines = (text: string) => plain(text).split('\n').filter((line) => /^\*[A-Z]\* · /.test(line));
const button = (sent: Sent, text: string) => sent.keyboard.flat().find((b) => b.text === text)!.callback_data;
const buttonTexts = (sent: Sent) => sent.keyboard.map((row) => row.map((b) => b.text));
const uuidsIn = (sessionId: string) => fs.readFileSync(sessionJsonlPath(PROJECT, sessionId), 'utf-8').trim().split('\n')
  .map((line) => (JSON.parse(line) as { uuid?: string }).uuid);

describe('/prompts', () => {
  it('gives the prompt after a /compact a line of its own', async () => {
    const { chat } = chatWith([
      rec('user', 'Plan the parser'), rec('assistant', 'Two stages.'),
      ...COMPACT(),
      rec('user', 'Now add tests'), rec('assistant', 'Added.'),
    ]);
    expect(lines((await send(chat)).text)).toEqual([
      '*A* · _earlier_ — Plan the parser',
      '*B* · _earlier_ — Now add tests',
    ]);
  });

  it('counts only prompts toward N', async () => {
    const { chat } = chatWith([
      rec('user', 'one'), rec('assistant', 'r1'),
      rec('user', 'two'), rec('assistant', 'r2'),
      ...COMPACT(),
      rec('user', 'three'), rec('assistant', 'r3'),
      ...COMPACT(),
    ]);
    expect(lines((await send(chat, '/prompts 2')).text)).toEqual([
      '*A* · _earlier_ — two',
      '*B* · _earlier_ — three',
    ]);
  });

  it('marks a prompt that was interrupted, and leaves out the note', async () => {
    const { chat } = chatWith([
      rec('user', 'do it this way'),
      rec('user', '[Request interrupted by user]'),
      rec('user', 'no, the other way'), rec('assistant', 'Done.'),
    ]);
    expect(lines((await send(chat)).text)).toEqual([
      '*A* · _earlier_ ⏳ — do it this way',
      '*B* · _earlier_ — no, the other way',
    ]);
  });

  it('shows a paste without the tags it was wrapped in', async () => {
    const { chat } = chatWith([
      rec('user', '<pasted_content id="a43f">\nBuild log:\nall green\n</pasted_content id="a43f">'),
      rec('assistant', 'Good.'),
    ]);
    expect(lines((await send(chat)).text)).toEqual([
      '*A* · _earlier_ — Build log: all green',
    ]);
  });

  it('lists where the chat left off after a restart, without loading it', async () => {
    const { chat, key } = chatWith([rec('user', 'before the restart'), rec('assistant', 'Noted.')]);
    // A restart drops the chat's conversation from memory; its /resume stays.
    sessionManager.clearSession(key);

    expect(lines((await send(chat)).text)).toEqual(['*A* · _earlier_ — before the restart']);
    expect(sessionManager.getSession(key)).toBeUndefined();
  });
});

describe('opening a prompt', () => {
  it('shows the exchange it started, and offers a branch from where that ended', async () => {
    const { chat } = chatWith([
      rec('user', 'Plan the parser'), rec('assistant', 'Two stages.'),
      rec('user', 'Split it'), rec('assistant', 'Split into tokenizer.ts and parser.ts.'),
      rec('user', 'Add tests'), rec('assistant', 'Added the tests.'),
    ]);
    const list = await send(chat);
    const opened = await press(chat, button(list, 'B'));

    expect(plain(opened.text)).toContain('💬 *B* · earlier\n');
    expect(plain(opened.text)).toContain('*You:* Split it');
    expect(plain(opened.text)).toContain('Split into tokenizer.ts and parser.ts.');
    expect(plain(opened.text)).not.toContain('Added the tests.');
    expect(buttonTexts(opened)).toEqual([['🌱 New branch from here'], ['⬅️ Back to the prompts']]);

    // And back again, the same list.
    const back = await press(chat, button(opened, '⬅️ Back to the prompts'));
    expect(back.text).toBe(list.text);
    expect(back.keyboard).toEqual(list.keyboard);
  });

  it('has nothing to branch from at a prompt with no reply, and says why', async () => {
    const { chat, key } = chatWith([
      rec('user', 'Plan the parser'), rec('assistant', 'Two stages.'),
      rec('user', 'Now write it all'),
    ]);
    busy.add(key);
    const list = await send(chat);
    const opened = await press(chat, button(list, 'B'));

    expect(plain(opened.text)).toContain('💬 *B* · earlier · being answered now');
    expect(buttonTexts(opened)).toEqual([['⬅️ Back to the prompts']]);
  });
});

describe('branching from a prompt', () => {
  it('starts a new conversation from just after its reply, and leaves this one as it was', async () => {
    const { chat, key, sessionId } = chatWith([
      rec('user', 'Plan the parser', 'p1'), rec('assistant', 'Two stages.', 'q1'),
      // The turn's own bookkeeping goes with it; the next prompt's doesn't.
      JSON.stringify({ type: 'system', subtype: 'turn_duration', uuid: 's1' }),
      JSON.stringify({ type: 'file-history-snapshot', messageId: 'p2' }),
      rec('user', 'Split it', 'p2'), rec('assistant', 'Split.', 'q2'),
    ]);
    const before = fs.readFileSync(sessionJsonlPath(PROJECT, sessionId), 'utf-8');
    const opened = await press(chat, button(await send(chat), 'A'));
    const branch = await press(chat, button(opened, '🌱 New branch from here'), 700);

    const branched = sessionManager.getSession(key)!.claudeSessionId!;
    expect(branched).not.toBe(sessionId);
    expect(uuidsIn(branched)).toEqual(['p1', 'q1', 's1']);
    expect(fs.readFileSync(sessionJsonlPath(PROJECT, sessionId), 'utf-8')).toBe(before);

    // The banner where the branch starts, with its own 🍴 and 🌳.
    expect(plain(branch.text)).toContain('New branch');
    expect(plain(branch.text)).toContain('*You:* Plan the parser');
    expect(plain(branch.text)).toContain("What's above is the conversation you branched from");
    expect(buttonTexts(branch)).toEqual([['🍴 Fork', '🌳 Tree']]);
    expect(messageOffsets.lookup(key, 700)).toMatchObject({ claudeSessionId: branched, lineCount: 3 });
    expect(branch.fake.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Branched.' });

    // The new branch lists only what it was cut with, and in the conversation
    // it came from, the prompt it splits off at is marked.
    expect(lines((await send(chat)).text)).toEqual(['*A* · _earlier_ 🌿 — Plan the parser']);
    sessionManager.setClaudeSessionId(key, sessionId);
    const original = await send(chat);
    expect(lines(original.text)).toEqual([
      '*A* · _earlier_ 🌿 — Plan the parser',
      '*B* · _earlier_ — Split it',
    ]);
    expect(plain(original.text)).toContain('_🌿 a branch splits off here_');
    expect(button(original, '🌳 Show the tree')).toBe('tree:f:p1');

    const split = await press(chat, button(original, 'A'));
    expect(plain(split.text)).toContain('🌿 Another branch splits off here.');
    expect(buttonTexts(split)).toEqual([['🌱 New branch from here'], ['🌳 Show the tree'], ['⬅️ Back to the prompts']]);
  });

  it('leaves /recap ending on the reply that prompt got', async () => {
    const { chat } = chatWith([
      rec('user', 'Plan the parser'), rec('assistant', 'Two stages: tokenize, then parse.'),
      rec('user', 'Split it'), rec('assistant', 'Split into tokenizer.ts and parser.ts.'),
      rec('user', 'Add tests'), rec('assistant', 'Added the tests.'),
    ]);
    const opened = await press(chat, button(await send(chat), 'B'));
    await press(chat, button(opened, '🌱 New branch from here'));

    const reply = vi.fn(async (_text: string, _opts?: unknown) => ({}));
    await handleRecap({ chat: { id: chat }, message: { text: '/recap' }, reply } as unknown as Context);
    const sent = reply.mock.calls.map(([text]) => plain(text).trim());
    expect(sent).toEqual([
      '📋 *Recap* — last 2 exchanges',
      '>*You:* Plan the parser',
      'Two stages: tokenize, then parse.',
      '>*You:* Split it',
      'Split into tokenizer.ts and parser.ts.',
    ]);
  });

  it('waits for a running reply rather than cutting it off', async () => {
    const { chat, key, sessionId } = chatWith([
      rec('user', 'Plan the parser'), rec('assistant', 'Two stages.'),
      rec('user', 'Now write it all'),
    ]);
    const opened = await press(chat, button(await send(chat), 'A'));
    busy.add(key);
    const branch = await press(chat, button(opened, '🌱 New branch from here'));

    expect(sessionManager.getSession(key)?.claudeSessionId).toBe(sessionId);
    expect(branch.fake.answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({ show_alert: true }));
    expect(branch.fake.editMessageText).not.toHaveBeenCalled();
  });

  it('still branches from the conversation a list was sent in after the chat moved on', async () => {
    const { chat, key, sessionId } = chatWith([
      rec('user', 'Plan the parser', 'm1'), rec('assistant', 'Two stages.', 'n1'),
      rec('user', 'Split it', 'm2'), rec('assistant', 'Split.', 'n2'),
    ]);
    const opened = await press(chat, button(await send(chat), 'A'));
    sessionManager.startNewConversation(key);
    const branch = await press(chat, button(opened, '🌱 New branch from here'));

    const branched = sessionManager.getSession(key)!.claudeSessionId!;
    expect(branched).not.toBe(sessionId);
    expect(uuidsIn(branched)).toEqual(['m1', 'n1']);
    expect(plain(branch.text)).toContain("What's above is the conversation you were in");
  });
});

describe('a stale button', () => {
  it('says to send /prompts again when its conversation is gone', async () => {
    const { chat } = chatWith([rec('user', 'Plan the parser'), rec('assistant', 'Two stages.')]);
    const stale = await press(chat, 'prompts:o:deadbeef:15:r1');
    expect(stale.fake.answerCallbackQuery).toHaveBeenCalledWith({ text: expect.stringContaining('send /prompts again') });
    expect(stale.fake.editMessageText).not.toHaveBeenCalled();
  });

  it('opens a prompt the conversation has since moved past the list of', async () => {
    const records = [rec('user', 'first'), rec('assistant', 'One.'), rec('user', 'second'), rec('assistant', 'Two.')];
    const { chat, sessionId } = chatWith(records);
    const list = await send(chat, '/prompts 1');
    write(sessionId, [...records, rec('user', 'third'), rec('assistant', 'Three.')]);

    const opened = await press(chat, button(list, 'A'));
    // Still that prompt, though the last one of the list is a newer one now.
    expect(plain(opened.text)).toMatch(/^💬 earlier\n/);
    expect(plain(opened.text)).toContain('*You:* second');
  });
});
