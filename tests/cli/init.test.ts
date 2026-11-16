import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse as parseEnv } from 'dotenv';
import { runInit, parseOwnerId, OWNER_CAPTURED_REPLY, cleanToken, suggestWorkspace, type InitDeps, type InitOptions, type Preflight } from '../../src/cli/init/flow.js';
import { renderEnv, updateEnvText, backupName } from '../../src/cli/init/env-file.js';
import { AbortedError, type Prompter } from '../../src/cli/init/prompter.js';
import {
  createTelegramClient,
  TelegramApiError,
  TelegramNetworkError,
  type TelegramClient,
  type TgUpdate,
} from '../../src/cli/init/telegram.js';
import { parseInitArgs } from '../../src/cli/commands/init.js';

const GOOD = '7012345678:AAHgoodgoodgoodgoodgoodgoodgoodgood1';
const BAD = '7012345678:AAHbadbadbadbadbadbadbadbadbadbad222';
const OWNER = { id: 412345678, is_bot: false, first_name: 'Ada', username: 'ada' };

// ── Fakes ─────────────────────────────────────────────────────

/** Waits at a prompt until the wizard cancels it (the /start race). */
const WAIT = Symbol('wait');
type Answer = string | boolean | typeof WAIT;

function fakePrompter(answers: Answer[], { interactive = true } = {}) {
  const said: string[] = [];
  const asked: string[] = [];
  const controller = new AbortController();
  const next = (question: string): Answer => {
    asked.push(question);
    if (!answers.length) throw new Error(`No scripted answer for: ${question}`);
    return answers.shift() as Answer;
  };
  const text = (a: Answer, q: string) => {
    if (typeof a !== 'string') throw new Error(`Expected a string answer for: ${q}, got ${String(a)}`);
    return a;
  };
  const prompter: Prompter & { said: string[]; asked: string[]; attached: string[][] } = {
    interactive,
    signal: controller.signal,
    said,
    asked,
    attached: [],
    say: (line = '') => { said.push(line); },
    ask: async (q, opts = {}) => {
      const a = next(q);
      if (a === WAIT) {
        return new Promise<string>((_, reject) => {
          const signal = opts.signal;
          if (!signal) return reject(new Error('WAIT needs a signal'));
          signal.addEventListener('abort', () => reject(new AbortedError()), { once: true });
        });
      }
      return text(a, q) || opts.default || '';
    },
    secret: async (q) => text(next(q), q),
    confirm: async (q, def) => {
      const a = next(q);
      if (a === '') return def;
      if (typeof a !== 'boolean') throw new Error(`Expected a yes/no for: ${q}`);
      return a;
    },
    choose: async (q, _choices, def) => {
      const a = text(next(q), q);
      return (a || def) as never;
    },
    runAttached: (cmd, args) => { prompter.attached.push([cmd, ...args]); return 0; },
    close: () => {},
  };
  return prompter;
}

interface FakeTelegram {
  calls: Array<{ method: string; token: string; params?: unknown }>;
  /** Batches handed out by getUpdates calls with a timeout, in order. */
  updates: TgUpdate[][];
  /** What getUpdates with timeout 0 and no offset returns (the queued backlog). */
  backlog: TgUpdate[];
  webhook: string;
  sendError?: Error;
  /** Whether the bot already has a profile picture. True, so most tests don't set the icon. */
  hasPhoto: boolean;
  photoError?: Error;
  makeClient: (token: string) => TelegramClient;
}

