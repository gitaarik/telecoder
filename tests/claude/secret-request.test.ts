import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Context } from 'grammy';
import {
  REDACTED,
  buildSecretPrompt,
  cancelSecretRequest,
  captureSecretMessages,
  checkCommandSyntax,
  describeExit,
  handleSecretCallback,
  hasPendingSecret,
  parseSecretRequest,
  requestSecret,
  resolveCommandCwd,
  runWithSecret,
  secretKeyboard,
  type CommandRun,
  type SecretRequest,
  type SetupTokenLike,
} from '../../src/claude/secret-request.js';
import type { CodeOutcome } from '../../src/claude/setup-token.js';
import { hasPendingQuestionForSession } from '../../src/claude/ask-user.js';

// ALLOWED_USER_IDS is 1,2,3 in vitest.config.ts, and with no ADMIN_USER_IDS
// those are the admins.
const ADMIN = 1;
const SECRET = 'hunter2-sk-test-0123456789';
const TOKEN = `sk-ant-oat01-${'Q'.repeat(60)}`;

const baseRequest = (over: Partial<SecretRequest> = {}): SecretRequest => ({
  name: 'API_KEY',
  purpose: 'For the staging deploy.',
  command: 'store-it "$SECRET"',
  cwd: os.tmpdir(),
  source: 'paste',
  ...over,
});

const okRun = (output = ''): CommandRun => ({ exitCode: 0, signal: null, timedOut: false, output });

interface Recorded {
  method: string;
  chatId: number;
  text?: string;
  other?: unknown;
}

function fakeApi() {
  const calls: Recorded[] = [];
  let nextId = 100;
  const api = {
    sendMessage: vi.fn(async (chatId: number, text: string, other?: unknown) => {
      calls.push({ method: 'sendMessage', chatId, text, other });
      return { message_id: nextId++, chat: { id: chatId } };
    }),
    editMessageText: vi.fn(async (chatId: number, _id: number, text: string, other?: unknown) => {
      calls.push({ method: 'editMessageText', chatId, text, other });
      return true;
    }),
    deleteMessage: vi.fn(async (chatId: number) => {
      calls.push({ method: 'deleteMessage', chatId });
      return true;
    }),
  };
  return { api, calls };
}

function chatCtx(api: ReturnType<typeof fakeApi>['api'], chatId = ADMIN, type = 'private'): Context {
  return { chat: { id: chatId, type }, api } as unknown as Context;
}

let nextMessageId = 500;
/** Push a text message from the user through the capture middleware. */
async function userSends(api: ReturnType<typeof fakeApi>['api'], text: string, chatId = ADMIN): Promise<boolean> {
  const ctx = {
    chat: { id: chatId, type: 'private' },
    from: { id: chatId },
    message: { message_id: nextMessageId++, chat: { id: chatId }, text },
    api,
  } as unknown as Context;
  let passed = false;
  await captureSecretMessages(ctx, async () => {
    passed = true;
  });
  return passed;
}

/** The text of the request message as it stands now. */
const lastText = (calls: Recorded[]): string => calls.filter((c) => c.text !== undefined).at(-1)?.text ?? '';

const posted = (api: ReturnType<typeof fakeApi>['api']) =>
  vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalled());

afterEach(() => {
  for (const key of [String(ADMIN), '2']) cancelSecretRequest(key);
});

describe('parseSecretRequest', () => {
  it('reads and trims the fields, defaulting to a paste', () => {
    expect(parseSecretRequest({ name: ' KEY ', purpose: 'p', command: ' do "$SECRET" ' })).toEqual({
      name: 'KEY',
      purpose: 'p',
      command: 'do "$SECRET"',
      cwd: undefined,
      pattern: undefined,
      source: 'paste',
    });
    expect(parseSecretRequest({ name: 'K', command: 'c', source: 'claude-setup-token' })).toMatchObject({
      source: 'claude-setup-token',
    });
  });

  it('says what is missing', () => {
    expect(parseSecretRequest({ command: 'c' })).toBe('Error: name is required.');
    expect(parseSecretRequest({ name: 'K' })).toBe('Error: command is required.');
    expect(parseSecretRequest({ name: 'K'.repeat(101), command: 'c' })).toMatch(/over 100 characters/);
  });
});

