/**
 * Drives `claude setup-token` in a pty of its own, for claudegram_request_secret.
 *
 * `claude setup-token` makes a long-lived (one-year) OAuth token for a Claude
 * subscription, for a machine or an agent to run on without anyone's own
 * login. It signs in through a browser, and on a machine with no browser of
 * its own it prints a sign-in link and waits at a prompt for the code the
 * sign-in page shows. Measured on 2.1.319:
 *
 *     Browser didn't open? Use the url below to sign in (c to copy)
 *
 *     https://claude.com/cai/oauth/authorize?code=true&client_id=…
 *
 *     Paste code here if prompted >
 *
 * The link is drawn as an OSC 8 hyperlink, so the whole URL comes through in
 * the escape sequence however the terminal wraps the text. A code it doesn't
 * accept ends in `OAuth error: That code wasn't accepted. …` and `Press Enter
 * to retry.`, and Enter starts over with a fresh link. A good one prints the
 * token, by itself on a row, between "Your OAuth token (valid for 1 year):" and
 * "Store this token securely".
 *
 * Nothing here relays what the pty draws. The token is handed back to the
 * caller and nowhere else, and the one bit of screen text that does go out — a
 * reason a code was refused, or why the run ended — goes through
 * {@link redactTokens} first.
 *
 * The terminal is 500 columns wide so the token never wraps, which keeps it
 * whole on a single row for {@link findOAuthToken}. The sign-in link (about
 * 420 characters) fits too, which lets the screen stand in for the escape
 * sequence if a later version stops sending one.
 */

import { spawn, type IPty } from 'node-pty';
import headless from '@xterm/headless';
import * as os from 'os';
import { envWithoutParentSession } from '../utils/claude-env.js';
import { resolveBin } from '../utils/resolve-bin.js';

const { Terminal } = headless;
type HeadlessTerminal = InstanceType<typeof Terminal>;

const COLS = 500;
const ROWS = 50;

/** How long the screen has to stay still before it's read. */
const SETTLE_MS = 150;

/** Raw output kept for finding the sign-in link. The newest link is at the end. */
const MAX_RAW = 1024 * 1024;

/** Between typing a code and pressing Enter, as a person would. */
const TYPE_TO_ENTER_MS = 300;

/** OSC 8: ESC ] 8 ; params ; URI, ended by BEL or ESC \. */
const OSC8_LINK = /\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
const AUTHORIZE_PATH = '/oauth/authorize';
const SCREEN_LINK = /https:\/\/\S+\/oauth\/authorize\?\S+/g;

/** A Claude OAuth token, as `claude setup-token` prints it. */
const OAUTH_TOKEN = /sk-ant-oat\d+-[A-Za-z0-9_-]{20,}/;
const OAUTH_TOKEN_EXACT = /^sk-ant-oat\d+-[A-Za-z0-9_-]{20,}$/;
const OAUTH_ERROR = /OAuth error:\s*(.+)/;
const ANY_ANTHROPIC_KEY = /sk-ant-[A-Za-z0-9_-]+/g;

/**
 * Variables that would point claude at other credentials or another endpoint.
 * The bot's environment can carry any of them for its own sessions; a token
 * made for the user's subscription should come out of the same flow it would
 * in a plain terminal.
 */
const AUTH_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN'];

/** The newest sign-in link in the raw pty output, from its OSC 8 sequence. */
export function findSignInLink(raw: string): string | undefined {
  let found: string | undefined;
  for (const match of raw.matchAll(OSC8_LINK)) {
    if (match[1].includes(AUTHORIZE_PATH)) found = match[1];
  }
  return found;
}

/** The last sign-in link written out on the screen, for a version without OSC 8. */
export function findSignInLinkOnScreen(screen: string): string | undefined {
  const matches = screen.match(SCREEN_LINK);
  return matches ? matches[matches.length - 1] : undefined;
}

export function findOAuthToken(screen: string): string | undefined {
  return OAUTH_TOKEN.exec(screen)?.[0];
}

/** Why a code was refused, from the `OAuth error:` line. */
export function findOAuthError(screen: string): string | undefined {
  return OAUTH_ERROR.exec(screen)?.[1].trim() || undefined;
}

/** True when `text` is a Claude OAuth token itself, not a sign-in code. */
export function looksLikeOAuthToken(text: string): boolean {
  return OAUTH_TOKEN_EXACT.test(text.trim());
}

/** Blank out anything shaped like an Anthropic key or token. */
export function redactTokens(text: string): string {
  return text.replace(ANY_ANTHROPIC_KEY, 'sk-ant-…');
}

/**
 * The last few rows of the screen that say something, to explain how a run
 * ended. The welcome logo is block art and dots, so a row needs a word in it
 * to count.
 */
export function describeScreen(screen: string, maxLines = 4): string {
  const lines = screen
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /[A-Za-z]{3}/.test(line));
  return redactTokens(lines.slice(-maxLines).join('\n'));
}

export type CodeOutcome =
  /** The code worked and this is the token. */
  | { kind: 'token'; token: string }
  /** Refused. `link` is a fresh one to sign in with again, when one came up. */
  | { kind: 'rejected'; reason: string; link?: string }
  /** The run ended, or stopped answering, without a token. */
  | { kind: 'failed'; reason: string };

export interface SetupTokenOptions {
  /** The claude binary. Defaults to CLAUDE_BIN, or `claude` found on PATH. */
  bin?: string;
  /** Arguments; `['setup-token']` unless a test stands in for the CLI. */
  args?: string[];
  env?: NodeJS.ProcessEnv;
}