function fakeTelegram(): FakeTelegram {
  const tg: FakeTelegram = {
    calls: [],
    updates: [],
    backlog: [],
    webhook: '',
    hasPhoto: true,
    makeClient: (token) => ({
      getMe: async () => {
        tg.calls.push({ method: 'getMe', token });
        if (token === GOOD) return { id: 7012345678, is_bot: true, first_name: 'My Coder', username: 'my_coder_bot' };
        throw new TelegramApiError('getMe', 401, 'Unauthorized');
      },
      getWebhookInfo: async () => {
        tg.calls.push({ method: 'getWebhookInfo', token });
        return { url: tg.webhook };
      },
      deleteWebhook: async () => {
        tg.calls.push({ method: 'deleteWebhook', token });
        tg.webhook = '';
      },
      getUpdates: async ({ offset, timeout = 0, signal }) => {
        tg.calls.push({ method: 'getUpdates', token, params: { offset, timeout } });
        if (timeout === 0) return offset === undefined ? tg.backlog : [];
        const batch = tg.updates.shift();
        if (batch) return batch;
        // Nothing more scripted: hang like a long poll until cancelled.
        return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new AbortedError()), { once: true }));
      },
      sendMessage: async (chatId, text, entities) => {
        tg.calls.push({ method: 'sendMessage', token, params: { chatId, text, entities } });
        if (tg.sendError) throw tg.sendError;
      },
      hasProfilePhoto: async (userId) => {
        tg.calls.push({ method: 'getUserProfilePhotos', token, params: { userId } });
        return tg.hasPhoto;
      },
      setProfilePhoto: async (jpeg, filename) => {
        tg.calls.push({ method: 'setMyProfilePhoto', token, params: { bytes: jpeg.length, filename, jpeg: jpeg[0] === 0xff && jpeg[1] === 0xd8 } });
        if (tg.photoError) throw tg.photoError;
      },
    }),
  };
  return tg;
}

const okPreflight: Preflight = {
  node: { status: 'ok', label: 'Node.js 22.0.0' },
  claude: [{ status: 'ok', label: 'Claude Code 2.1.0' }, { status: 'ok', label: 'Claude Code is logged in' }],
  nodePty: [{ status: 'ok', label: 'node-pty loads' }],
};

function privateMessage(updateId: number, from = OWNER): TgUpdate {
  return { update_id: updateId, message: { message_id: updateId, text: '/start', from, chat: { id: from.id, type: 'private' } } };
}

let tmp: string;
let home: string;
let envPath: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-init-'));
  home = path.join(tmp, 'home');
  fs.mkdirSync(path.join(home, 'projects'), { recursive: true });
  envPath = path.join(home, '.telecoder', '.env');
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function deps(prompter: Prompter, tg: FakeTelegram, extra: Partial<InitDeps> = {}): InitDeps {
  return {
    prompter,
    makeClient: tg.makeClient,
    preflight: async () => okPreflight,
    envPath,
    ownDir: true,
    env: {},
    homedir: home,
    claudeBin: 'claude',
    now: () => new Date(2026, 10, 13, 14, 25, 1),
    ownerWaitMs: 60_000,
    pollTimeoutSec: 1,
    ...extra,
  };
}

const run = (answers: Answer[], tg = fakeTelegram(), opts: InitOptions = {}, extra: Partial<InitDeps> = {}, interactive = true) => {
  const prompter = fakePrompter(answers, { interactive });
  return { prompter, tg, result: runInit(opts, deps(prompter, tg, extra)) };
};

const readEnv = () => parseEnv(fs.readFileSync(envPath, 'utf-8'));
const allOutput = (p: { said: string[]; asked: string[] }) => [...p.said, ...p.asked].join('\n');

// ── The wizard ────────────────────────────────────────────────