describe('resolveCommandCwd', () => {
  it('expands ~ and resolves against the session directory', () => {
    expect(resolveCommandCwd('~', undefined)).toEqual({ dir: os.homedir() });
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-cwd-'));
    fs.mkdirSync(path.join(base, 'cloud'));
    expect(resolveCommandCwd('cloud', base)).toEqual({ dir: path.join(base, 'cloud') });
    expect(resolveCommandCwd(undefined, base)).toEqual({ dir: base });
  });

  it("refuses a directory that isn't there", () => {
    expect(resolveCommandCwd('/no/such/place', undefined)).toEqual({ error: "Error: cwd doesn't exist: /no/such/place" });
  });
});

describe('checkCommandSyntax', () => {
  it('passes a command that parses and reports one that does not', () => {
    expect(checkCommandSyntax('npx dotenvx set K "$SECRET" -f .env.dev')).toBeUndefined();
    expect(checkCommandSyntax('echo "unterminated')).toMatch(/unexpected EOF|matching/);
  });
});

describe('runWithSecret', () => {
  it('passes the secret in $SECRET and on stdin, and blanks it in the output', async () => {
    const run = await runWithSecret('printf "%s" "$SECRET" | wc -c; cat; echo "arg: $SECRET"', os.tmpdir(), SECRET);
    expect(run.exitCode).toBe(0);
    expect(run.output).toBe(`${SECRET.length}\n${REDACTED}\narg: ${REDACTED}`);
    expect(run.output).not.toContain(SECRET);
  });

  it('reports a failure with what the command printed', async () => {
    const run = await runWithSecret('echo "no such file" >&2; exit 4', os.tmpdir(), SECRET);
    expect(run).toEqual({ exitCode: 4, signal: null, timedOut: false, output: 'no such file' });
    expect(describeExit(run)).toBe('exit 4');
  });

  it('stops a command that runs too long, and what it started', async () => {
    const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'secret-run-')), 'child-lived');
    const run = await runWithSecret(`(sleep 1; touch ${marker}) & sleep 30`, os.tmpdir(), SECRET, 300);
    expect(run.timedOut).toBe(true);
    expect(describeExit(run, 300)).toBe('timed out after 0s');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('strips terminal colour codes from the output', async () => {
    const run = await runWithSecret("printf '\\033[32m✔ set\\033[0m\\n'", os.tmpdir(), SECRET);
    expect(run.output).toBe('✔ set');
  });
});

describe('buildSecretPrompt', () => {
  it('names the secret and shows the command it goes into', () => {
    const { text, entities } = buildSecretPrompt(baseRequest({ cwd: '/srv/app' }), '/srv/app');
    expect(text).toContain('🔐 Claude asks for a secret: API_KEY');
    expect(text).toContain('For the staging deploy.');
    expect(text).toContain('cd /srv/app\nstore-it "$SECRET"');
    expect(text).toContain('Send it as your next message. I delete it from the chat the moment it arrives.');
    expect(entities.map((e) => e.type)).toEqual(['bold', 'pre']);
  });

  it('links the sign-in page when claude setup-token is running', () => {
    const { text, entities } = buildSecretPrompt(baseRequest(), os.homedir(), { link: 'https://claude.com/x' });
    expect(text).toContain('cd ~\n');
    expect(text).toContain('open the sign-in page, approve, and send me the code it shows');
    expect(entities).toContainEqual(expect.objectContaining({ type: 'text_link', url: 'https://claude.com/x' }));
  });

  it("says when claude setup-token couldn't be started", () => {
    const { text } = buildSecretPrompt(baseRequest(), '/srv', { setupProblem: 'claude: not found' });
    expect(text).toContain("I couldn't start claude setup-token here: claude: not found");
    expect(text).toContain('Send it as your next message.');
  });

  it('puts the sign-in link on a button above Cancel', () => {
    expect(secretKeyboard('ab12', 'https://claude.com/x')).toEqual([
      [{ text: '🔑 Sign in to Claude', url: 'https://claude.com/x' }],
      [{ text: 'Cancel', callback_data: 'secret:ab12:cancel' }],
    ]);
  });
});

