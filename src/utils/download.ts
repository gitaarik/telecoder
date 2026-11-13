import * as fs from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { ReadableStream as WebReadableStream } from 'stream/web';
import { redactSecrets } from './sanitize.js';

/** Attempts per download: one try plus three retries, as curl's `--retry 3` did. */
const MAX_ATTEMPTS = 4;
/** Pause between attempts. */
const RETRY_DELAY_MS = 2_000;
/** Ceiling on a single attempt, connect through last byte. */
const ATTEMPT_TIMEOUT_MS = 30_000;
/** Ceiling on the whole download, retries included. */
const TOTAL_TIMEOUT_MS = 60_000;

/**
 * Is this URL safe to download from?
 *
 * Only http(s), and nothing that could smuggle a second line into a request or
 * a log: no CR, LF or NUL. Telegram file URLs are https; plain http is kept
 * for a local Bot API server, which listens on localhost.
 */
export function isValidDownloadUrl(url: string): boolean {
  if (typeof url !== 'string' || /[\r\n\0]/.test(url)) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:' || parsed.protocol === 'http:';
}

/** An HTTP status worth retrying: server trouble, rate limits, timeouts. */
function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429 || status === 408;
}

class DownloadError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function attemptDownload(fileUrl: string, destPath: string, signal: AbortSignal): Promise<void> {
  let res: Response;
  try {
    res = await fetch(fileUrl, { signal, redirect: 'follow' });
  } catch (error) {
    // Network failure or timeout. The message from undici never carries the
    // URL, but redact anyway: this is the one place the token is in play.
    const msg = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
    throw new DownloadError(redactSecrets(msg), true);
  }

  if (!res.ok || !res.body) {
    // Drain so the connection can be reused; ignore failures doing so.
    await res.body?.cancel().catch(() => {});
    throw new DownloadError(`HTTP ${res.status}`, isRetryableStatus(res.status));
  }

  try {
    await pipeline(
      Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>),
      fs.createWriteStream(destPath),
    );
  } catch (error) {
    fs.rmSync(destPath, { force: true });
    const msg = error instanceof Error ? error.message : String(error);
    throw new DownloadError(redactSecrets(msg), true);
  }
}

/**
 * Download a file from a URL to `destPath`.
 *
 * Uses Node's own fetch, so the URL — which for Telegram files embeds the bot
 * token — never appears in a process argument list (`ps`) or in an error
 * message. Retries transient failures up to three times, two seconds apart,
 * within an overall one-minute budget; a 4xx other than 408/429 fails at once.
 */
export async function downloadFileSecure(fileUrl: string, destPath: string): Promise<void> {
  if (!isValidDownloadUrl(fileUrl)) {
    throw new Error('Invalid URL for download');
  }

  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  let lastError: DownloadError | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      await attemptDownload(fileUrl, destPath, AbortSignal.timeout(Math.min(ATTEMPT_TIMEOUT_MS, remaining)));
      return;
    } catch (error) {
      lastError = error instanceof DownloadError ? error : new DownloadError(redactSecrets(String(error)), false);
      if (!lastError.retryable || attempt === MAX_ATTEMPTS) break;
      if (deadline - Date.now() <= RETRY_DELAY_MS) break;
      await sleep(RETRY_DELAY_MS);
    }
  }

  throw new Error(`Failed to download file: ${lastError?.message ?? 'timed out'}`);
}

/**
 * Build a Telegram file download URL from the bot token and file path.
 * The result contains the token: pass it to downloadFileSecure, never log it.
 */
export function getTelegramFileUrl(botToken: string, filePath: string): string {
  return `https://api.telegram.org/file/bot${botToken}/${filePath}`;
}