describe('telecoder init: interactive', () => {
  it('runs the happy path: token, /start capture, defaults, write, hello', async () => {
    const tg = fakeTelegram();
    tg.updates = [[privateMessage(5)]];
    const { prompter, result } = run([
      GOOD,   // token
      WAIT,   // the "or type your id" prompt, cancelled by the /start
      true,   // Is this you?
      '',     // workspace: default
      false,  // voice
      true,   // write it
    ], tg);
    expect(await result).toBe(0);

    expect(readEnv()).toEqual({
      TELEGRAM_BOT_TOKEN: GOOD,
      ALLOWED_USER_IDS: '412345678',
      WORKSPACE_DIR: path.join(home, 'projects'),
    });
    expect(fs.readFileSync(envPath, 'utf-8')).toMatch(/^# TeleCoder configuration/);
    expect(prompter.said).toContain('Connected to @my_coder_bot');
    expect(prompter.said.join('\n')).toContain('https://t.me/my_coder_bot');
    expect(prompter.asked).toContain('Is this you: Ada (@ada), id 412345678?');

    const sends = tg.calls.filter((c) => c.method === 'sendMessage').map((c) => c.params);
    // The /start is answered at once, so it doesn't look lost.
    expect(sends[0]).toEqual({ chatId: 412345678, text: OWNER_CAPTURED_REPLY, entities: undefined });
    expect(sends[1]).toEqual({
      chatId: 412345678,
      text: '✅ TeleCoder is set up. Start it with telecoder start.',
      entities: [{ type: 'code', offset: 37, length: 15 }],
    });
    expect(prompter.said).toContain('Next: run `telecoder service install` to keep it running in the background.');
    // The token is never shown.
    expect(allOutput(prompter)).not.toContain(GOOD);
    expect(allOutput(prompter)).not.toContain('AAHgood');
  });

  it('offers the background service at the end, and hands it to the caller on yes', async () => {
    for (const yes of [true, false]) {
      const tg = fakeTelegram();
      tg.updates = [[privateMessage(5)]];
      let requested = false;
      const { prompter, result } = run(
        [GOOD, WAIT, true, '', false, true, yes],
        tg, {}, { requestService: () => { requested = true; } },
      );
      expect(await result).toBe(0);
      expect(prompter.asked).toContain('Keep it running in the background now (telecoder service install)?');
      expect(requested).toBe(yes);
      expect(prompter.said.includes('Next: run `telecoder service install` to keep it running in the background.')).toBe(!yes);
      fs.rmSync(envPath, { force: true });
    }
  });

  it("doesn't offer the service in a checkout, which runs under pm2", async () => {
    const tg = fakeTelegram();
    tg.updates = [[privateMessage(5)]];
    let requested = false;
    const { prompter, result } = run(
      [GOOD, WAIT, true, '', false, true],
      tg, {}, { isCheckout: true, requestService: () => { requested = true; } },
    );
    expect(await result).toBe(0);
    expect(requested).toBe(false);
    expect(prompter.asked.join('\n')).not.toContain('background now');
  });

  it('writes the file 0600 in a 0700 directory', async () => {
    const tg = fakeTelegram();
    const { result } = run([GOOD, '412345678', '', false, true], tg, {}, {}, true);
    tg.updates = [];
    // The typed id wins the race against a poll that never answers.
    expect(await result).toBe(0);
    expect(fs.statSync(envPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(envPath)).mode & 0o777).toBe(0o700);
  });

  it('asks again after a malformed token and a rejected one', async () => {
    const { prompter, tg, result } = run(['not-a-token', BAD, `  "${GOOD}"  `, '412345678', '', false, true]);
    expect(await result).toBe(0);
    const said = prompter.said.join('\n');
    expect(said).toContain("doesn't look like a bot token");
    expect(said).toContain('rejected by Telegram');
    expect(tg.calls.filter((c) => c.method === 'getMe').map((c) => c.token)).toEqual([BAD, GOOD]);
    expect(readEnv().TELEGRAM_BOT_TOKEN).toBe(GOOD);
    expect(allOutput(prompter)).not.toContain('AAHbad');
  });

  it('skips the queued backlog, waits past a "no", and acknowledges what it read', async () => {
    const tg = fakeTelegram();
    const stranger = { id: 999000111, is_bot: false, first_name: 'Eve' };
    tg.backlog = [privateMessage(10, stranger)];
    tg.updates = [
      [{ update_id: 11, message: { message_id: 1, from: stranger, chat: { id: -100, type: 'group' } } }],
      [privateMessage(12, stranger)],
      [privateMessage(13)],
    ];
    const { prompter, result } = run([GOOD, WAIT, false, WAIT, true, '', false, true], tg);
    expect(await result).toBe(0);
    expect(prompter.asked).toContain('Is this you: Eve, id 999000111?');
    expect(readEnv().ALLOWED_USER_IDS).toBe('412345678');
    // Each private /start gets the reply; the group message and the backlog don't.
    const replies = tg.calls.filter((c) => c.method === 'sendMessage' && (c.params as { text: string }).text === OWNER_CAPTURED_REPLY);
    expect(replies.map((c) => (c.params as { chatId: number }).chatId)).toEqual([999000111, 412345678]);

    const polls = tg.calls.filter((c) => c.method === 'getUpdates').map((c) => c.params);
    expect(polls[0]).toEqual({ offset: undefined, timeout: 0 });   // the backlog
    expect(polls[1]).toMatchObject({ offset: 11 });               // past it
    expect(polls.at(-1)).toEqual({ offset: 14, timeout: 0 });      // the ack
  });

  it('carries on when the reply to the /start fails', async () => {
    const tg = fakeTelegram();
    tg.updates = [[privateMessage(5)]];
    tg.sendError = new TelegramNetworkError('connect ECONNRESET');
    const { prompter, result } = run([GOOD, WAIT, true, '', false, true], tg);
    expect(await result).toBe(0);
    expect(readEnv().ALLOWED_USER_IDS).toBe('412345678');
    expect(prompter.asked).toContain('Is this you: Ada (@ada), id 412345678?');
    expect(allOutput(prompter)).not.toContain(GOOD);
  });

  it('asks before removing a webhook, and removes it on yes', async () => {
    const tg = fakeTelegram();
    tg.webhook = 'https://example.com/hook';
    tg.updates = [[privateMessage(1)]];
    const { prompter, result } = run([GOOD, true, WAIT, true, '', false, true], tg);
    expect(await result).toBe(0);
    expect(prompter.asked).toContain('Remove the webhook?');
    const methods = tg.calls.map((c) => c.method);
    expect(methods.indexOf('deleteWebhook')).toBeGreaterThan(-1);
    expect(methods.indexOf('deleteWebhook')).toBeLessThan(methods.indexOf('getUpdates'));
  });

  it('leaves a webhook alone on no, and asks for the id instead of polling', async () => {
    const tg = fakeTelegram();
    tg.webhook = 'https://example.com/hook';
    const { prompter, result } = run([GOOD, false, '412345678', '', false, true], tg);
    expect(await result).toBe(0);
    expect(tg.calls.some((c) => c.method === 'deleteWebhook' || c.method === 'getUpdates')).toBe(false);
    expect(prompter.said.join('\n')).toContain("won't receive messages until it is removed");
  });

  it('falls back to typing the id when another poller holds the bot', async () => {
    const tg = fakeTelegram();
    const client = tg.makeClient;
    tg.makeClient = (token) => ({
      ...client(token),
      getUpdates: async () => { throw new TelegramApiError('getUpdates', 409, 'Conflict: terminated by other getUpdates request'); },
    });
    const { prompter, result } = run([GOOD, '412345678', '', false, true], tg);
    expect(await result).toBe(0);
    expect(prompter.said.join('\n')).toContain('Something else is already reading');
  });

  it('turns voice on without echoing the key', async () => {
    const { prompter, result } = run([GOOD, '412345678', '~/projects', true, 'gsk_secretsecretsecret', true]);
    expect(await result).toBe(0);
    expect(readEnv()).toMatchObject({ GROQ_API_KEY: 'gsk_secretsecretsecret' });
    expect(allOutput(prompter)).not.toContain('gsk_secret');
  });

  it('writes nothing when the summary is declined', async () => {
    const { result } = run([GOOD, '412345678', '', false, false]);
    expect(await result).toBe(1);
    expect(fs.existsSync(envPath)).toBe(false);
  });

  it('stops when the claude CLI is missing', async () => {
    const { prompter, result } = run([], fakeTelegram(), {}, {
      preflight: async () => ({ ...okPreflight, claude: [{ status: 'fail', label: 'Claude Code CLI not found (claude)' }] }),
    });
    expect(await result).toBe(1);
    expect(prompter.said.join('\n')).toContain('has to be installed first');
  });

  it('offers to log Claude Code in, and carries on', async () => {
    const { prompter, result } = run([true, GOOD, '412345678', '', false, true], fakeTelegram(), {}, {
      preflight: async () => ({ ...okPreflight, claude: [okPreflight.claude[0], { status: 'fail', label: 'Claude Code is not logged in' }] }),
    });
    expect(await result).toBe(0);
    expect(prompter.attached).toEqual([['claude', 'auth', 'login']]);
    expect(prompter.said.join('\n')).toContain('claude setup-token');
  });
});

describe('telecoder init: a Claude login in the environment', () => {
  const OAUTH = 'sk-ant-oat01-secretsecretsecret';
  const envLoginPreflight = async (): Promise<Preflight> => ({ ...okPreflight, envLogin: ['CLAUDE_CODE_OAUTH_TOKEN'] });

  it('offers to save it in the .env, hidden in the summary', async () => {
    const { prompter, result } = run([true, GOOD, '412345678', '', false, true], fakeTelegram(), {}, {
      preflight: envLoginPreflight, env: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH },
    });
    expect(await result).toBe(0);
    expect(prompter.said.join('\n')).toContain("When TeleCoder runs as a service, it starts outside your shell and doesn't have");
    expect(prompter.asked[0]).toBe('Save CLAUDE_CODE_OAUTH_TOKEN in the .env too (readable by you only)?');
    expect(prompter.said).toContain('  Claude login     CLAUDE_CODE_OAUTH_TOKEN=<hidden>');
    expect(readEnv().CLAUDE_CODE_OAUTH_TOKEN).toBe(OAUTH);
    expect(fs.statSync(envPath).mode & 0o777).toBe(0o600);
    expect(allOutput(prompter)).not.toContain('secretsecret');
  });

  it('leaves it out on no', async () => {
    const { prompter, result } = run([false, GOOD, '412345678', '', false, true], fakeTelegram(), {}, {
      preflight: envLoginPreflight, env: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH },
    });
    expect(await result).toBe(0);
    expect(readEnv().CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(prompter.said.join('\n')).not.toContain('Claude login');
  });

  it('saves it without asking under --yes, and says so', async () => {
    const { prompter, result } = run([], fakeTelegram(), { tokenEnv: 'TOKEN', ownerId: '412345678', yes: true }, {
      preflight: envLoginPreflight, env: { TOKEN: GOOD, CLAUDE_CODE_OAUTH_TOKEN: OAUTH },
    });
    expect(await result).toBe(0);
    expect(prompter.asked).toEqual([]);
    expect(prompter.said.join('\n')).toContain('CLAUDE_CODE_OAUTH_TOKEN will go in the .env too');
    expect(readEnv().CLAUDE_CODE_OAUTH_TOKEN).toBe(OAUTH);
    expect(allOutput(prompter)).not.toContain('secretsecret');
  });

  it('does nothing for stored credentials', async () => {
    const { prompter, result } = run([GOOD, '412345678', '', false, true], fakeTelegram(), {}, {
      preflight: async () => ({ ...okPreflight, envLogin: [] }), env: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH },
    });
    expect(await result).toBe(0);
    expect(readEnv().CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(allOutput(prompter)).not.toContain('shell\'s environment');
  });
});

