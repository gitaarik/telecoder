/**
 * claudegram_request_secret: a secret from the user that never enters the
 * conversation.
 *
 * A task that needed a credential used to stop at a set of instructions: open
 * a terminal on the machine, over SSH, and type it there, because anything
 * sent in the chat, or run there with `!`, lands in the session log, in the
 * context sent to the model, and in the Telegram history. From a phone that's
 * as far as it goes.
 *
 * Instead the agent names the secret and the command that consumes it, and
 * the user sends the secret as an ordinary message. {@link captureSecretMessages}
 * takes it out of the update stream before anything can queue, batch or
 * forward it, and deletes it from the chat. The command then runs with the
 * secret in $SECRET and on stdin, and the agent gets the exit code and the
 * output with the secret blanked out. Never the value.
 *
 * For a long-lived Claude token the user needs no terminal at all. With source
 * "claude-setup-token" the bot runs `claude setup-token` in a pty of its own
 * (setup-token.ts) and passes the sign-in link on. The user approves in any
 * browser and sends back the code the page shows, and the token goes from that
 * pty straight into the command, without passing through Telegram.
 *
 * The limits are what keep it a secret:
 *   - private chats only, because in a group everyone sees a message before
 *     it can be deleted
 *   - admins only, because the command runs outside Claude Code's permission
 *     prompts and TeleCoder's permission gate, approved by whoever supplies
 *     the secret
 *   - the user sees the command before they send anything
 *   - one request per chat, waiting at most QUESTION_TIMEOUT_MINUTES
 *   - nothing kept: the value lives in this process until the command has
 *     run, and is never logged
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import type { Context, MiddlewareFn } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';
import { EntityText, clip, type EntityMessage } from '../telegram/entities.js';
import { envWithoutParentSession } from '../utils/claude-env.js';
import { isAdmin } from '../utils/admins.js';
import { sanitizeError } from '../utils/sanitize.js';
import { getSessionKeyFromCtx, parseSessionKey } from '../utils/session-key.js';
import { noteAwaitingUser, questionTimeoutMs } from './ask-user.js';
import { sessionManager } from './session-manager.js';
import { SetupTokenRun, looksLikeOAuthToken, type CodeOutcome } from './setup-token.js';

/** How long the command gets. npx may have to download its package first. */
export const COMMAND_TIMEOUT_MS = 2 * 60 * 1000;

/** What the secret is shown as in output passed on. */
export const REDACTED = '[secret]';

/** Codes a user can try before the setup-token run is given up on. */
const MAX_CODE_ATTEMPTS = 3;
const LINK_TIMEOUT_MS = 30_000;
const CODE_CHECK_TIMEOUT_MS = 60_000;

/** Command output kept before the secret is blanked out and the tail taken. */
const MAX_OUTPUT_KEPT = 1024 * 1024;
const OUTPUT_FOR_USER = 700;
const OUTPUT_FOR_AGENT = 3000;

const NAME_MAX = 100;
const PURPOSE_MAX = 1200;
const COMMAND_MAX = 1500;

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export type SecretSource = 'paste' | 'claude-setup-token';

export interface SecretRequest {
  /** What the secret is, as the user knows it: an env var name or a label. */
  name: string;
  /** For the user: what it's for, and where to find it. */
  purpose: string;
  /** Bash that consumes the secret, from $SECRET or stdin. */
  command: string;
  /** Where the command runs. The session's working directory when unset. */
  cwd?: string;
  /** What the secret has to look like. Anything else is asked for again. */
  pattern?: string;
  source: SecretSource;
}

export interface SecretResult {
  success: boolean;
  message: string;
}

/** Why a request stopped waiting for the user. */
type Ending = 'user' | 'agent' | 'timeout';

/** The parts of a setup-token run the flow uses, so tests can stand one in. */
export interface SetupTokenLike {
  waitForLink(timeoutMs?: number): Promise<string>;
  submitCode(code: string, timeoutMs?: number): Promise<CodeOutcome>;
  kill(): void;
}

export interface SecretFlowDeps {
  /** A question is up: the status bubble should say the turn is waiting. */
  onPosted?: () => Promise<void>;
  /** The request is over, however it ended. */
  onSettled?: () => Promise<void>;
  startSetupToken?: () => SetupTokenLike;
  runCommand?: typeof runWithSecret;
  /** How long to wait for the user. QUESTION_TIMEOUT_MINUTES by default. */
  waitMs?: number;
}

