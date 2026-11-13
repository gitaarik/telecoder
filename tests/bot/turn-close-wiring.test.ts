/**
 * Every turn ends with the status line, whichever way it started.
 *
 * Each way of starting a turn used to write its own ending, and only a typed
 * message's had the status line. A voice note, a photo, a file, a scheduled
 * fire, and /plan, /explore and /loop with the task on the same line all left
 * the chat on the tail of the reply, with nothing to say where things stood.
 *
 * This runs the bot as src/bot/bot.ts assembles it, so it is each real handler
 * that has to end its turn right. Telegram, the provider, the download and the
 * transcription are stood in for.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { Api, type Bot } from 'grammy';
import type { MessageEntity } from 'grammy/types';
import { marked } from '../helpers/entity-marks.js';
import type { AgentUsage } from '../../src/providers/types.js';
import type { FireHandler, Schedule } from '../../src/claude/scheduler.js';

const fx = vi.hoisted(() => {
  // Before any import: the state directories are resolved as modules load.
  const nodeFs = process.getBuiltinModule('fs');
  const nodeOs = process.getBuiltinModule('os');
  const nodePath = process.getBuiltinModule('path');
  process.env.TELECODER_TEST_HOME = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'telecoder-turn-close-'));
  return {
    /** What the bot put in the chat, in order: a message sent, or one edited. */
    posts: [] as { method: string; text: string }[],
    /** What reached the provider, which is to say Claude. */
    prompts: [] as string[],
    /** What the next download writes to disk. */
    download: Buffer.from('plain text'),
    nextId: 5000,
  };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: actual, homedir: () => process.env.TELECODER_TEST_HOME ?? actual.homedir() };
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

vi.mock('../../src/providers/provider-router.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/providers/provider-router.js')>();
  return {
    ...actual,
    sendToAgent: async (_key: string, message: string) => {
      fx.prompts.push(message);
      return { text: 'Here is the answer.', toolsUsed: [], usage: USAGE };
    },
    // A loop's response carries no usage, in either mode. Its iterations each
    // left one with the provider, which is where the session's last one is.
    sendLoopToAgent: async (_key: string, message: string) => {
      fx.prompts.push(message);
      return { text: 'Here is the answer.', toolsUsed: [] };
    },
    getCachedUsage: () => ({ ...USAGE, cacheReadTokens: 298_500 }),
  };
});

// A real side call to Haiku for the topic, on every message.
vi.mock('../../src/claude/auto-topic-haiku.js', () => ({ summarizeTopicWithHaiku: async () => null }));

// Nothing here spawns a claude to call back, and a listener would outlive the test.
vi.mock('../../src/claude/ipc-server.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/claude/ipc-server.js')>();
  return { ...actual, startIpcServer: async () => ({ port: 45679 }) };
});

// No Telegram to fetch the upload from, and no Whisper to hear the note.
vi.mock('../../src/utils/download.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/download.js')>();
  return {
    ...actual,
    downloadFileSecure: async (_url: string, destPath: string) => {
      process.getBuiltinModule('fs').writeFileSync(destPath, fx.download);
    },
  };
});
vi.mock('../../src/audio/transcribe.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/audio/transcribe.js')>();
  return { ...actual, transcribeFile: async () => 'what the voice note said' };
});

const { createBot } = await import('../../src/bot/bot.js');
const { sessionManager } = await import('../../src/claude/session-manager.js');
const { userPreferences } = await import('../../src/providers/user-preferences.js');
const { setSessionTopic } = await import('../../src/bot/handlers/command/topic-store.js');
const { setStreamingMode } = await import('../../src/bot/handlers/command/streaming-mode.js');
const { scheduler } = await import('../../src/claude/scheduler.js');
const { startScheduledRunner } = await import('../../src/claude/scheduled-runner.js');

const CHAT = 1; // In the suite's ALLOWED_USER_IDS.
const KEY = String(CHAT);
const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const WAIT = { timeout: 5_000, interval: 20 };

// The eight bytes every PNG starts with, which is all the upload check reads.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

/** The stats every status line carries, in a chat that shows no usage footer. */
const STATS = '_📁 shop · 🧠 Auto · 🤖 opus-5-5 · 📊 12% · 💰 $0.12_';

let bot: Bot;
let fire: FireHandler;
let nextUpdateId = 1;
let nextMessageId = 100;

/** Hand the bot a message from the user, with whatever it carries. */
function receive(content: Record<string, unknown>): Promise<void> {
  const text = typeof content.text === 'string' ? content.text : '';
  const command = text.match(/^\/\w+/);
  return bot.handleUpdate({
    update_id: nextUpdateId++,
    message: {
      message_id: nextMessageId++,
      date: Math.floor(Date.now() / 1000),
      chat: { id: CHAT, type: 'private', first_name: 'u' },
      from: { id: CHAT, is_bot: false, first_name: 'u' },
      ...(command ? { entities: [{ type: 'bot_command', offset: 0, length: command[0].length }] } : {}),
      ...content,
    },
  } as never);
}

const voiceNote = { voice: { file_id: 'v1', file_unique_id: 'v1u', duration: 3, mime_type: 'audio/ogg', file_size: 2_000 } };
const photo = { photo: [{ file_id: 'p1', file_unique_id: 'p1u', width: 40, height: 40, file_size: 2_000 }], caption: 'what is this?' };
const file = { document: { file_id: 'd1', file_unique_id: 'd1u', file_name: 'notes.txt', mime_type: 'text/plain', file_size: 2_000 } };

/**
 * Run a turn started by `start` to its end, and give back what it put in the
 * chat from the reply on. A turn that never posts its status line times out.
 */
