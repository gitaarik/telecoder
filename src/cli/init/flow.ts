/**
 * The `telecoder init` wizard, free of the terminal and the network: the
 * prompts come through a Prompter and Telegram through a TelegramClient, so the
 * tests drive the whole flow with fakes. commands/init.ts wires up the real ones.
 *
 * The steps: check the machine (doctor's checks), decide what to do with an
 * existing .env, get and check the bot token, find the owner's id by having
 * them message the bot, pick a workspace, two optional
 * features, write the file, and have the bot say hello.
 *
 * Telegram is reached through the proxy the bot would use, when there is one:
 * TELEGRAM_PROXY_URL or the usual proxy variables, from the environment or
 * the .env being edited. One from the environment is written to the .env.
 *
 * Secrets are never printed: not the token, not the Groq key, not a proxy's
 * password, not in errors (telegram.ts redacts those) and not in the summary
 * before writing.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as parseEnv } from 'dotenv';
import type { CheckResult } from '../commands/doctor.js';
import type { ServicePlan } from '../commands/service.js';
import { isWellFormedBotToken, MALFORMED_TOKEN_MESSAGE, REJECTED_TOKEN_MESSAGE } from '../../utils/bot-token.js';
import { BOT_ICON_FILENAME, botIconJpeg } from '../../utils/bot-icon.js';
import { parseIdList } from '../../utils/id-list.js';
import { redactSecrets } from '../../utils/sanitize.js';
import { findProxy } from '../../utils/telegram-proxy.js';
import { backupFile, renderEnv, updateEnvText, writeEnvFile, type EnvUpdates } from './env-file.js';
import { isAbort, type Prompter } from './prompter.js';
import {
  TelegramApiError,
  TelegramNetworkError,
  type TelegramClient,
  type TgEntity,
  type TgUser,
} from './telegram.js';

export interface InitOptions {
  /** Name of an environment variable holding the token. Never the token itself. */
  tokenEnv?: string;
  ownerId?: string;
  workspace?: string;
  /** Name of an environment variable holding a Groq API key; turns voice on. */
  groqKeyEnv?: string;
  /**
   * Give the bot the TeleCoder icon as its profile picture. Unset: yes when the
   * bot has no picture yet, and never over one it has.
   */
  icon?: boolean;
  /** Don't ask: take the defaults, replace an existing .env (backed up), remove a webhook. */
  yes?: boolean;
  /** Skip the hello from the bot at the end. */
  noTestMessage?: boolean;
}

export interface Preflight {
  node: CheckResult;
  /** doctor's checkClaude: [not found] or [version, login]. */
  claude: CheckResult[];
  /**
   * doctor's envOnlyLogin: the credential variables (CLAUDE_CODE_OAUTH_TOKEN…)
   * the login comes from, when it isn't stored credentials.
   */
  envLogin?: string[];
  nodePty: CheckResult[];
}

export interface InitDeps {
  prompter: Prompter;
  /** A client for `token`, through `proxyUrl` when the wizard found a proxy. */
  makeClient: (token: string, proxyUrl?: string) => TelegramClient;
  preflight: () => Promise<Preflight>;
  envPath: string;
  /** Whether the .env's directory is TeleCoder's own (so it may be chmod 0700). */
  ownDir: boolean;
  env: NodeJS.ProcessEnv;
  homedir: string;
  claudeBin: string;
  /** A source checkout starts with npm, not the telecoder command. */
  isCheckout?: boolean;
  /**
   * Called when the owner asks for the background service at the end. The
   * caller installs it once the wizard's prompter is closed, since the
   * installer asks its own questions on the same terminal.
   */
  requestService?: () => void;
  /**
   * What that install would set up here (systemd or launchd, lingering), said
   * before the question so the owner knows what a yes does. Without it the
   * question only names the command.
   */
  planService?: () => Promise<ServicePlan>;
  now?: () => Date;
  /** How long to wait for the owner's /start. */
  ownerWaitMs?: number;
  /** getUpdates long-poll timeout, in seconds. */
  pollTimeoutSec?: number;
}