/** Read a request out of an MCP call's arguments, or say what's wrong with it. */
export function parseSecretRequest(body: Record<string, unknown>): SecretRequest | string {
  const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
  const name = text(body.name);
  const command = text(body.command);
  if (!name) return 'Error: name is required.';
  if (name.length > NAME_MAX) {
    return `Error: name is over ${NAME_MAX} characters. It's a label, like CLAUDE_CODE_OAUTH_TOKEN.`;
  }
  if (!command) return 'Error: command is required.';
  return {
    name,
    purpose: text(body.purpose),
    command,
    cwd: text(body.cwd) || undefined,
    pattern: text(body.pattern) || undefined,
    source: body.source === 'claude-setup-token' ? 'claude-setup-token' : 'paste',
  };
}

/** The directory a command runs in, or why it can't run there. */
export function resolveCommandCwd(
  cwd: string | undefined,
  sessionDir: string | undefined,
): { dir: string } | { error: string } {
  const base = sessionDir ?? os.homedir();
  let dir = cwd || base;
  if (dir === '~') dir = os.homedir();
  else if (dir.startsWith('~/')) dir = path.join(os.homedir(), dir.slice(2));
  dir = path.resolve(base, dir);
  try {
    if (!fs.statSync(dir).isDirectory()) return { error: `Error: cwd is not a directory: ${dir}` };
  } catch {
    return { error: `Error: cwd doesn't exist: ${dir}` };
  }
  return { dir };
}

/**
 * Bash's own syntax check, so a quoting slip turns up before the user is asked
 * for anything rather than after they've handed the secret over.
 */
export function checkCommandSyntax(command: string): string | undefined {
  const result = spawnSync('bash', ['-n', '-c', command], { encoding: 'utf8', timeout: 5000 });
  // No bash to check with: running it will say so.
  if (result.error || result.status === 0) return undefined;
  return result.stderr.trim() || `bash -n exited with code ${result.status}`;
}

export function redactSecret(text: string, secret: string): string {
  return secret ? text.split(secret).join(REDACTED) : text;
}

export interface CommandRun {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  /** stdout and stderr in the order they came, escapes stripped, secret blanked. */
  output: string;
}

/**
 * Run `command` with the secret in $SECRET and on stdin, followed by a
 * newline. No terminal: a command that prompts gets end-of-file.
 */
export function runWithSecret(
  command: string,
  cwd: string,
  secret: string,
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<CommandRun> {
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    let settled = false;

    const child = spawn('bash', ['-c', command], {
      cwd,
      env: { ...envWithoutParentSession(), SECRET: secret },
      stdio: ['pipe', 'pipe', 'pipe'],
      // A group of its own, so a timeout also reaches whatever it started.
      detached: true,
    });

    const collect = (chunk: Buffer): void => {
      output = (output + chunk.toString('utf8')).slice(-MAX_OUTPUT_KEPT);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    // A command that never reads stdin can be gone before the write lands.
    child.stdin.on('error', () => {});
    child.stdin.end(`${secret}\n`);

    const signalGroup = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // Already gone.
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      signalGroup('SIGTERM');
      setTimeout(() => signalGroup('SIGKILL'), 5000).unref();
    }, timeoutMs);

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, note = ''): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const text = redactSecret((output + note).replace(ANSI, ''), secret).trim();
      resolve({ exitCode, signal, timedOut, output: text });
    };
    child.on('error', (err) => finish(null, null, `\n${err.message}`));
    child.on('close', (code, signal) => finish(code, signal));
  });
}

export function describeExit(run: CommandRun, timeoutMs = COMMAND_TIMEOUT_MS): string {
  if (run.timedOut) return `timed out after ${Math.round(timeoutMs / 1000)}s`;
  if (run.signal) return `killed by ${run.signal}`;
  if (run.exitCode === null) return "couldn't start";
  return `exit ${run.exitCode}`;
}