async function endOfTurn(start: () => Promise<void>): Promise<string[]> {
  const started = start();
  await vi.waitFor(() => expect(fx.posts.some((p) => p.text.includes('📁'))).toBe(true), WAIT);
  await started;
  const texts = fx.posts.map((p) => p.text);
  const reply = texts.findIndex((t) => t.includes('Here is the answer'));
  expect(reply, 'the reply reached the chat').toBeGreaterThanOrEqual(0);
  return texts.slice(reply);
}

/** A schedule as the scheduler hands one to its fire handler. */
function schedule(prompt: string): Schedule {
  return {
    id: 'sched-1',
    sessionKey: KEY,
    cwd: sessionManager.getSession(KEY)!.workingDirectory,
    prompt,
    kind: 'interval',
    intervalMs: 60_000,
    maxRuns: 50,
    runs: 0,
    consecutiveFailures: 0,
    disabled: false,
    createdAt: new Date().toISOString(),
  };
}

beforeAll(async () => {
  // createBot sets the command menu before there's a chance to stub the API.
  vi.spyOn(Api.prototype, 'setMyCommands').mockResolvedValue(true);
  bot = await createBot();
  bot.botInfo = {
    id: 123456789,
    is_bot: true,
    first_name: 'probe',
    username: 'probe_bot',
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
  } as never;
  bot.api.config.use(async (_prev, method, payload) => {
    const { text, entities } = payload as { text?: unknown; entities?: MessageEntity[] };
    if ((method === 'sendMessage' || method === 'editMessageText') && typeof text === 'string') {
      // Its bold, italic and code marked, so a line reads as one string.
      fx.posts.push({ method, text: marked(text, entities) });
    }
    if (method === 'sendMessage') {
      return { ok: true, result: { message_id: fx.nextId++, date: 0, chat: { id: CHAT, type: 'private' } } } as never;
    }
    if (method === 'getFile') {
      return { ok: true, result: { file_id: 'f', file_unique_id: 'fu', file_path: 'files/upload' } } as never;
    }
    return { ok: true, result: true } as never;
  });

  // The scheduler arms timers from disk; all that's wanted is its fire handler.
  vi.spyOn(scheduler, 'loadAll').mockImplementation((handler) => { fire = handler; });
  startScheduledRunner(bot);

  const project = path.join(process.env.TELECODER_TEST_HOME!, 'shop');
  fs.mkdirSync(project);
  sessionManager.createSession(KEY, project);
  sessionManager.setClaudeSessionId(KEY, SESSION_ID);

  // The status line as the chats it was asked for have it: everything on.
  userPreferences.setShowStatusLine(CHAT, true);
  userPreferences.setShowTopicInStatusLine(CHAT, true);
  userPreferences.setShowPromptInStatusLine(CHAT, true);
  userPreferences.setShowSessionInStatusLine(CHAT, true);
});

afterAll(() => {
  setStreamingMode('streaming');
  fs.rmSync(process.env.TELECODER_TEST_HOME!, { recursive: true, force: true });
  delete process.env.TELECODER_TEST_HOME;
  vi.restoreAllMocks();
});

beforeEach(() => {
  fx.posts.length = 0;
  fx.prompts.length = 0;
  fx.download = Buffer.from('plain text');
  // A turn's own prompt can set the topic; put back the one the tests name.
  setSessionTopic(KEY, 'Checkout bug');
});

describe.each(['streaming', 'wait'] as const)('a turn, with replies in %s mode', (mode) => {
  beforeEach(() => setStreamingMode(mode));

  it.each([
    ['a typed message', () => receive({ text: 'why does checkout fail?' }), 'why does checkout fail?'],
    ['a voice note', () => receive(voiceNote), 'what the voice note said'],
    ['a photo', () => { fx.download = PNG; return receive(photo); }, '📷 Image — what is this?'],
    ['a file', () => receive(file), '📎 notes.txt'],
  ])('started by %s ends with the status line', async (_name, start, prompt) => {
    const posted = await endOfTurn(start);

    const statusLine = posted.at(-1)!;
    expect(statusLine.split('\n')).toEqual([
      expect.stringMatching(/^_💬 .+_$/),
      '',
      `_▸ ${prompt}_`,
      '',
      `🔗 \`claude --resume ${SESSION_ID}\``,
      STATS,
    ]);
    // One of them, and nothing after it.
    expect(posted.filter((t) => t.includes('📁'))).toHaveLength(1);
  });
});

describe('a turn started by a command with its task on the same line', () => {
  it.each([
    ['/plan', '/plan add a wishlist', 'add a wishlist', STATS],
    ['/explore', '/explore how do refunds work?', 'how do refunds work?', STATS],
    // With the model and the context the session last had, a loop's response
    // having none of its own to give.
    ['/loop', '/loop fix the failing tests', 'fix the failing tests', STATS.replace('📊 12%', '🔴 30%')],
  ])('%s ends with the status line', async (_name, text, prompt, stats) => {
    const posted = await endOfTurn(() => receive({ text }));

    expect(fx.prompts).toEqual([prompt]);
    expect(posted.at(-1)).toContain(`_▸ ${prompt}_`);
    expect(posted.at(-1)!.split('\n').at(-1)).toBe(stats);
    expect(posted.filter((t) => t.includes('📁'))).toHaveLength(1);
  });
});

describe('a scheduled fire', () => {
  it('ends with the stats alone, without the topic, the prompts or the resume command', async () => {
    const posted = await endOfTurn(() => fire(schedule('check the deploy')));

    expect(fx.prompts).toEqual(['check the deploy']);
    // A schedule may fire every minute. The whole block under each short
    // result would outweigh it, and the prompts would all be the schedule's.
    expect(posted.at(-1)).toBe(STATS);
    expect(posted.filter((t) => t.includes('📁'))).toHaveLength(1);
  });
});