describe('requestSecret', () => {
  it('takes the next message out of the chat and runs the command with it', async () => {
    const { api, calls } = fakeApi();
    const runCommand = vi.fn(async () => okRun(`✔ set API_KEY (${REDACTED})`));
    const onPosted = vi.fn(async () => {});
    const onSettled = vi.fn(async () => {});

    const result = requestSecret(chatCtx(api), String(ADMIN), baseRequest(), undefined, { runCommand, onPosted, onSettled });
    await posted(api);
    expect(hasPendingSecret(String(ADMIN))).toBe(true);
    expect(hasPendingQuestionForSession(String(ADMIN))).toBe(true);

    expect(await userSends(api, `  ${SECRET}\n`)).toBe(false);
    const { success, message } = await result;

    expect(success).toBe(true);
    expect(runCommand).toHaveBeenCalledWith('store-it "$SECRET"', os.tmpdir(), SECRET);
    expect(api.deleteMessage).toHaveBeenCalledTimes(1);
    expect(message).toContain(`The user sent API_KEY (${SECRET.length} characters), and your command ran with it: exit 0.`);
    expect(message).toContain(`✔ set API_KEY (${REDACTED})`);
    expect(lastText(calls)).toContain('✅ Done: the command finished OK.');
    expect(onPosted).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(hasPendingSecret(String(ADMIN))).toBe(false);
    expect(hasPendingQuestionForSession(String(ADMIN))).toBe(false);
    // Not in anything sent to Telegram, nor in what the agent is told.
    for (const call of calls) expect(JSON.stringify(call)).not.toContain(SECRET);
    expect(message).not.toContain(SECRET);
  });

  it('refuses in a group, where the message would be seen before it was deleted', async () => {
    const { api } = fakeApi();
    const result = await requestSecret(chatCtx(api, -1009990001, 'supergroup'), '-1009990001', baseRequest());
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/only be asked for in a private chat/);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("refuses a user who isn't an admin", async () => {
    const { api } = fakeApi();
    const result = await requestSecret(chatCtx(api, 99), '99', baseRequest());
    expect(result).toMatchObject({ success: false, message: expect.stringMatching(/only an admin/) });
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("refuses a command that doesn't parse, before asking anyone", async () => {
    const { api } = fakeApi();
    const result = await requestSecret(chatCtx(api), String(ADMIN), baseRequest({ command: 'store "$SECRET' }));
    expect(result.message).toMatch(/^Error: the command doesn't parse, so the user wasn't asked/);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it('takes a message sent the moment the request appears', async () => {
    const { api } = fakeApi();
    let release!: () => void;
    const onPosted = vi.fn(() => new Promise<void>((resolve) => {
      release = resolve;
    }));
    const runCommand = vi.fn(async () => okRun());
    const result = requestSecret(chatCtx(api), String(ADMIN), baseRequest(), undefined, { runCommand, onPosted });
    await vi.waitFor(() => expect(onPosted).toHaveBeenCalled());

    // The status bubble is still being updated when the secret arrives.
    expect(await userSends(api, SECRET)).toBe(false);
    release();
    expect((await result).success).toBe(true);
    expect(runCommand).toHaveBeenCalledWith(expect.any(String), expect.any(String), SECRET);
  });

  it('takes one request per chat at a time', async () => {
    const { api } = fakeApi();
    const first = requestSecret(chatCtx(api), String(ADMIN), baseRequest(), undefined, { runCommand: async () => okRun() });
    await posted(api);
    const second = await requestSecret(chatCtx(api), String(ADMIN), baseRequest());
    expect(second.message).toMatch(/already open/);
    cancelSecretRequest(String(ADMIN));
    await first;
  });

  it('lets commands through, so /cancel still reaches its handler, and /cancel ends the wait', async () => {
    const { api, calls } = fakeApi();
    const runCommand = vi.fn(async () => okRun());
    const result = requestSecret(chatCtx(api), String(ADMIN), baseRequest(), undefined, { runCommand });
    await posted(api);

    expect(await userSends(api, '/cancel')).toBe(true);
    expect(cancelSecretRequest(String(ADMIN))).toBe(true);

    expect((await result).message).toMatch(/^The user cancelled the request for API_KEY/);
    expect(runCommand).not.toHaveBeenCalled();
    expect(lastText(calls)).toContain('🚫 Cancelled.');
    // And the next message is an ordinary one again.
    expect(await userSends(api, 'hello')).toBe(true);
  });

  it('ends with the Cancel button, which only the person asked can use', async () => {
    const { api } = fakeApi();
    const result = requestSecret(chatCtx(api), String(ADMIN), baseRequest(), undefined, { runCommand: async () => okRun() });
    await posted(api);
    const keyboard = (api.sendMessage.mock.calls[0][2] as { reply_markup: { inline_keyboard: { callback_data?: string }[][] } })
      .reply_markup.inline_keyboard;
    const data = keyboard.flat().find((b) => b.callback_data)!.callback_data!;

    const tap = (from: number) => {
      const answerCallbackQuery = vi.fn(async () => true);
      const ctx = { from: { id: from }, callbackQuery: { data }, answerCallbackQuery, editMessageReplyMarkup: vi.fn(async () => true) };
      return { ctx: ctx as unknown as Context, answerCallbackQuery };
    };

    const stranger = tap(2);
    await handleSecretCallback(stranger.ctx);
    expect(stranger.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Only the person asked can cancel this.' });
    expect(hasPendingSecret(String(ADMIN))).toBe(true);

    await handleSecretCallback(tap(ADMIN).ctx);
    expect((await result).message).toMatch(/cancelled/);
  });

  it('carries on without the secret when nothing comes in time', async () => {
    const { api, calls } = fakeApi();
    const result = await requestSecret(chatCtx(api), String(ADMIN), baseRequest(), undefined, { waitMs: 50 });
    expect(result).toEqual({
      success: true,
      message: "The user didn't send API_KEY within 1 minute. Carry on without it, or ask again.",
    });
    expect(lastText(calls)).toContain('⏱️ Nothing came within 1 min, so Claude carried on without it.');
  });

  it('stops waiting when the tool call goes away', async () => {
    const { api } = fakeApi();
    const aborter = new AbortController();
    const result = requestSecret(chatCtx(api), String(ADMIN), baseRequest(), aborter.signal);
    await posted(api);
    aborter.abort();
    expect((await result).message).toBe('The request was withdrawn before the user answered.');
    expect(hasPendingSecret(String(ADMIN))).toBe(false);
  });

  it("asks again when a message doesn't match the pattern, without using it", async () => {
    const { api, calls } = fakeApi();
    const runCommand = vi.fn(async () => okRun());
    const result = requestSecret(chatCtx(api), String(ADMIN), baseRequest({ pattern: '^hunter2-' }), undefined, { runCommand });
    await posted(api);

    await userSends(api, 'wait, which key?');
    await vi.waitFor(() => expect(lastText(calls)).toContain("That doesn't look like API_KEY, so I deleted it without using it."));
    expect(runCommand).not.toHaveBeenCalled();

    await userSends(api, SECRET);
    expect((await result).success).toBe(true);
    expect(runCommand).toHaveBeenCalledWith(expect.any(String), expect.any(String), SECRET);
    expect(api.deleteMessage).toHaveBeenCalledTimes(2);
  });

  it('takes messages out of the chat while the command runs, without passing them on', async () => {
    const { api, calls } = fakeApi();
    let finishRun!: () => void;
    const runCommand = vi.fn(() => new Promise<CommandRun>((resolve) => {
      finishRun = () => resolve(okRun());
    }));
    const result = requestSecret(chatCtx(api), String(ADMIN), baseRequest(), undefined, { runCommand });
    await posted(api);
    await userSends(api, SECRET);
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalled());

    // The same paste again, as a double send would be.
    expect(await userSends(api, SECRET)).toBe(false);
    expect(await userSends(api, 'and another')).toBe(false);
    finishRun();
    await result;

    expect(runCommand).toHaveBeenCalledTimes(1);
    const notices = calls.filter((c) => c.method === 'sendMessage' && c.text?.includes('without passing it on'));
    expect(notices).toHaveLength(1);
  });

  it('says when the command failed, and that the secret was not kept', async () => {
    const { api, calls } = fakeApi();
    const runCommand = async (): Promise<CommandRun> => ({ exitCode: 1, signal: null, timedOut: false, output: 'MISSING_ENV_FILE' });
    const result = requestSecret(chatCtx(api), String(ADMIN), baseRequest(), undefined, { runCommand });
    await posted(api);
    await userSends(api, SECRET);
    const { success, message } = await result;
    expect(success).toBe(false);
    expect(message).toContain('your command ran with it: exit 1.');
    expect(message).toContain('MISSING_ENV_FILE');
    expect(message).toContain('The secret was not kept.');
    expect(lastText(calls)).toContain("❌ The command failed (exit 1), and the secret wasn't kept.");
  });

  it('tells the user to delete a message it could not delete', async () => {
    const { api, calls } = fakeApi();
    api.deleteMessage.mockRejectedValueOnce(new Error('message to delete not found'));
    const result = requestSecret(chatCtx(api), String(ADMIN), baseRequest(), undefined, { runCommand: async () => okRun() });
    await posted(api);
    await userSends(api, SECRET);
    const { message } = await result;
    expect(lastText(calls)).toContain("⚠️ I couldn't delete your message, so please delete it yourself.");
    expect(message).toContain("couldn't delete the user's message");
  });
});

describe('requestSecret with claude setup-token', () => {
  const LINK1 = 'https://claude.com/cai/oauth/authorize?state=one';
  const LINK2 = 'https://claude.com/cai/oauth/authorize?state=two';

  function fakeSetup(outcomes: CodeOutcome[]) {
    const setup = {
      waitForLink: vi.fn(async () => LINK1),
      submitCode: vi.fn(async (): Promise<CodeOutcome> => outcomes.shift() ?? { kind: 'failed', reason: 'no more' }),
      kill: vi.fn(),
    } satisfies SetupTokenLike;
    return setup;
  }

  it('sends the sign-in link, passes the code on, and runs the command with the token', async () => {
    const { api, calls } = fakeApi();
    const setup = fakeSetup([{ kind: 'token', token: TOKEN }]);
    const runCommand = vi.fn(async () => okRun('set CLAUDE_CODE_OAUTH_TOKEN with encryption (.env.dev)'));
    const result = requestSecret(
      chatCtx(api),
      String(ADMIN),
      baseRequest({ name: 'CLAUDE_CODE_OAUTH_TOKEN', source: 'claude-setup-token' }),
      undefined,
      { runCommand, startSetupToken: () => setup },
    );
    await posted(api);
    const sent = api.sendMessage.mock.calls[0][2] as { reply_markup: { inline_keyboard: { url?: string }[][] } };
    expect(sent.reply_markup.inline_keyboard[0][0].url).toBe(LINK1);

    await userSends(api, 'abc123#state');
    const { success, message } = await result;

    expect(setup.submitCode).toHaveBeenCalledWith('abc123#state', expect.any(Number));
    expect(runCommand).toHaveBeenCalledWith(expect.any(String), expect.any(String), TOKEN);
    expect(success).toBe(true);
    expect(message).toMatch(/^The user made CLAUDE_CODE_OAUTH_TOKEN with claude setup-token on this machine, and your command ran with it: exit 0\./);
    expect(setup.kill).toHaveBeenCalled();
    for (const call of calls) expect(JSON.stringify(call)).not.toContain(TOKEN);
    expect(message).not.toContain(TOKEN);
  });

  it('offers a fresh link after a refused code, and takes a token sent instead', async () => {
    const { api, calls } = fakeApi();
    const setup = fakeSetup([{ kind: 'rejected', reason: "That code wasn't accepted.", link: LINK2 }]);
    const runCommand = vi.fn(async () => okRun());
    const result = requestSecret(chatCtx(api), String(ADMIN), baseRequest({ source: 'claude-setup-token' }), undefined, {
      runCommand,
      startSetupToken: () => setup,
    });
    await posted(api);

    await userSends(api, 'stale-code');
    await vi.waitFor(() => expect(lastText(calls)).toContain("❌ That code wasn't accepted: That code wasn't accepted."));
    const edit = calls.filter((c) => c.method === 'editMessageText').at(-1)!;
    expect(JSON.stringify(edit.other)).toContain(LINK2);

    await userSends(api, TOKEN);
    expect((await result).success).toBe(true);
    expect(setup.submitCode).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith(expect.any(String), expect.any(String), TOKEN);
  });

  it('gives up when claude setup-token gives no token', async () => {
    const { api } = fakeApi();
    const setup = fakeSetup([{ kind: 'failed', reason: 'claude setup-token exited with code 1' }]);
    const runCommand = vi.fn(async () => okRun());
    const result = requestSecret(chatCtx(api), String(ADMIN), baseRequest({ source: 'claude-setup-token' }), undefined, {
      runCommand,
      startSetupToken: () => setup,
    });
    await posted(api);
    await userSends(api, 'some-code');
    const { success, message } = await result;
    expect(success).toBe(false);
    expect(message).toMatch(/gave no token: claude setup-token exited with code 1/);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("falls back to asking for a token when claude setup-token won't start", async () => {
    const { api } = fakeApi();
    const setup = fakeSetup([]);
    setup.waitForLink.mockRejectedValueOnce(new Error('claude setup-token exited with code 127'));
    const runCommand = vi.fn(async () => okRun());
    const result = requestSecret(chatCtx(api), String(ADMIN), baseRequest({ source: 'claude-setup-token' }), undefined, {
      runCommand,
      startSetupToken: () => setup,
    });
    await posted(api);
    expect(api.sendMessage.mock.calls[0][1]).toContain("I couldn't start claude setup-token here: claude setup-token exited with code 127");

    await userSends(api, TOKEN);
    expect((await result).success).toBe(true);
    expect(setup.submitCode).not.toHaveBeenCalled();
  });

  it("doesn't take messages before the request is on screen", async () => {
    const { api } = fakeApi();
    let giveLink!: (link: string) => void;
    const setup = fakeSetup([]);
    setup.waitForLink.mockImplementationOnce(() => new Promise<string>((resolve) => {
      giveLink = resolve;
    }));
    const result = requestSecret(chatCtx(api), String(ADMIN), baseRequest({ source: 'claude-setup-token' }), undefined, {
      startSetupToken: () => setup,
    });
    await vi.waitFor(() => expect(setup.waitForLink).toHaveBeenCalled());

    expect(await userSends(api, 'still talking about something else')).toBe(true);
    expect(api.deleteMessage).not.toHaveBeenCalled();

    giveLink(LINK1);
    await posted(api);
    cancelSecretRequest(String(ADMIN));
    await result;
  });
});