function tailOf(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(-(max - 1))}`;
}

function tildify(dir: string): string {
  const home = os.homedir();
  return dir === home ? '~' : dir.startsWith(`${home}/`) ? `~${dir.slice(home.length)}` : dir;
}

export interface PromptState {
  /** The sign-in link, while claude setup-token runs for this request. */
  link?: string;
  /** Why claude setup-token couldn't be started, when it was asked for. */
  setupProblem?: string;
}

/** The message that asks for the secret, before any status is added under it. */
export function buildSecretPrompt(req: SecretRequest, cwd: string, state: PromptState = {}): EntityMessage {
  const b = new EntityText();
  b.add('🔐 Claude asks for a secret: ').bold(clip(req.name, NAME_MAX)).newline(2);
  if (req.purpose) b.add(clip(req.purpose, PURPOSE_MAX)).newline(2);
  b.add('It goes into this command, not to Claude:').newline();
  b.pre(clip(`cd ${tildify(cwd)}\n${req.command}`, COMMAND_MAX), 'bash').newline();

  if (state.link) {
    b.add('To make a token, open the ')
      .link('sign-in page', state.link)
      .add(', approve, and send me the code it shows. Already have a token? Send that instead. ')
      .add('Either way I delete your message the moment it arrives, and a token made here never passes through this chat.');
  } else {
    if (state.setupProblem) {
      b.add(`I couldn't start claude setup-token here: ${clip(state.setupProblem, 300)}`).newline(2);
    }
    b.add('Send it as your next message. I delete it from the chat the moment it arrives.');
  }
  return b.build();
}

/** `prompt` with a status line, or block, under it. */
export function withStatus(prompt: EntityMessage, status: EntityMessage | string): EntityMessage {
  const b = new EntityText().append(prompt).newline(2);
  if (typeof status === 'string') b.add(status);
  else b.append(status);
  return b.build();
}

export function secretKeyboard(id: string, link?: string): InlineKeyboardButton[][] {
  const rows: InlineKeyboardButton[][] = [];
  if (link) rows.push([{ text: '🔑 Sign in to Claude', url: link }]);
  rows.push([{ text: 'Cancel', callback_data: `secret:${id}:cancel` }]);
  return rows;
}

function statusWithOutput(head: string, output: string, footer?: string): EntityMessage {
  const b = new EntityText().add(head);
  if (output) b.newline().pre(tailOf(output, OUTPUT_FOR_USER));
  if (footer) b.newline().add(footer);
  return b.build();
}

interface PendingSecret {
  id: string;
  sessionKey: string;
  userId: number;
  /**
   * Whether the user's messages are taken out of the chat now. Not until the
   * request is on screen: nobody can be answering it before then.
   */
  readonly capturing: boolean;
  /** Hand over a message taken out of the chat. */
  receive(text: string, deleted: boolean): void;
  end(why: Ending): void;
}

/** Open requests, by session key. */
const pending = new Map<string, PendingSecret>();

export function hasPendingSecret(sessionKey: string): boolean {
  return pending.has(sessionKey);
}

/** Stop waiting on a secret in this chat, as /cancel does. False when there was none. */
export function cancelSecretRequest(sessionKey: string): boolean {
  const entry = pending.get(sessionKey);
  if (!entry) return false;
  entry.end('user');
  return true;
}

/**
 * Take a message meant as a secret out of the update stream: delete it from
 * the chat and hand it to the request, and nothing after this middleware sees
 * it. Registered ahead of the batcher, the queue and sequentialize, since the
 * turn that asked is blocked until it gets an answer, and an answer waiting
 * behind that turn would never arrive.
 *
 * Commands go through, so /cancel works. A secret that starts with `/` can't
 * be given this way.
 */
export const captureSecretMessages: MiddlewareFn<Context> = async (ctx, next) => {
  const message = ctx.message;
  const text = message?.text;
  if (!message || text === undefined || text.startsWith('/')) return next();

  const keyInfo = getSessionKeyFromCtx(ctx);
  const entry = keyInfo ? pending.get(keyInfo.sessionKey) : undefined;
  if (!entry || !entry.capturing || ctx.from?.id !== entry.userId) return next();

  let deleted = true;
  try {
    await ctx.api.deleteMessage(message.chat.id, message.message_id);
  } catch (err) {
    deleted = false;
    console.warn('[Secret] Could not delete a captured message:', sanitizeError(err));
  }
  entry.receive(text, deleted);
};