describe('telecoder init: an existing .env', () => {
  const original = '# my notes\nTELEGRAM_BOT_TOKEN=' + GOOD + '\nALLOWED_USER_IDS=111,222\nCANCEL_ON_NEW_MESSAGE=true\nGROQ_API_KEY=gsk_old\n';
  beforeEach(() => {
    fs.mkdirSync(path.dirname(envPath), { recursive: true });
    fs.writeFileSync(envPath, original);
  });

  it('keeps it untouched', async () => {
    const { result } = run(['keep']);
    expect(await result).toBe(0);
    expect(fs.readFileSync(envPath, 'utf-8')).toBe(original);
    expect(fs.readdirSync(path.dirname(envPath))).toEqual(['.env']);
  });

  it('edits it: current values as defaults, other lines kept, backed up', async () => {
    const { prompter, result } = run([
      'edit',
      true,          // keep the token for @my_coder_bot
      true,          // keep allowed users
      '',            // workspace
      false,         // voice off → key removed
      true,          // write
    ]);
    expect(await result).toBe(0);
    expect(prompter.asked).toContain('Keep the current token, for @my_coder_bot?');
    expect(prompter.asked).toContain('Keep the allowed users, 111, 222?');
    const text = fs.readFileSync(envPath, 'utf-8');
    expect(text).toContain('# my notes');
    expect(text).toContain('CANCEL_ON_NEW_MESSAGE=true');
    expect(readEnv()).toMatchObject({ ALLOWED_USER_IDS: '111,222' });
    expect(readEnv().GROQ_API_KEY).toBeUndefined();
    const backup = path.join(path.dirname(envPath), '.env.bak-20261113-142501');
    expect(fs.readFileSync(backup, 'utf-8')).toBe(original);
    expect(fs.statSync(backup).mode & 0o777).toBe(0o600);
    // The test message goes to the first allowed user.
    expect(prompter.said).toContain('✓ Sent you a test message on Telegram');
  });

  it('starts over: a fresh file, the old one backed up', async () => {
    const { result } = run(['over', GOOD, '412345678', '', false, true]);
    expect(await result).toBe(0);
    expect(fs.readFileSync(envPath, 'utf-8')).not.toContain('CANCEL_ON_NEW_MESSAGE');
    expect(fs.existsSync(path.join(path.dirname(envPath), '.env.bak-20261113-142501'))).toBe(true);
  });

  it('refuses to replace it without a terminal unless --yes', async () => {
    const { prompter, result } = run([], fakeTelegram(), { tokenEnv: 'TOKEN', ownerId: '412345678' }, { env: { TOKEN: GOOD } }, false);
    expect(await result).toBe(1);
    expect(prompter.said.join('\n')).toContain('pass --yes');
    expect(fs.readFileSync(envPath, 'utf-8')).toBe(original);
  });
});