function defaultBin(): string {
  return process.env.CLAUDE_BIN || resolveBin('claude');
}

/** The environment `claude setup-token` runs in. */
export function setupTokenEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = envWithoutParentSession(base);
  for (const name of AUTH_VARS) delete env[name];
  return {
    ...env,
    TERM: 'xterm-256color',
    // The bot's own ptys pin claude's classic renderer for the same reason:
    // the fullscreen one draws on the alternate screen, and a launch can
    // switch to it without being asked.
    CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1',
  };
}

/** One run of `claude setup-token`, from the sign-in link to the token. */
export class SetupTokenRun {
  private readonly term: IPty;
  private readonly xterm: HeadlessTerminal;
  private raw = '';
  private exit: { exitCode: number; signal?: number } | undefined;
  private settleTimer: NodeJS.Timeout | undefined;
  private readonly watchers = new Set<() => void>();
  private closed = false;

  constructor(options: SetupTokenOptions = {}) {
    this.term = spawn(options.bin ?? defaultBin(), options.args ?? ['setup-token'], {
      name: 'xterm-256color',
      cols: COLS,
      rows: ROWS,
      cwd: os.homedir(),
      env: options.env ?? setupTokenEnv(),
    });
    this.xterm = new Terminal({ cols: COLS, rows: ROWS, scrollback: 200, allowProposedApi: true });

    this.term.onData((data) => {
      if (this.closed) return;
      this.raw = (this.raw + data).slice(-MAX_RAW);
      this.xterm.write(data, () => this.scheduleSettle());
    });
    this.term.onExit((exit) => {
      this.exit = exit;
      // Let the last frame land before anyone reads the screen for a reason.
      setTimeout(() => this.notify(), SETTLE_MS);
    });
  }

  private scheduleSettle(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => this.notify(), SETTLE_MS);
  }

  private notify(): void {
    for (const watcher of [...this.watchers]) watcher();
  }

  /** Everything on the terminal, scrollback included, one row per line. */
  screen(): string {
    const buffer = this.xterm.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i++) {
      lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
    }
    return lines.join('\n');
  }

  /** Keystrokes for the run, unless it's already over. */
  private type(keys: string): void {
    if (this.closed || this.exit) return;
    try {
      this.term.write(keys);
    } catch {
      // The run is ending; whatever waits on it next says so.
    }
  }

  private currentLink(): string | undefined {
    return findSignInLink(this.raw) ?? findSignInLinkOnScreen(this.screen());
  }

  private ending(): string {
    const said = describeScreen(this.screen());
    const how = this.exit?.signal ? `was stopped (signal ${this.exit.signal})` : `exited with code ${this.exit?.exitCode}`;
    return said ? `claude setup-token ${how}: ${said}` : `claude setup-token ${how}`;
  }

  /**
   * Resolve with the first thing `probe` finds, checked now and each time the
   * screen settles. Rejects when the run ends or `timeoutMs` passes first.
   */
  private waitFor<T>(probe: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const finish = (): void => {
        clearTimeout(timer);
        this.watchers.delete(check);
      };
      const check = (): void => {
        const value = probe();
        if (value !== undefined) {
          finish();
          resolve(value);
        } else if (this.exit || this.closed) {
          finish();
          reject(new Error(this.closed ? 'stopped' : this.ending()));
        }
      };
      const timer = setTimeout(() => {
        finish();
        reject(new Error(`claude setup-token showed no ${what} within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.watchers.add(check);
      check();
    });
  }

  /** The sign-in link to send the user to. */
  waitForLink(timeoutMs = 30_000): Promise<string> {
    return this.waitFor(() => this.currentLink(), timeoutMs, 'sign-in link');
  }

  /**
   * Type the code the sign-in page gave the user, and see what it gets. A
   * refused code is answered with Enter, which starts over with a new link,
   * so the user can sign in again without another run.
   */
  async submitCode(code: string, timeoutMs = 60_000): Promise<CodeOutcome> {
    if (this.exit || this.closed) return { kind: 'failed', reason: this.closed ? 'stopped' : this.ending() };

    const before = this.currentLink();
    // Control characters would be keystrokes, not part of the code.
    this.type(code.replace(/[\x00-\x1f\x7f]/g, ''));
    await new Promise((resolve) => setTimeout(resolve, TYPE_TO_ENTER_MS));
    if (this.closed) return { kind: 'failed', reason: 'stopped' };
    this.type('\r');

    let refused: string;
    try {
      type Answer = { token: string } | { error: string };
      const answer = await this.waitFor<Answer>(() => {
        const screen = this.screen();
        const token = findOAuthToken(screen);
        if (token) return { token };
        const error = findOAuthError(screen);
        return error ? { error } : undefined;
      }, timeoutMs, 'token');
      if ('token' in answer) return { kind: 'token', token: answer.token };
      refused = redactTokens(answer.error);
    } catch (err) {
      return { kind: 'failed', reason: err instanceof Error ? err.message : String(err) };
    }

    this.type('\r');
    try {
      const link = await this.waitFor(() => {
        const current = this.currentLink();
        return current && current !== before ? current : undefined;
      }, 30_000, 'new sign-in link');
      return { kind: 'rejected', reason: refused, link };
    } catch {
      return { kind: 'rejected', reason: refused };
    }
  }

  /** End the run. Safe to call more than once. */
  kill(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.notify();
    this.watchers.clear();
    if (!this.exit) {
      try {
        this.term.kill();
      } catch {
        // Already gone.
      }
    }
    this.xterm.dispose();
  }
}