/** The Cancel button under a request. Registered ahead of sequentialize too. */
export async function handleSecretCallback(ctx: Context): Promise<void> {
  const [, id, action] = (ctx.callbackQuery?.data ?? '').split(':');
  const entry = [...pending.values()].find((p) => p.id === id);
  if (!entry || action !== 'cancel') {
    await ctx.answerCallbackQuery({ text: 'This request is already closed.' }).catch(() => {});
    await ctx.editMessageReplyMarkup().catch(() => {});
    return;
  }
  if (ctx.from?.id !== entry.userId) {
    await ctx.answerCallbackQuery({ text: 'Only the person asked can cancel this.' }).catch(() => {});
    return;
  }
  entry.end('user');
  await ctx.answerCallbackQuery({ text: 'Cancelled' }).catch(() => {});
}

type Raced<T> = { ok: true; value: T } | { ok: false; why: Ending };

function race<T>(work: Promise<T>, ended: Promise<Ending>): Promise<Raced<T>> {
  return Promise.race([
    work.then((value): Raced<T> => ({ ok: true, value })),
    ended.then((why): Raced<T> => ({ ok: false, why })),
  ]);
}

const refuse = (message: string): SecretResult => ({ success: false, message });

/**
 * Ask the user for a secret, and run the request's command with it. Resolves
 * once the command has run or the request has ended without a secret, with
 * what the agent should be told. The secret itself is in neither.
 */