/** Why the wizard stopped without finishing. The message is for the user. */
class Stop extends Error {
  constructor(message: string, readonly code = 1) {
    super(message);
  }
}

const ICON = { ok: '✓', warn: '!', fail: '✗' } as const;

/** What the bot answers a /start while the wizard waits for the owner's. */
export const OWNER_CAPTURED_REPLY = '👋 Got it. Back in your terminal, confirm it\'s you to finish setting up.';

/** The hello the bot sends at the end: the start command set as code. */
export function testMessage(startCommand: string): { text: string; entities: TgEntity[] } {
  const before = '✅ TeleCoder is set up. Start it with ';
  return {
    text: `${before}${startCommand}.`,
    // String length is UTF-16 units, which is what Telegram's offsets count.
    entities: [{ type: 'code', offset: before.length, length: startCommand.length }],
  };
}

export async function runInit(opts: InitOptions, rawDeps: InitDeps): Promise<number> {
  const deps = { ...rawDeps, prompter: collapseBlankLines(rawDeps.prompter) };
  const p = deps.prompter;
  const interactive = p.interactive && !opts.yes;
  let wrote = false;
  try {
    await wizard(opts, deps, interactive, () => { wrote = true; });
    return 0;
  } catch (error) {
    if (isAbort(error)) {
      p.say('');
      p.say(wrote ? 'Cancelled.' : 'Cancelled. Nothing was written.');
      return 130;
    }
    if (error instanceof Stop) {
      if (error.message) p.say(error.message);
      return error.code;
    }
    throw error;
  }
}

/**
 * The steps end with a blank line each; when one asked nothing (a flag or a
 * kept value answered it) that would leave a stack of them.
 */
function collapseBlankLines(p: Prompter): Prompter {
  let blank = true;
  const answered = <T>(pending: Promise<T>) => { blank = false; return pending; };
  return {
    interactive: p.interactive,
    signal: p.signal,
    say: (line = '') => {
      if (line === '' && blank) return;
      blank = line === '';
      p.say(line);
    },
    ask: (q, o) => answered(p.ask(q, o)),
    secret: (q) => answered(p.secret(q)),
    confirm: (q, d) => answered(p.confirm(q, d)),
    choose: (q, c, d) => answered(p.choose(q, c, d)),
    runAttached: (cmd, args) => { blank = false; return p.runAttached(cmd, args); },
    close: () => p.close(),
  };
}