describe('telecoder init: the bot picture', () => {
  const ID_ANSWERS = [GOOD, '412345678', '', false];
  const photoCalls = (tg: FakeTelegram) => tg.calls.filter((c) => c.method === 'setMyProfilePhoto');

  it('gives the TeleCoder icon to a bot without a picture, unasked, after the write', async () => {
    const tg = fakeTelegram();
    tg.hasPhoto = false;
    const { prompter, result } = run([...ID_ANSWERS, true /* write it */], tg);
    expect(await result).toBe(0);
    expect(prompter.asked.join('\n')).not.toContain('icon');
    expect(prompter.said).toContain('  Bot picture      the TeleCoder icon (--no-icon to skip)');
    expect(prompter.said).toContain('✓ Gave @my_coder_bot the TeleCoder icon');
    expect(photoCalls(tg)).toHaveLength(1);
    expect(photoCalls(tg)[0].params).toMatchObject({ filename: 'telecoder.jpg', jpeg: true });
    expect(tg.calls.find((c) => c.method === 'getUserProfilePhotos')?.params).toEqual({ userId: 7012345678 });
  });

  it('leaves the picture alone with --no-icon, and when nothing is written', async () => {
    const no = fakeTelegram();
    no.hasPhoto = false;
    expect(await run([...ID_ANSWERS, true], no, { icon: false }).result).toBe(0);
    expect(photoCalls(no)).toHaveLength(0);

    fs.rmSync(envPath);
    const unwritten = fakeTelegram();
    unwritten.hasPhoto = false;
    expect(await run([...ID_ANSWERS, false /* write it */], unwritten).result).toBe(1);
    expect(photoCalls(unwritten)).toHaveLength(0);
  });

  it("doesn't ask about a bot that has a picture, unless --icon", async () => {
    const tg = fakeTelegram();
    const { prompter, result } = run([...ID_ANSWERS, true], tg);
    expect(await result).toBe(0);
    expect(prompter.asked.join('\n')).not.toContain('icon');
    expect(photoCalls(tg)).toHaveLength(0);

    fs.rmSync(envPath);
    const forced = fakeTelegram();
    expect(await run([...ID_ANSWERS, true], forced, { icon: true }).result).toBe(0);
    expect(photoCalls(forced)).toHaveLength(1);
  });

  it('a failed upload is a warning, not a failed setup', async () => {
    const tg = fakeTelegram();
    tg.hasPhoto = false;
    tg.photoError = new TelegramApiError('setMyProfilePhoto', 400, 'Bad Request: PHOTO_INVALID');
    const { prompter, result } = run([...ID_ANSWERS, true], tg);
    expect(await result).toBe(0);
    expect(prompter.said.join('\n')).toContain("! Couldn't set the bot's picture");
    expect(readEnv().TELEGRAM_BOT_TOKEN).toBe(GOOD);
  });

  it('without a terminal: sets it on a bare bot, and --no-icon stops that', async () => {
    const flags = { tokenEnv: 'TOKEN', ownerId: '412345678' };
    const bare = fakeTelegram();
    bare.hasPhoto = false;
    expect(await run([], bare, flags, { env: { TOKEN: GOOD } }, false).result).toBe(0);
    expect(photoCalls(bare)).toHaveLength(1);

    fs.rmSync(envPath);
    const declined = fakeTelegram();
    declined.hasPhoto = false;
    expect(await run([], declined, { ...flags, icon: false }, { env: { TOKEN: GOOD } }, false).result).toBe(0);
    expect(photoCalls(declined)).toHaveLength(0);
  });

  it('parses --icon and --no-icon', () => {
    expect(parseInitArgs(['--icon'])).toEqual({ ok: true, opts: { icon: true } });
    expect(parseInitArgs(['--no-icon'])).toEqual({ ok: true, opts: { icon: false } });
  });

  it('uploads the picture as multipart, with the photo attached by name', async () => {
    let sent: { url: string; body: unknown; headers: unknown } | undefined;
    const client = createTelegramClient(GOOD, {
      fetchImpl: async (url, init) => {
        sent = { url, body: init.body, headers: init.headers };
        return new Response(JSON.stringify({ ok: true, result: true }));
      },
    });
    await client.setProfilePhoto(new Uint8Array([0xff, 0xd8, 0xff]), 'telecoder.jpg');
    expect(sent?.url).toMatch(/\/setMyProfilePhoto$/);
    // No content-type of ours: fetch has to write the multipart boundary.
    expect(sent?.headers).toBeUndefined();
    const form = sent?.body as FormData;
    expect(JSON.parse(form.get('photo') as string)).toEqual({ type: 'static', photo: 'attach://picture' });
    expect((form.get('picture') as File).size).toBe(3);
  });
});

