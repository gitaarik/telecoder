/**
 * Checking the Telegram bot token before anything is done with it.
 *
 * Kept free of config imports, like id-list.ts, so config.ts can use it and
 * tests can call it directly.
 *
 * Two failures used to reach the user as a grammY stack trace — `Fatal error:
 * GrammyError: Call to 'getMe' failed! (404: Not Found)` — after the IPC server
 * had already started. A value that can't be a token at all (the .env.example
 * placeholder, a half-pasted line) is now caught by its shape when the config
 * is read. One that has the right shape but that Telegram turns down is caught
 * by a getMe made before any other service starts, and described here.
 */

import { GrammyError, HttpError } from 'grammy';
import { redactSecrets } from './sanitize.js';

/**
 * What @BotFather hands out: the bot's numeric id, a colon, and a secret of
 * 35 characters from the URL-safe base64 alphabet. 30 rather than 35 leaves
 * room for Telegram changing the length without letting a placeholder through.
 */
export const BOT_TOKEN_FORMAT = /^\d+:[A-Za-z0-9_-]{30,}$/;

export function isWellFormedBotToken(token: string): boolean {
  return BOT_TOKEN_FORMAT.test(token);
}

/** The config error for a token with the wrong shape. Never includes the token. */
export const MALFORMED_TOKEN_MESSAGE =
  "TELEGRAM_BOT_TOKEN doesn't look like a bot token. A token from @BotFather is the bot's number, " +
  'a colon, and about 35 letters, digits, - and _ (like 1234567890:AAH...). Check that the whole token ' +
  'was pasted, with no spaces or quotes around it.';

export const REJECTED_TOKEN_MESSAGE =
  'TELEGRAM_BOT_TOKEN was rejected by Telegram — get a fresh one from @BotFather (/mybots → API Token).';

/** Why a startup getMe failed, and whether trying again could help. */
export interface TokenCheckFailure {
  message: string;
  /** True when the token itself is the problem, so restarting can't fix it. */
  fatal: boolean;
}

/**
 * Describe a failed getMe for the person running the bot.
 *
 * 401 and 404 are what Telegram answers for a revoked or made-up token. A
 * network failure is the other common first-run problem — Telegram is blocked
 * on some networks — and is worth naming as such, with the setting that works
 * around it. Everything is passed through redactSecrets: grammY puts the
 * request URL, token included, into some of its messages.
 */
export function describeTokenCheckFailure(err: unknown, proxyUrl?: string): TokenCheckFailure {
  if (err instanceof GrammyError) {
    if (err.error_code === 401 || err.error_code === 404) {
      return { message: REJECTED_TOKEN_MESSAGE, fatal: true };
    }
    return {
      message: redactSecrets(
        `Telegram answered the startup check with an error (${err.error_code}: ${err.description}).`
      ),
      fatal: false,
    };
  }

  const reason = err instanceof HttpError
    ? describeCause(err.error) ?? err.message
    : err instanceof Error ? err.message : String(err);
  const via = proxyUrl ? ` through the proxy ${redactSecrets(proxyUrl)}` : '';
  const hint = proxyUrl
    ? 'Check that the proxy is running and reachable.'
    : 'Check the network connection. If Telegram is blocked on this network, set TELEGRAM_PROXY_URL ' +
      '(e.g. socks5://127.0.0.1:1080 or http://proxy:8080).';
  return {
    message: redactSecrets(`Couldn't reach api.telegram.org${via} (${reason}). ${hint}`),
    fatal: false,
  };
}

/** The innermost useful reason from a fetch failure: ENOTFOUND beats "fetch failed". */
function describeCause(error: unknown): string | undefined {
  let current: unknown = error;
  let best: string | undefined;
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    // node-fetch says "request to <url> failed, reason: <why>"; the why is
    // the part worth reading, and the URL carries the token.
    best = current.message.match(/reason: (.+)$/)?.[1] ?? current.message;
    current = (current as { cause?: unknown }).cause;
  }
  return best;
}