async function wizard(opts: InitOptions, deps: InitDeps, interactive: boolean, markWritten: () => void): Promise<void> {
  const p = deps.prompter;
  const startCommand = deps.isCheckout ? 'npm start' : 'telecoder start';

  p.say('TeleCoder setup');
  p.say('');

  // ── 1. The machine ──────────────────────────────────────────
  const pre = await deps.preflight();
  const show = (r: CheckResult) => {
    p.say(`${ICON[r.status]} ${r.label}`);
    for (const line of r.detail ?? []) p.say(`    ${line}`);
  };
  show(pre.node);
  if (pre.node.status === 'fail') throw new Stop('\nInstall a newer Node.js, then run "telecoder init" again.');
  for (const r of pre.claude) show(r);
  if (pre.claude[0]?.status === 'fail') {
    throw new Stop('\nTeleCoder drives Claude Code, so it has to be installed first. Then run "telecoder init" again.');
  }
  if (pre.claude[1]?.status === 'fail') await offerLogin(deps, interactive);
  const claudeLogin = await stepEnvLogin(deps, interactive, pre.envLogin ?? []);
  for (const r of pre.nodePty) show(r);
  const ptyWorks = pre.nodePty.every((r) => r.status === 'ok');
  if (!ptyWorks) p.say('    TeleCoder drives Claude Code in a pty, so chats will fail until it loads.');
  p.say('');

  // ── 2. An existing .env ─────────────────────────────────────
  let existing: Record<string, string> = {};
  let existingText: string | undefined;
  if (fs.existsSync(deps.envPath)) {
    existingText = fs.readFileSync(deps.envPath, 'utf-8');
    if (!interactive) {
      if (!opts.yes) {
        throw new Stop(`${deps.envPath} already exists. Run "telecoder init" in a terminal to edit it, ` +
          'or pass --yes to replace it (the old one is kept as a backup).');
      }
      existingText = undefined;
    } else {
      p.say(`There is already a config at ${deps.envPath}.`);
      const choice = await p.choose('What do you want to do?', [
        { key: 'keep', label: 'Keep it as it is, and stop here' },
        { key: 'edit', label: 'Go through the setup with its values as the defaults' },
        { key: 'over', label: 'Start over with a new file' },
      ], 'keep');
      if (choice === 'keep') throw new Stop(`Kept ${deps.envPath} as it is. "telecoder doctor" checks it.`, 0);
      if (choice === 'edit') existing = parseEnv(existingText);
      else existingText = undefined;
    }
    const backup = backupFile(deps.envPath, deps.now?.());
    p.say(`Backed up the current file to ${backup}`);
    p.say('');
  }
  const editing = existingText !== undefined;

  // The proxy the bot would use: the environment wins over the file, as it
  // does there.
  const proxy = findProxy((setting) => deps.env[setting] ?? existing[setting]);
  // One that only the shell has is gone when a service starts the bot.
  const saveProxy = proxy !== undefined && deps.env[proxy.setting] !== undefined
    && existing.TELEGRAM_PROXY_URL !== proxy.url;
  if (proxy) {
    const from = deps.env[proxy.setting] !== undefined ? "your shell's environment" : 'the current .env';
    p.say(`Reaching Telegram through the proxy ${redactSecrets(proxy.url)} (${proxy.setting} in ${from}).`);
    if (saveProxy) {
      p.say('    A service starts TeleCoder outside your shell, so the proxy goes in the .env too, as TELEGRAM_PROXY_URL.');
    }
    p.say('');
  }

  // ── 3. Bot token ────────────────────────────────────────────
  const { token, bot, client } = await stepToken(opts, deps, interactive, editing ? existing.TELEGRAM_BOT_TOKEN : undefined, proxy?.url);
  p.say(`Connected to @${bot.username}`);
  p.say('');

  // ── 4. Owner ────────────────────────────────────────────────
  const owner = await stepOwner(opts, deps, interactive, client, bot, editing ? existing.ALLOWED_USER_IDS : undefined,
    Boolean(existing.ADMIN_USER_IDS || existing.APPROVER_USER_IDS));
  p.say('');

  // ── 5. Workspace ────────────────────────────────────────────
  const workspace = await stepWorkspace(opts, deps, interactive, editing ? existing.WORKSPACE_DIR : undefined);
  p.say('');

  // ── 6. Optional features ────────────────────────────────────
  const groqKey = await stepVoice(opts, deps, interactive, editing ? existing.GROQ_API_KEY : undefined);
  const icon = await stepIcon(opts, client, bot);
  p.say('');

  // ── 7. Write ────────────────────────────────────────────────
  const values: Record<string, string> = {
    TELEGRAM_BOT_TOKEN: token,
    ALLOWED_USER_IDS: owner.idList,
    WORKSPACE_DIR: workspace,
  };
  Object.assign(values, claudeLogin);
  if (groqKey) values.GROQ_API_KEY = groqKey;
  if (proxy && saveProxy) values.TELEGRAM_PROXY_URL = proxy.url;

  p.say(`About to write ${deps.envPath}:`);
  p.say(`  Bot              @${bot.username} (token hidden)`);
  p.say(`  Allowed users    ${owner.idList}`);
  p.say(`  Workspace        ${workspace}`);
  for (const key of Object.keys(claudeLogin)) p.say(`  Claude login     ${key}=<hidden>`);
  p.say(`  Voice            ${groqKey ? 'on (Groq key hidden)' : 'off (run telecoder init again to add it)'}`);
  if (proxy && saveProxy) p.say(`  Proxy            ${redactSecrets(proxy.url)}`);
  if (icon) p.say('  Bot picture      the TeleCoder icon (--no-icon to skip)');
  if (interactive && !await p.confirm('Write it?', true)) throw new Stop('Nothing was written.', 1);

  let content: string;
  if (existingText !== undefined) {
    const updates: EnvUpdates = {};
    for (const [key, value] of Object.entries(values)) if (existing[key] !== value) updates[key] = value;
    if (!groqKey && existing.GROQ_API_KEY) updates.GROQ_API_KEY = undefined;
    content = updateEnvText(existingText, updates);
  } else {
    content = renderEnv(values);
  }
  writeEnvFile(deps.envPath, content, { ownDir: deps.ownDir });
  markWritten();
  p.say(`✓ Wrote ${deps.envPath} (readable by you only)`);
  if (owner.otherRoles) {
    p.say('! ADMIN_USER_IDS / APPROVER_USER_IDS are set in this file: check they are still in ALLOWED_USER_IDS.');
  }

  if (icon) {
    try {
      await client.setProfilePhoto(botIconJpeg(), BOT_ICON_FILENAME);
      p.say(`✓ Gave @${bot.username} the TeleCoder icon`);
    } catch (error) {
      p.say(`! Couldn't set the bot's picture: ${describeTelegramError(error)}`);
      p.say('    The bot works without one. @BotFather can set a picture too: Edit Bot, then Edit Botpic.');
    }
  }

  // ── 9. Hello, and what next ─────────────────────────────────
  if (!opts.noTestMessage) {
    try {
      const hello = testMessage(startCommand);
      await client.sendMessage(owner.id, hello.text, hello.entities);
      p.say('✓ Sent you a test message on Telegram');
    } catch (error) {
      p.say(`! Couldn't send you a test message: ${describeTelegramError(error)}`);
      if (error instanceof TelegramApiError && error.code === 403) {
        p.say(`    Open https://t.me/${bot.username} and press Start, so the bot is allowed to message you.`);
      }
    }
  }

  p.say('');
  p.say('Now:');
  p.say(`  ${startCommand.padEnd(18)}run the bot, then message it on Telegram`);
  p.say(`  ${'telecoder doctor'.padEnd(18)}check the setup again any time`);
  // A checkout runs under pm2; the service is for npm installs.
  if (interactive && deps.requestService && !deps.isCheckout) {
    const plan = deps.planService ? await deps.planService() : undefined;
    if (plan && !plan.ready) {
      // Nothing to approve: say what stands in the way instead of asking.
      p.say('');
      p.say(plan.manager ? `! telecoder service install would set up ${plan.lines[0]}` : `! ${plan.lines[0]}`);
      for (const line of plan.lines.slice(1)) p.say(`    ${line}`);
      return;
    }
    let question = 'Keep it running in the background now (telecoder service install)?';
    if (plan) {
      p.say('');
      p.say(`telecoder service install keeps it running in the background. Here that is ${plan.lines[0]}`);
      for (const line of plan.lines.slice(1)) p.say(`  ${line}`);
      question = `Set up the ${plan.manager === 'launchd' ? 'LaunchAgent' : 'systemd service'} now?`;
    }
    if (await p.confirm(question, true)) {
      deps.requestService();
      return;
    }
  }
  p.say('Next: run `telecoder service install` to keep it running in the background.');
}