describe('telecoder init: non-interactive', () => {
  it('needs the token from an env var', async () => {
    const { prompter, result } = run([], fakeTelegram(), { ownerId: '412345678' }, {}, false);
    expect(await result).toBe(1);
    expect(prompter.said.join('\n')).toContain('--token-env');
    expect(fs.existsSync(envPath)).toBe(false);
  });

  it('needs the owner id', async () => {
    const { prompter, result } = run([], fakeTelegram(), { tokenEnv: 'TOKEN' }, { env: { TOKEN: GOOD } }, false);
    expect(await result).toBe(1);
    expect(prompter.said.join('\n')).toContain('--owner-id');
    expect(fs.existsSync(envPath)).toBe(false);
  });

  it('sets up from flags, asking nothing', async () => {
    const tg = fakeTelegram();
    tg.webhook = 'https://example.com/hook';
    const ws = path.join(home, 'projects');
    const { prompter, result } = run([], tg, {
      tokenEnv: 'TOKEN', ownerId: '412345678', workspace: ws, yes: true,
    }, { env: { TOKEN: GOOD } }, true);
    expect(await result).toBe(0);
    expect(prompter.asked).toEqual([]);
    expect(readEnv()).toEqual({ TELEGRAM_BOT_TOKEN: GOOD, ALLOWED_USER_IDS: '412345678', WORKSPACE_DIR: ws });
    expect(tg.calls.some((c) => c.method === 'deleteWebhook')).toBe(true);
  });

  it('stops on a rejected token and on a missing workspace', async () => {
    const bad = run([], fakeTelegram(), { tokenEnv: 'TOKEN', ownerId: '412345678' }, { env: { TOKEN: BAD } }, false);
    expect(await bad.result).toBe(1);
    expect(bad.prompter.said.join('\n')).toContain('rejected by Telegram');

    const nows = run([], fakeTelegram(), { tokenEnv: 'TOKEN', ownerId: '412345678', workspace: '/nonexistent/x' }, { env: { TOKEN: GOOD } }, false);
    expect(await nows.result).toBe(1);
    expect(fs.existsSync(envPath)).toBe(false);
  });

  it('carries on when the test message fails', async () => {
    const tg = fakeTelegram();
    tg.sendError = new TelegramApiError('sendMessage', 403, "Forbidden: bot can't initiate conversation with a user");
    const { prompter, result } = run([], tg, { tokenEnv: 'TOKEN', ownerId: '412345678' }, { env: { TOKEN: GOOD } }, false);
    expect(await result).toBe(0);
    expect(prompter.said.join('\n')).toContain('press Start');
  });
});

