/**
 * Recognising "Claude Code isn't logged in", and saying so in the chat.
 *
 * On a machine where nobody has signed in, the CLI answers every prompt with
 * `Not logged in · Please run /login`, which relayed as it is tells the person
 * on their phone to run a command they can't. A fresh install doesn't even
 * get that far: the interactive CLI opens its first-run onboarding (theme
 * picker, then "Select login method"), which is no place to relay to a chat —
 * signing in wants a browser on, or a terminal at, the bot's machine.
 *
 * Kept free of config imports so tests can call it directly.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const CLAUDE_NOT_LOGGED_IN_REPLY =
  "Claude Code on the bot's machine isn't logged in. On that machine run `claude` and /login " +
  '(or `claude setup-token` for a long-lived token), then try again.';

/**
 * Error text that means the CLI has no usable credentials. Matched only
 * against errors, never against a reply — a reply that discusses API keys is
 * not a failed login.
 */
const AUTH_ERROR_PATTERNS: RegExp[] = [
  /\bNot logged in\b/i,
  /Please run \/login/i,
  /Invalid API key/i,
  /invalid x-api-key/i,
  /authentication_error/i,
  /authentication_failed/i,
  /OAuth token (?:has expired|has been revoked|is invalid)/i,
  /Invalid bearer token/i,
  /API Error:\s*401\b/i,
];

export function isClaudeAuthError(text: string | undefined): boolean {
  if (!text) return false;
  if (text.includes(CLAUDE_NOT_LOGGED_IN_REPLY)) return true;
  return AUTH_ERROR_PATTERNS.some((re) => re.test(text));
}

export const CLAUDE_ONBOARDING_REPLY =
  "Claude Code on the bot's machine hasn't been set up yet: it is waiting at its first-run screens. " +
  'On that machine run `claude` once, finish the setup (and /login if it asks), then try again.';

/**
 * What the interactive CLI is showing, when it is something only a person at
 * the bot's machine can get past: the login-method menu, the sign-in link and
 * the in-session "Not logged in" notice are 'login'; the first-run theme
 * picker is 'onboarding' — it comes before the login question, and may also
 * show for a token-only setup that has never run `claude` interactively.
 * Measured on 2.1.280 with an empty HOME.
 */
export function claudeSetupScreen(screenText: string): 'login' | 'onboarding' | undefined {
  if (
    /Select login method/i.test(screenText)
    || /Paste code here if prompted/i.test(screenText)
    || /Not logged in · Please run \/login/i.test(screenText)
  ) {
    return 'login';
  }
  if (/Choose the text style that looks best with your terminal/i.test(screenText)) return 'onboarding';
  return undefined;
}

/** Thrown when a turn can't run because the CLI isn't signed in or set up. */
export class ClaudeNotLoggedInError extends Error {
  constructor(kind: 'login' | 'onboarding' = 'login') {
    super(kind === 'login' ? CLAUDE_NOT_LOGGED_IN_REPLY : CLAUDE_ONBOARDING_REPLY);
    this.name = 'ClaudeNotLoggedInError';
  }
}

/**
 * The chat reply for a turn that failed with `error`: the login message for
 * any auth failure, otherwise the usual `❌ Error: …`.
 */
export function turnErrorReply(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown error';
  if (error instanceof ClaudeNotLoggedInError) return `🔑 ${message}`;
  if (isClaudeAuthError(message)) return `🔑 ${CLAUDE_NOT_LOGGED_IN_REPLY}`;
  return `❌ Error: ${message}`;
}

export interface CredentialProbe {
  env: Record<string, string | undefined>;
  home: string;
  platform: NodeJS.Platform;
  exists: (file: string) => boolean;
}

/**
 * Whether Claude Code looks signed in, judged without starting it or spending
 * a token. 'unknown' where the answer can't be read from the filesystem: macOS
 * keeps the login in the keychain, not in a file.
 *
 * Only ever a warning. A false "no" here costs a log line; refusing to start
 * on it would lock out a setup this can't see (a keychain, a helper script).
 */
export function claudeCredentialsLookPresent(probe: CredentialProbe): 'yes' | 'no' | 'unknown' {
  const { env } = probe;
  const set = (key: string) => !!env[key]?.trim();
  if (
    set('ANTHROPIC_API_KEY') || set('CLAUDE_CODE_OAUTH_TOKEN') || set('ANTHROPIC_AUTH_TOKEN')
    || set('CLAUDE_CODE_USE_BEDROCK') || set('CLAUDE_CODE_USE_VERTEX') || set('CLAUDE_CODE_USE_FOUNDRY')
  ) {
    return 'yes';
  }
  const configDir = env.CLAUDE_CONFIG_DIR?.trim() || path.join(probe.home, '.claude');
  if (probe.exists(path.join(configDir, '.credentials.json'))) return 'yes';
  if (probe.platform === 'darwin') return 'unknown';
  return 'no';
}

/** Log a warning at startup if Claude Code doesn't look signed in. */
export function warnIfClaudeNotLoggedIn(): void {
  const verdict = claudeCredentialsLookPresent({
    env: process.env,
    home: os.homedir(),
    platform: process.platform,
    exists: (file) => fs.existsSync(file),
  });
  if (verdict !== 'no') return;
  console.warn(
    '⚠️  Claude Code doesn\'t look logged in on this machine: there is no ~/.claude/.credentials.json, ' +
    'and none of ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN is set. Until it is, every message will ' +
    'fail. Run `claude` and /login (or `claude setup-token` and put the token in CLAUDE_CODE_OAUTH_TOKEN). ' +
    'Starting anyway, in case the login lives somewhere this check can\'t see.'
  );
}