// ── Steps ─────────────────────────────────────────────────────

async function offerLogin(deps: InitDeps, interactive: boolean): Promise<void> {
  const p = deps.prompter;
  p.say('    TeleCoder answers as your Claude Code login, so it needs one. Either:');
  p.say('      - run "claude auth login" (or "claude", then /login) as the user the bot runs as, or');
  p.say('      - on a machine you won\'t sign in on, run "claude setup-token" and put the token it');
  p.say('        prints in CLAUDE_CODE_OAUTH_TOKEN; or set ANTHROPIC_API_KEY (billed per use).');
  if (!interactive) {
    p.say('    Carrying on: the bot will start without it, but can\'t answer until it has one.');
    return;
  }
  if (await p.confirm('Log in now? (runs "claude auth login")', true)) {
    const status = p.runAttached(deps.claudeBin, ['auth', 'login']);
    p.say(status === 0 ? '✓ Logged in' : '! The login didn\'t finish; carrying on. Run "claude auth login" later.');
  } else {
    p.say('    Carrying on without it.');
  }
}

/**
 * A login in the shell's environment works for the wizard and for
 * `telecoder start` from this shell, but a service starts without it. Offer
 * to keep the variables in the .env, which the bot loads. The values are
 * never printed.
 */
async function stepEnvLogin(deps: InitDeps, interactive: boolean, vars: string[]): Promise<Record<string, string>> {
  const p = deps.prompter;
  const found = vars.filter((key) => deps.env[key]?.trim());
  if (!found.length) return {};
  const names = found.join(' and ');
  p.say(`! Claude Code logs in with ${names} from your shell's environment.`);
  p.say(`    When TeleCoder runs as a service, it starts outside your shell and doesn't have ${names}, so Claude Code would be logged out.`);
  p.say(`    The wizard can put ${names} in TeleCoder's .env, so TeleCoder always has it.`);
  const save = interactive
    ? await p.confirm(`Save ${names} in the .env too (readable by you only)?`, true)
    : true;
  if (!save) {
    p.say(`    Not saving it: the bot only logs in where ${names} is set.`);
    return {};
  }
  if (!interactive) p.say(`    ${names} will go in the .env too (readable by you only), so a service can log in.`);
  return Object.fromEntries(found.map((key) => [key, (deps.env[key] as string).trim()]));
}