// ── Pieces ────────────────────────────────────────────────────

describe('init helpers', () => {
  it('parses flags, and refuses a token on the command line', () => {
    expect(parseInitArgs(['--token-env', 'T', '--owner-id=5', '--yes'])).toEqual({
      ok: true, opts: { tokenEnv: 'T', ownerId: '5', yes: true },
    });
    expect(parseInitArgs(['--token', GOOD])).toMatchObject({ ok: false });
    expect(parseInitArgs(['--owner-id'])).toMatchObject({ ok: false });
    expect(parseInitArgs(['--bogus'])).toMatchObject({ ok: false });
  });

  it('checks owner ids', () => {
    expect(parseOwnerId(' 412345678 ')).toBe(412345678);
    expect(parseOwnerId('@ada')).toMatch(/usernames/);
    expect(parseOwnerId('123456789')).toMatch(/example value/);
    expect(parseOwnerId('-100123')).toMatch(/positive/);
    expect(parseOwnerId('1,2')).toMatch(/One user id/);
  });

  it('cleans a pasted token', () => {
    expect(cleanToken(` '${GOOD}'\n`)).toBe(GOOD);
  });

  it('suggests ~/projects when there is one', () => {
    expect(suggestWorkspace('/h', (p) => p === '/h/dev')).toBe('/h/dev');
    expect(suggestWorkspace('/h', () => false)).toBe('/h');
  });

  it('renders and updates .env text', () => {
    expect(renderEnv({ A: '1', B: 'has space' })).toMatch(/\nA=1\nB="has space"\n$/);
    expect(updateEnvText('# c\nA=1\nB=2\nA=3\n', { A: 'x', B: undefined, C: 'new' })).toBe('# c\nA=x\n\nC=new\n');
    expect(backupName('/x/.env', new Date(2026, 0, 2, 3, 4, 5))).toBe('/x/.env.bak-20260102-030405');
  });
});

describe('telegram client', () => {
  it('posts to the API root and never leaks the token in errors', async () => {
    const urls: string[] = [];
    const client = createTelegramClient(GOOD, {
      apiRoot: 'http://127.0.0.1:1/',
      fetchImpl: async (url) => {
        urls.push(url);
        throw Object.assign(new Error(`request to ${url} failed`), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
      },
    });
    const err = await client.getMe().catch((e: unknown) => e);
    expect(urls[0]).toBe(`http://127.0.0.1:1/bot${GOOD}/getMe`);
    expect(err).toBeInstanceOf(TelegramNetworkError);
    expect(String((err as Error).message)).not.toContain('AAHgood');
    expect((err as Error).message).toContain('ECONNREFUSED');
  });

  it('turns ok:false into a TelegramApiError', async () => {
    const client = createTelegramClient(GOOD, {
      fetchImpl: async () => new Response(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }), { status: 401 }),
    });
    await expect(client.getMe()).rejects.toMatchObject({ code: 401, method: 'getMe' });
  });
});