export async function requestSecret(
  ctx: Context,
  sessionKey: string,
  req: SecretRequest,
  signal?: AbortSignal,
  deps: SecretFlowDeps = {},
): Promise<SecretResult> {
  const chat = ctx.chat;
  if (!chat) return refuse('Error: there is no Telegram chat to ask in.');
  if (chat.type !== 'private') {
    return refuse(
      'Error: secrets can only be asked for in a private chat with the bot. In a group, everyone would see the '
      + 'message before it could be deleted. Ask the user to message the bot directly, or to do this step themselves.',
    );
  }
  // In a private chat the chat's id is the user's.
  if (!isAdmin(chat.id)) {
    return refuse(
      "Error: only an admin of this bot can supply secrets, since the command runs outside TeleCoder's "
      + 'permission gate. Ask the owner of the bot to do this step.',
    );
  }
  if (pending.has(sessionKey)) {
    return refuse('Error: a secret request is already open in this chat. Wait for it to finish first.');
  }

  const where = resolveCommandCwd(req.cwd, sessionManager.getSession(sessionKey)?.workingDirectory);
  if ('error' in where) return refuse(where.error);
  const syntaxError = checkCommandSyntax(req.command);
  if (syntaxError) return refuse(`Error: the command doesn't parse, so the user wasn't asked:\n${syntaxError}`);
  let pattern: RegExp | undefined;
  if (req.pattern) {
    try {
      pattern = new RegExp(req.pattern);
    } catch (err) {
      return refuse(`Error: pattern isn't a valid regular expression: ${err instanceof Error ? err.message : err}`);
    }
  }

  const cwd = where.dir;
  const chatId = chat.id;
  const threadId = parseSessionKey(sessionKey).threadId;
  const thread = threadId !== undefined ? { message_thread_id: threadId } : {};
  const id = crypto.randomBytes(4).toString('hex');
  const waitMs = deps.waitMs ?? questionTimeoutMs();
  const minutes = Math.max(1, Math.round(waitMs / 60_000));
  const inMinutes = `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const runCommand = deps.runCommand ?? runWithSecret;

  let endWith!: (why: Ending) => void;
  const ended = new Promise<Ending>((resolve) => {
    endWith = resolve;
  });

  // Messages the middleware has taken, waiting to be read.
  const inbox: string[] = [];
  let wake: (() => void) | undefined;
  const nextText = (): Promise<string> =>
    new Promise((resolve) => {
      const take = (): void => {
        wake = undefined;
        resolve(inbox.shift()!);
      };
      if (inbox.length > 0) take();
      else wake = take;
    });

  // Only while this is true is the next message taken as a secret or a code.
  // Outside it a message is still taken out of the chat, unread: a second
  // paste of the same secret is the likeliest one to arrive then.
  let accepting = false;
  let undeleted = false;
  let toldBusy = false;

  let prompt: EntityMessage = { text: '', entities: [] };
  let messageId: number | undefined;

  const entry: PendingSecret = {
    id,
    sessionKey,
    userId: chatId,
    get capturing() {
      return messageId !== undefined;
    },
    receive: (text, deleted) => {
      if (!deleted) undeleted = true;
      if (accepting) {
        inbox.push(text);
        wake?.();
        return;
      }
      if (toldBusy) return;
      toldBusy = true;
      void ctx.api.sendMessage(
        chatId,
        "🔐 I took that message out of the chat without passing it on: while I'm busy with the secret, "
        + "nothing you send goes to Claude. Send it again when I'm done.",
        thread,
      ).catch(() => {});
    },
    end: (why) => endWith(why),
  };

  const show = async (status?: EntityMessage | string, keyboard: InlineKeyboardButton[][] = []): Promise<void> => {
    if (messageId === undefined) return;
    const message = status === undefined ? prompt : withStatus(prompt, status);
    try {
      await ctx.api.editMessageText(chatId, messageId, message.text, {
        entities: message.entities,
        reply_markup: { inline_keyboard: keyboard },
      });
    } catch {
      // Cosmetic: the agent's answer doesn't depend on the message.
    }
  };

  const undeletedWarning = "⚠️ I couldn't delete your message, so please delete it yourself.";

  const stopped = async (why: Ending): Promise<SecretResult> => {
    accepting = false;
    console.log(`[Secret] ${sessionKey}: the request for ${req.name} ended (${why})`);
    // A message that was taken but not used can still be one the user meant
    // as the secret.
    const warning = undeleted ? `\n${undeletedWarning}` : '';
    if (why === 'timeout') {
      await show(`⏱️ Nothing came within ${minutes} min, so Claude carried on without it.${warning}`);
      return {
        success: true,
        message: `The user didn't send ${req.name} within ${inMinutes}. Carry on without it, or ask again.`,
      };
    }
    if (why === 'user') {
      await show(`🚫 Cancelled.${warning}`);
      return {
        success: true,
        message: `The user cancelled the request for ${req.name}, so you don't have it. `
          + "Carry on without it, or ask them how they'd like to go on.",
      };
    }
    await show(`🚫 Claude stopped waiting for it.${warning}`);
    return { success: false, message: 'The request was withdrawn before the user answered.' };
  };

  pending.set(sessionKey, entry);
  const stopAwaiting = noteAwaitingUser(sessionKey);
  const timer = setTimeout(() => endWith('timeout'), waitMs);
  const onAbort = (): void => endWith('agent');
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) endWith('agent');
  let setup: SetupTokenLike | undefined;
  console.log(`[Secret] ${sessionKey}: asking for ${req.name} (${req.source})`);

  try {
    let link: string | undefined;
    let setupProblem: string | undefined;
    if (req.source === 'claude-setup-token') {
      try {
        setup = (deps.startSetupToken ?? (() => new SetupTokenRun()))();
        const got = await race(setup.waitForLink(LINK_TIMEOUT_MS), ended);
        if (!got.ok) return await stopped(got.why);
        link = got.value;
      } catch (err) {
        setupProblem = err instanceof Error ? err.message : String(err);
        console.warn(`[Secret] ${sessionKey}: claude setup-token didn't start: ${sanitizeError(err)}`);
        setup?.kill();
        setup = undefined;
      }
    }

    prompt = buildSecretPrompt(req, cwd, { link, setupProblem });
    let sent;
    try {
      sent = await ctx.api.sendMessage(chatId, prompt.text, {
        entities: prompt.entities,
        reply_markup: { inline_keyboard: secretKeyboard(id, link) },
        ...thread,
      });
    } catch (err) {
      if (!link) throw err;
      // Should Telegram refuse the link as a button, the one in the text
      // still works.
      console.warn(`[Secret] ${sessionKey}: sending with the sign-in button failed: ${sanitizeError(err)}`);
      sent = await ctx.api.sendMessage(chatId, prompt.text, {
        entities: prompt.entities,
        reply_markup: { inline_keyboard: secretKeyboard(id) },
        ...thread,
      });
    }
    // Both at once: the request is on screen, so a message can be an answer
    // to it from now on, and one that came in before the next line ran would
    // be taken for a second paste and dropped.
    messageId = sent.message_id;
    accepting = true;
    await deps.onPosted?.();

    let secret: string | undefined;
    let madeHere = false;
    let codes = 0;
    while (secret === undefined) {
      const got = await race(nextText(), ended);
      if (!got.ok) return await stopped(got.why);
      const text = got.value.trim();
      if (!text) continue;

      if (!setup || looksLikeOAuthToken(text)) {
        if (pattern && !pattern.test(text)) {
          await show(
            `❌ That doesn't look like ${req.name}, so I deleted it without using it. Send it again, or tap Cancel.`,
            secretKeyboard(id, link),
          );
          continue;
        }
        secret = text;
        break;
      }

      // Anything else, while claude setup-token waits, is the sign-in code.
      accepting = false;
      codes++;
      await show('⏳ Checking the code…');
      const checked = await race(setup.submitCode(text, CODE_CHECK_TIMEOUT_MS), ended);
      if (!checked.ok) return await stopped(checked.why);
      const outcome = checked.value;
      if (outcome.kind === 'token') {
        secret = outcome.token;
        madeHere = true;
        break;
      }
      if (outcome.kind === 'rejected' && outcome.link && codes < MAX_CODE_ATTEMPTS) {
        link = outcome.link;
        prompt = buildSecretPrompt(req, cwd, { link });
        await show(
          `❌ That code wasn't accepted: ${clip(outcome.reason, 300)}\n\nOpen the sign-in page again for a new code, and send me that.`,
          secretKeyboard(id, link),
        );
        accepting = true;
        continue;
      }
      console.log(`[Secret] ${sessionKey}: claude setup-token gave no token for ${req.name}`);
      await show(`❌ No token: ${clip(outcome.reason, 300)}`);
      return {
        success: false,
        message: `The user tried to make ${req.name} with claude setup-token, but it gave no token: ${outcome.reason}\n\n`
          + 'Nothing was run. Call claudegram_request_secret again to give them another go.',
      };
    }

    // The secret is in hand: from here on, nothing the user sends is one.
    accepting = false;
    clearTimeout(timer);
    setup?.kill();
    setup = undefined;
    const secretLength = secret.length;
    await show(madeHere
      ? '⏳ Token made. Running the command…'
      : `⏳ Got it, ${undeleted ? 'though I could not delete your message' : 'and deleted your message'}. Running the command…`);

    const run = await runCommand(req.command, cwd, secret);
    secret = undefined;
    const exit = describeExit(run);
    const ok = !run.timedOut && run.exitCode === 0;
    console.log(`[Secret] ${sessionKey}: ran the command for ${req.name}: ${exit}`);

    await show(statusWithOutput(
      ok ? '✅ Done: the command finished OK.' : `❌ The command failed (${exit}), and the secret wasn't kept.`,
      run.output,
      undeleted ? undeletedWarning : undefined,
    ));

    const got = madeHere
      ? `The user made ${req.name} with claude setup-token on this machine`
      : `The user sent ${req.name} (${secretLength} characters)`;
    const lines = [`${got}, and your command ran with it: ${exit}.`];
    lines.push(run.output
      ? `Output, with the secret shown as ${REDACTED}:\n${tailOf(run.output, OUTPUT_FOR_AGENT)}`
      : 'It printed nothing.');
    if (!ok) {
      lines.push('The secret was not kept. To try again, fix the command and call claudegram_request_secret again.');
    }
    if (undeleted) {
      lines.push("TeleCoder couldn't delete the user's message with the secret in it, and has asked them to delete it.");
    }
    return { success: ok, message: lines.join('\n\n') };
  } catch (err) {
    console.error(`[Secret] ${sessionKey}: the request for ${req.name} failed: ${sanitizeError(err)}`);
    await show('❌ Something went wrong here, and nothing was run.');
    return refuse(`Error: the secret request failed: ${sanitizeError(err)}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    setup?.kill();
    if (pending.get(sessionKey) === entry) pending.delete(sessionKey);
    stopAwaiting();
    await deps.onSettled?.().catch(() => {});
  }
}
