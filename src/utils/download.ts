import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { ReadableStream as WebReadableStream } from 'stream/web';
import { HttpsProxyAgent } from 'https-proxy-agent';
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

export interface DownloadOptions {
  /**
   * An HTTP or HTTPS proxy to fetch through. The bot passes the one its
   * requests to Telegram go through, so a file is fetched the way the API is
   * reached.
   */
  proxyUrl?: string;
}

/** What a request came back with, whichever client made it. */
interface Opened {
  status: number;
  /** Null when the response has no body. */
  body: Readable | null;
}

async function openDirect(fileUrl: string, signal: AbortSignal): Promise<Opened> {
  const res = await fetch(fileUrl, { signal, redirect: 'follow' });
  return {
    status: res.status,
    body: res.body ? Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>) : null,
  };
}

/**
 * The same request through a proxy. Node's fetch takes no proxy agent, so
 * this goes out over `http(s).get` with the agent the bot's own requests to
 * Telegram use. A redirect isn't followed: Telegram's file endpoint answers
 * with the file.
 */
function openThroughProxy(fileUrl: string, proxyUrl: string, signal: AbortSignal): Promise<Opened> {
  return new Promise((resolve, reject) => {
    const get = new URL(fileUrl).protocol === 'https:' ? https.get : http.get;
    get(fileUrl, { agent: new HttpsProxyAgent(proxyUrl), signal }, (res) => {
      resolve({ status: res.statusCode ?? 0, body: res });
    }).on('error', reject);
  });
}

async function attemptDownload(
  fileUrl: string,
  destPath: string,
  signal: AbortSignal,
  proxyUrl: string | undefined,
): Promise<void> {
  let res: Opened;
  try {
    res = proxyUrl ? await openThroughProxy(fileUrl, proxyUrl, signal) : await openDirect(fileUrl, signal);
  } catch (error) {
    // Network failure or timeout. Neither client's message carries the URL,
    // but redact anyway: this is the one place the token is in play, and a
    // proxy URL can hold a password.
    const msg = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
    throw new DownloadError(redactSecrets(msg), true);
  }

  if (res.status < 200 || res.status >= 300 || !res.body) {
    res.body?.destroy();
    throw new DownloadError(`HTTP ${res.status}`, isRetryableStatus(res.status));
  }

  try {
    await pipeline(res.body, fs.createWriteStream(destPath), { signal });
  } catch (error) {
    fs.rmSync(destPath, { force: true });
    const msg = error instanceof Error ? error.message : String(error);
    throw new DownloadError(redactSecrets(msg), true);
  }
}

/**
 * Download a file from a URL to `destPath`, through `options.proxyUrl` when
 * one is given.
 *
 * The request is made in this process, so the URL — which for Telegram files
 * embeds the bot token — never appears in a process argument list (`ps`) or in
 * an error message. Retries transient failures up to three times, two seconds
 * apart, within an overall one-minute budget; a 4xx other than 408/429 fails
 * at once.
 */
export async function downloadFileSecure(
  fileUrl: string,
  destPath: string,
  options: DownloadOptions = {},
): Promise<void> {
  if (!isValidDownloadUrl(fileUrl)) {
    throw new Error('Invalid URL for download');
  }

  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  let lastError: DownloadError | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      await attemptDownload(
        fileUrl,
        destPath,
        AbortSignal.timeout(Math.min(ATTEMPT_TIMEOUT_MS, remaining)),
        options.proxyUrl,
      );
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