/** Pasted tokens come with stray whitespace or quotes more often than not. */
export function cleanToken(raw: string): string {
  return raw.trim().replace(/^(['"])(.*)\1$/, '$2').trim();
}

async function stepToken(
  opts: InitOptions,
  deps: InitDeps,
  interactive: boolean,
  current: string | undefined,
  proxyUrl: string | undefined,
): Promise<{ token: string; bot: TgUser; client: TelegramClient }> {
  const p = deps.prompter;

  const check = async (token: string) => {
    const client = deps.makeClient(token, proxyUrl);
    const bot = await client.getMe();
    return { token, bot, client };
  };

  if (opts.tokenEnv) {
    const token = cleanToken(deps.env[opts.tokenEnv] ?? '');
    if (!token) throw new Stop(`--token-env ${opts.tokenEnv}: that environment variable is empty or not set.`);
    if (!isWellFormedBotToken(token)) throw new Stop(MALFORMED_TOKEN_MESSAGE);
    try {
      return await check(token);
    } catch (error) {
      throw new Stop(describeFirstCallError(error));
    }
  }
  if (!interactive) {
    throw new Stop('No bot token: pass --token-env VAR, naming an environment variable that holds it ' +
      '(not the token itself: arguments show up in ps). Or run "telecoder init" in a terminal.');
  }

  if (current && isWellFormedBotToken(current)) {
    try {
      const found = await check(current);
      if (await p.confirm(`Keep the current token, for @${found.bot.username}?`, true)) return found;
    } catch (error) {
      p.say(`The current token doesn't work: ${describeFirstCallError(error)}`);
    }
  }

  p.say('Bot token. If you don\'t have a bot yet:');
  p.say('  1. In Telegram, open @BotFather (https://t.me/BotFather) and send /newbot.');
  p.say('  2. Pick a display name, then a username ending in "bot".');
  p.say('  3. It replies with a token like 1234567890:AAH…: copy it and paste it here.');
  for (;;) {
    const token = cleanToken(await p.secret('Bot token:'));
    if (!token) continue;
    if (!isWellFormedBotToken(token)) {
      p.say(MALFORMED_TOKEN_MESSAGE);
      continue;
    }
    for (;;) {
      try {
        return await check(token);
      } catch (error) {
        p.say(describeFirstCallError(error));
        if (error instanceof TelegramNetworkError && await p.confirm('Try again?', true)) continue;
        break;
      }
    }
  }
}

interface Owner {
  id: number;
  idList: string;
  /** The file names admins or approvers, which may no longer fit. */
  otherRoles?: boolean;
}

async function stepOwner(
  opts: InitOptions,
  deps: InitDeps,
  interactive: boolean,
  client: TelegramClient,
  bot: TgUser,
  current: string | undefined,
  hasRoles: boolean,
): Promise<Owner> {
  const p = deps.prompter;

  // Telegram doesn't deliver updates to getUpdates — or to the bot — while a
  // webhook is set, so look first.
  const webhookOk = await checkWebhook(deps, interactive, client, opts.yes ?? false);

  if (opts.ownerId !== undefined) {
    const id = parseOwnerId(opts.ownerId);
    if (typeof id === 'string') throw new Stop(`--owner-id: ${id}`);
    return { id, idList: String(id) };
  }
  if (!interactive) {
    throw new Stop('No owner: pass --owner-id with your numeric Telegram user id. Or run "telecoder init" in a terminal, ' +
      'which finds it when you message the bot.');
  }

  if (current) {
    const parsed = parseIdList('ALLOWED_USER_IDS', current);
    if (parsed.ok && parsed.ids.length && await p.confirm(`Keep the allowed users, ${parsed.ids.join(', ')}?`, true)) {
      return { id: parsed.ids[0], idList: parsed.ids.join(',') };
    }
  }
  const otherRoles = hasRoles;

  p.say('Who owns this bot: TeleCoder only answers the Telegram accounts you allow.');
  if (webhookOk) {
    const captured = await captureOwner(deps, client, bot);
    if (captured) return { id: captured, idList: String(captured), otherRoles };
  }
  for (;;) {
    const answer = await p.ask('Your numeric Telegram user id (message @userinfobot to get it):');
    const id = parseOwnerId(answer);
    if (typeof id === 'number') return { id, idList: String(id), otherRoles };
    p.say(id);
  }
}

/** A user id, or why it isn't one. */
export function parseOwnerId(raw: string): number | string {
  const trimmed = raw.trim();
  if (!trimmed) return 'Type the number, like 412345678.';
  const parsed = parseIdList('ALLOWED_USER_IDS', trimmed);
  if (!parsed.ok) return parsed.error;
  if (parsed.ids.length !== 1 || parsed.ids[0] <= 0) return 'One user id, a positive number like 412345678.';
  return parsed.ids[0];
}

async function checkWebhook(deps: InitDeps, interactive: boolean, client: TelegramClient, yes: boolean): Promise<boolean> {
  const p = deps.prompter;
  let info;
  try {
    info = await client.getWebhookInfo();
  } catch (error) {
    p.say(`! Couldn't check the bot's webhook: ${describeTelegramError(error)}`);
    return false;
  }
  if (!info.url) return true;

  p.say(`! This bot has a webhook set, to ${redactSecrets(info.url)}: Telegram is sending its messages to`);
  p.say('  another program. TeleCoder fetches them itself, which only works once the webhook is removed.');
  const remove = interactive ? await p.confirm('Remove the webhook?', false) : yes;
  if (!remove) {
    p.say('  Left it in place. TeleCoder won\'t receive messages until it is removed.');
    return false;
  }
  try {
    await client.deleteWebhook();
    p.say('✓ Removed the webhook');
    return true;
  } catch (error) {
    p.say(`! Couldn't remove it: ${describeTelegramError(error)}`);
    return false;
  }
}

function describeUser(user: TgUser): string {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || 'someone';
  return `${name}${user.username ? ` (@${user.username})` : ''}`;
}

/**
 * Wait for the owner to message the bot, and take their id from it. Typing an
 * id instead works at any point. Returns null when nothing usable arrived, for
 * the caller to ask for the id outright.
 */
async function captureOwner(deps: InitDeps, client: TelegramClient, bot: TgUser): Promise<number | null> {
  const p = deps.prompter;
  const waitMs = deps.ownerWaitMs ?? 5 * 60_000;
  const pollTimeout = deps.pollTimeoutSec ?? 30;
  const now = () => (deps.now?.() ?? new Date()).getTime();

  // Whatever is already queued predates this run, and could be anyone's:
  // skip it, so only a message sent from here on counts.
  let offset: number | undefined;
  try {
    const queued = await client.getUpdates({ timeout: 0, signal: p.signal });
    if (queued.length) offset = queued[queued.length - 1].update_id + 1;
  } catch (error) {
    if (isAbort(error)) throw error;
    p.say(`! ${describePollError(error)}`);
    return null;
  }

  p.say(`Now open https://t.me/${bot.username} and send /start, from your own account.`);
  p.say('The bot replies there, and this setup then asks you here to confirm it was you.');
  p.say(`Waiting for it, up to ${Math.round(waitMs / 60_000)} minutes. Or type your numeric id and press Enter. Ctrl+C cancels.`);
  const deadline = now() + waitMs;
  let found: number | null = null;

  while (found === null && now() < deadline) {
    const stopPoll = new AbortController();
    const stopAsk = new AbortController();
    const poll = (async () => {
      while (now() < deadline) {
        const timeout = Math.max(0, Math.min(pollTimeout, Math.ceil((deadline - now()) / 1000)));
        const updates = await client.getUpdates({
          offset, timeout, signal: AbortSignal.any([p.signal, stopPoll.signal]),
        });
        let candidate: TgUser | undefined;
        let chatId = 0;
        for (const u of updates) {
          offset = u.update_id + 1;
          const m = u.message;
          if (!candidate && m?.from && !m.from.is_bot && m.chat.type === 'private') {
            candidate = m.from;
            chatId = m.chat.id;
          }
        }
        if (candidate) {
          // Otherwise Telegram stays silent and the /start looks lost. Best
          // effort: the answer that counts is the one in the terminal.
          await client.sendMessage(chatId, OWNER_CAPTURED_REPLY).catch(() => {});
          return { kind: 'message' as const, user: candidate };
        }
      }
      return { kind: 'timeout' as const };
    })();
    const typed = p.ask('>', { signal: stopAsk.signal }).then((text) => ({ kind: 'typed' as const, text }));

    let outcome;
    try {
      outcome = await Promise.race([poll, typed]);
    } catch (error) {
      stopPoll.abort();
      stopAsk.abort();
      await Promise.allSettled([poll, typed]);
      if (isAbort(error) || p.signal.aborted) throw error;
      p.say(`! ${describePollError(error)}`);
      return null;
    }
    // Whichever lost is cancelled, and its rejection swallowed.
    if (outcome.kind === 'typed') stopPoll.abort();
    else stopAsk.abort();
    await Promise.allSettled([poll, typed]);
    if (p.signal.aborted) throw p.signal.reason;

    if (outcome.kind === 'typed') {
      const id = parseOwnerId(outcome.text);
      if (typeof id === 'number') found = id;
      else p.say(id);
    } else if (outcome.kind === 'message') {
      const user = outcome.user;
      if (await p.confirm(`Is this you: ${describeUser(user)}, id ${user.id}?`, true)) found = user.id;
      else p.say('Waiting for another message. Or type your id.');
    } else {
      p.say('No message arrived in time.');
      break;
    }
  }

  // Mark what was read as handled, or the bot's first poll replays the /start.
  if (offset !== undefined) {
    try {
      await client.getUpdates({ offset, timeout: 0 });
    } catch {
      // Harmless: the bot answers one /start twice, at worst.
    }
  }
  return found;
}

function describePollError(error: unknown): string {
  if (error instanceof TelegramApiError && error.code === 409) {
    return 'Something else is already reading this bot\'s messages: probably TeleCoder or another program ' +
      'running with the same token. Stop it, or type your id below.';
  }
  return `Couldn't wait for your message: ${describeTelegramError(error)}`;
}

async function stepWorkspace(opts: InitOptions, deps: InitDeps, interactive: boolean, current: string | undefined): Promise<string> {
  const p = deps.prompter;
  if (opts.workspace !== undefined) {
    const resolved = resolveDir(opts.workspace, deps.homedir);
    if (typeof resolved !== 'string' || !isDir(resolved)) throw new Stop(`--workspace: ${opts.workspace} is not a directory.`);
    return resolved;
  }
  const def = current ?? suggestWorkspace(deps.homedir);
  if (!interactive) return def;

  p.say('Workspace: the folder your projects are in. /project picks one of them for Claude to work in,');
  p.say('and admins can fetch files from anywhere inside it with /file.');
  for (;;) {
    const answer = await p.ask('Workspace directory:', { default: tildify(def, deps.homedir) });
    const resolved = resolveDir(answer, deps.homedir);
    if (isDir(resolved)) return resolved;
    p.say(`${resolved} is not a directory. Create it first, or pick another.`);
  }
}

/** ~/projects or the like when there is one, else the home directory. */
export function suggestWorkspace(homedir: string, exists: (p: string) => boolean = isDir): string {
  for (const name of ['projects', 'Projects', 'dev', 'code', 'src', 'repos']) {
    const dir = path.join(homedir, name);
    if (exists(dir)) return dir;
  }
  return homedir;
}

function resolveDir(input: string, homedir: string): string {
  const trimmed = input.trim();
  const expanded = trimmed === '~' ? homedir : trimmed.startsWith('~/') ? path.join(homedir, trimmed.slice(2)) : trimmed;
  return path.resolve(expanded);
}

function tildify(dir: string, homedir: string): string {
  if (dir === homedir) return '~';
  return dir.startsWith(homedir + path.sep) ? `~/${dir.slice(homedir.length + 1)}` : dir;
}

function isDir(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Whether to give the bot the TeleCoder icon. A bot without a picture gets it
 * without being asked: a picture beats a grey initial, the summary says so before
 * anything is written, and --no-icon is there for whoever disagrees. A picture
 * the bot already has is only replaced when --icon asks for it.
 */
async function stepIcon(opts: InitOptions, client: TelegramClient, bot: TgUser): Promise<boolean> {
  if (opts.icon !== undefined) return opts.icon;
  try {
    return !await client.hasProfilePhoto(bot.id);
  } catch {
    // Can't tell, so leave the picture alone.
    return false;
  }
}

async function stepVoice(opts: InitOptions, deps: InitDeps, interactive: boolean, current: string | undefined): Promise<string | undefined> {
  const p = deps.prompter;
  if (opts.groqKeyEnv) {
    const key = deps.env[opts.groqKeyEnv]?.trim();
    if (!key) throw new Stop(`--groq-key-env ${opts.groqKeyEnv}: that environment variable is empty or not set.`);
    return key;
  }
  if (!interactive) return current;
  const on = await p.confirm(
    'Optional: transcribe voice notes with Groq Whisper? Needs a Groq API key '
    + '(https://console.groq.com/keys; it has a free tier). You can turn this on later by running telecoder init again.',
    Boolean(current),
  );
  if (!on) return undefined;
  if (current && await p.confirm('Keep the current Groq key?', true)) return current;
  for (;;) {
    const key = (await p.secret('Groq API key:')).trim();
    if (key) {
      if (!key.startsWith('gsk_')) p.say('! Groq keys usually start with gsk_; using it anyway.');
      return key;
    }
  }
}

/** One sentence about a failed Bot API call, in the wording the bot itself uses. */
export function describeTelegramError(error: unknown): string {
  if (error instanceof TelegramApiError) {
    if (error.method === 'getMe' && (error.code === 401 || error.code === 404)) return REJECTED_TOKEN_MESSAGE;
    return `Telegram said: ${error.description}`;
  }
  if (error instanceof TelegramNetworkError) {
    if (error.proxy) {
      return `Couldn't reach api.telegram.org through the proxy ${error.proxy} (${error.message}). ` +
        'Check that the proxy is running and reachable, and try again.';
    }
    return `Couldn't reach api.telegram.org (${error.message}). Check the network connection, and try again.`;
  }
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

/**
 * The same for the wizard's first call to Telegram, the token check. A
 * network failure there may mean Telegram is blocked on this network, so it
 * names the setting that gets around that, as the bot's own startup check does.
 */
export function describeFirstCallError(error: unknown): string {
  const said = describeTelegramError(error);
  if (!(error instanceof TelegramNetworkError) || error.proxy) return said;
  return `${said} If Telegram is blocked on this network, run the wizard with TELEGRAM_PROXY_URL ` +
    'set to an HTTP or HTTPS proxy (e.g. http://127.0.0.1:8080).';
}
