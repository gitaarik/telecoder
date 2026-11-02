/**
 * /version as src/bot/bot.ts actually assembles it: whether it gets past a
 * running turn depends on where it sits relative to sequentialize, and that
 * lives in createBot.
 *
 * The comparisons are tested against real git in tests/utils/version-check.test.ts.
 * Here they're stood in for, so nothing reaches for the network or depends on
 * the state of this checkout.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import { Api, type Bot } from 'grammy';

const fx = vi.hoisted(() => {
  // Before any import: the state directories are resolved as modules load.
  const nodeFs = process.getBuiltinModule('fs');
  const nodeOs = process.getBuiltinModule('os');
  const nodePath = process.getBuiltinModule('path');
  process.env.TELECODER_TEST_HOME = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'telecoder-version-cmd-'));
  return {
    calls: [] as { method: string; payload: Record<string, unknown> }[],
    prompts: [] as string[],
    finish: new Map<string, () => void>(),
    build: null as string | null,
    code: { kind: 'current' } as Record<string, unknown>,
    remote: { kind: 'same', ref: 'origin/main' } as Record<string, unknown>,
    launcherStale: false,
  };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: actual, homedir: () => process.env.TELECODER_TEST_HOME ?? actual.homedir() };
});

vi.mock('../../src/providers/provider-router.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/providers/provider-router.js')>();
  return {
    ...actual,
    sendToAgent: (_key: string, message: string, options?: { abortController?: AbortController }) =>
      new Promise((resolve) => {
        fx.prompts.push(message);
        fx.finish.set(message, () => resolve({ text: `answer to ${message}`, toolsUsed: [] }));
        options?.abortController?.signal.addEventListener('abort', () => {
          resolve({ text: '🛑 Cancelled.', toolsUsed: [] });
        });
      }),
  };
});

vi.mock('../../src/claude/auto-topic-haiku.js', () => ({ summarizeTopicWithHaiku: async () => null }));

vi.mock('../../src/claude/ipc-server.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/claude/ipc-server.js')>();
  return { ...actual, startIpcServer: async () => ({ port: 45678 }) };
});

vi.mock('../../src/utils/build-info.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/build-info.js')>();
  return { ...actual, describeRunningBuild: () => fx.build };
});

vi.mock('../../src/utils/version-check.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/version-check.js')>();
  return {
    ...actual,
    checkCode: async () => fx.code,
    checkRemote: async () => fx.remote,
  };
});

vi.mock('../../src/worker-restart.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/worker-restart.js')>();
  return { ...actual, launcherIsStale: async () => fx.launcherStale };
});

const { createBot } = await import('../../src/bot/bot.js');
const { sessionManager } = await import('../../src/claude/session-manager.js');

const CHAT = 1; // In the suite's ALLOWED_USER_IDS.
const WAIT = { timeout: 5_000, interval: 20 };

let bot: Bot;
let setMyCommands: ReturnType<typeof vi.spyOn>;
let pending: Promise<void>[];
let nextUpdateId = 1;
let nextMessageId = 100;

function send(text: string): Promise<void> {
  const command = text.match(/^\/\w+/);
  const handled = bot.handleUpdate({
    update_id: nextUpdateId++,
    message: {
      message_id: nextMessageId++,
      date: Math.floor(Date.now() / 1000),
      chat: { id: CHAT, type: 'private', first_name: 'u' },
      from: { id: CHAT, is_bot: false, first_name: 'u' },
      text,
      ...(command ? { entities: [{ type: 'bot_command', offset: 0, length: command[0].length }] } : {}),
    },
  } as never);
  pending.push(handled);
  return handled;
}

const replies = () => fx.calls.filter((c) => c.method === 'sendMessage');

async function version(): Promise<Record<string, unknown>> {
  await send('/version');
  return replies().at(-1)!.payload;
}

beforeAll(async () => {
  // createBot sets the command menu before there's a chance to stub the API.
  setMyCommands = vi.spyOn(Api.prototype, 'setMyCommands').mockResolvedValue(true);
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
    fx.calls.push({ method, payload: payload as Record<string, unknown> });
    if (method === 'sendMessage') {
      return { ok: true, result: { message_id: 5000, date: 0, chat: { id: CHAT, type: 'private' } } } as never;
    }
    return { ok: true, result: true } as never;
  });
  sessionManager.createSession(String(CHAT), fs.mkdtempSync(`${process.env.TELECODER_TEST_HOME}/project-`));
});

afterAll(() => {
  fs.rmSync(process.env.TELECODER_TEST_HOME!, { recursive: true, force: true });
  delete process.env.TELECODER_TEST_HOME;
  vi.restoreAllMocks();
});

beforeEach(() => {
  fx.calls.length = 0;
  fx.prompts.length = 0;
  fx.finish.clear();
  fx.build = 'abc1234 fix: a thing (built 2m ago)';
  fx.code = { kind: 'current' };
  fx.remote = { kind: 'same', ref: 'origin/main' };
  fx.launcherStale = false;
  pending = [];
});

afterEach(async () => {
  for (let i = 0; i < 5; i++) {
    for (const finish of fx.finish.values()) finish();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await Promise.all(pending);
});

describe('/version', () => {
  it('names the build and gives both verdicts', async () => {
    const reply = await version();

    expect(reply.text).toBe(
      'Running: abc1234 fix: a thing (built 2m ago)\n'
      + '✅ This is the current code.\n'
      + '✅ origin/main has nothing newer.',
    );
  });

  it('says what to do when it is behind', async () => {
    fx.code = { kind: 'changed', commits: 5, uncommitted: false };
    fx.remote = { kind: 'behind', ref: 'origin/main' };

    expect((await version()).text).toBe(
      'Running: abc1234 fix: a thing (built 2m ago)\n'
      + '⚠️ The code here has 5 newer commits. /rebuildbot picks them up.\n'
      + "⚠️ origin/main has commits this checkout doesn't. git pull, then /rebuildbot.",
    );
  });

  it('sends a subject that MarkdownV2 would reject as it is, in plain text', async () => {
    fx.build = 'abc1234 fix: keep (some) things_tidy. (built just now)';

    const reply = await version();

    expect(reply.parse_mode).toBeUndefined();
    expect(reply.text).toContain('fix: keep (some) things_tidy.');
  });

  it('has no running line without a build, and leaves out a remote it has nothing to say about', async () => {
    fx.build = null;
    fx.code = { kind: 'unstamped' };
    fx.remote = { kind: 'untracked' };

    expect((await version()).text).toBe(
      "❓ No build stamp, so there's nothing to compare: this is running from source, or from a build that skipped it.",
    );
  });

  it('warns about a launcher its own build says nothing about', async () => {
    fx.launcherStale = true;

    const { text } = await version();

    expect(text).toContain('✅ This is the current code.');
    expect(text).toContain('⚠️ The launcher is still running the code it started with');
  });

  it('answers while a turn is running, and goes nowhere near Claude', async () => {
    // Registered behind sequentialize, this would wait for the turn it's meant
    // to report past, and hang until that turn ended.
    void send('first');
    await vi.waitFor(() => expect(fx.prompts).toEqual(['first']), WAIT);

    const reply = await version();

    expect(fx.finish.has('first')).toBe(true);
    expect(reply.text).toContain('This is the current code');
    expect(fx.prompts).toEqual(['first']);
  });

  it('is in the command menu', () => {
    const [commands] = setMyCommands.mock.calls[0] as [{ command: string }[]];

    expect(commands.map((c) => c.command)).toContain('version');
  });
});
