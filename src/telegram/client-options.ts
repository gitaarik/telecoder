/**
 * How the bot reaches api.telegram.org: the proxy, if any, and the timeout.
 *
 * Shared by the bot itself, the token check that runs before it is built
 * (startup/verify-token.ts) and the download of a file sent to the bot, so a
 * bot behind a proxy does all three through that same proxy instead of
 * failing on a direct connection.
 */

import { HttpsProxyAgent } from 'https-proxy-agent';
import type { ApiClientOptions } from 'grammy';
import { config } from '../config.js';

/** TELEGRAM_PROXY_URL, falling back to the usual proxy variables. */
export function telegramProxyUrl(): string | undefined {
  return config.TELEGRAM_PROXY_URL
    || process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy
    || undefined;
}

export function telegramClientOptions(): ApiClientOptions {
  const proxyUrl = telegramProxyUrl();
  return {
    // Default is 500s which causes long hangs on network interruptions.
    // 60s is enough for long polling (30s) + file uploads while recovering
    // from stuck connections much faster.
    timeoutSeconds: 60,
    baseFetchConfig: proxyUrl ? { agent: new HttpsProxyAgent(proxyUrl) } : undefined,
  };
}
