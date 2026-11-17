/**
 * Finding the proxy for requests to Telegram, and making a request through
 * it, without the bot's config module.
 *
 * The bot itself gives the proxy to grammY (telegram/client-options.ts).
 * `telecoder init` runs before there is a config, and `telecoder doctor` reads
 * the .env itself, so both make their few Bot API calls through here.
 */

import * as http from 'http';
import * as https from 'https';
import { HttpsProxyAgent } from 'https-proxy-agent';

/** Where the proxy is read from. The first one set wins. */
export const PROXY_SETTINGS = ['TELEGRAM_PROXY_URL', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'] as const;

export interface FoundProxy {
  url: string;
  /** The setting it came from, one of PROXY_SETTINGS. */
  setting: string;
}

/** The proxy for requests to Telegram, given how to read a setting. */
export function findProxy(lookup: (setting: string) => string | undefined): FoundProxy | undefined {
  for (const setting of PROXY_SETTINGS) {
    const url = lookup(setting)?.trim();
    if (url) return { url, setting };
  }
  return undefined;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * A fetch that goes through `proxyUrl`, an HTTP or HTTPS proxy.
 *
 * Node's own fetch takes no proxy agent, so the request goes out over
 * `http(s).request` with the agent the bot's requests to Telegram use. The
 * answer is read whole before the promise settles, which suits what this is
 * for: Bot API calls, a few KB each way. Redirects aren't followed. A request
 * that is aborted rejects with the signal's reason, as fetch does.
 */
export function fetchThroughProxy(proxyUrl: string): FetchLike {
  return async (url, init) => {
    const { signal, ...rest } = init;
    // Request works out the body and its content-type as fetch would, a
    // FormData's multipart boundary included.
    const request = new Request(url, rest);
    const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
    const headers: Record<string, string> = Object.fromEntries(request.headers);
    if (body) headers['content-length'] = String(body.length);
    signal?.throwIfAborted();
    const agent = new HttpsProxyAgent(proxyUrl);

    return new Promise<Response>((resolve, reject) => {
      const fail = (error: unknown) => reject(signal?.aborted ? signal.reason ?? error : error);
      const send = new URL(url).protocol === 'https:' ? https.request : http.request;
      const req = send(url, { method: request.method, headers, agent, signal: signal ?? undefined }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', fail);
        res.on('end', () => {
          const answered = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            for (const one of Array.isArray(value) ? value : value === undefined ? [] : [value]) answered.append(name, one);
          }
          const text = Buffer.concat(chunks);
          try {
            // A status that carries no body (204, 304) refuses even an empty one.
            resolve(new Response(text.length ? text : null, { status: res.statusCode, headers: answered }));
          } catch (error) {
            reject(error);
          }
        });
      });
      req.on('error', fail);
      req.end(body);
    });
  };
}
