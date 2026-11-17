import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fetchThroughProxy, findProxy } from '../../src/utils/telegram-proxy.js';
import { startConnectProxy, startFakeBotApi, type FakeBotApi, type TestProxy } from '../helpers/connect-proxy.js';

const TOKEN = '7012345678:AAHgoodgoodgoodgoodgoodgoodgoodgood1';

describe('findProxy', () => {
  const from = (env: Record<string, string>) => findProxy((setting) => env[setting]);

  it('finds none when nothing is set', () => {
    expect(from({})).toBeUndefined();
    expect(from({ TELEGRAM_PROXY_URL: '  ', HTTPS_PROXY: '' })).toBeUndefined();
  });

  it('prefers TELEGRAM_PROXY_URL, then the HTTPS variables, then the HTTP ones', () => {
    const all = { TELEGRAM_PROXY_URL: 'http://t:1', HTTPS_PROXY: 'http://s:2', https_proxy: 'http://s:3', HTTP_PROXY: 'http://h:4', http_proxy: 'http://h:5' };
    expect(from(all)).toEqual({ url: 'http://t:1', setting: 'TELEGRAM_PROXY_URL' });
    expect(from({ ...all, TELEGRAM_PROXY_URL: '' })).toEqual({ url: 'http://s:2', setting: 'HTTPS_PROXY' });
    expect(from({ https_proxy: 'http://s:3', HTTP_PROXY: 'http://h:4' })).toEqual({ url: 'http://s:3', setting: 'https_proxy' });
    expect(from({ http_proxy: ' http://h:5 ' })).toEqual({ url: 'http://h:5', setting: 'http_proxy' });
  });
});

describe('fetchThroughProxy', () => {
  let api: FakeBotApi;
  let proxy: TestProxy;

  beforeAll(async () => {
    api = await startFakeBotApi(TOKEN);
    proxy = await startConnectProxy();
  });
  afterAll(async () => {
    await proxy.close();
    await api.close();
  });

  it('sends a JSON call through the proxy and hands back the answer', async () => {
    const res = await fetchThroughProxy(proxy.url)(`${api.url}/bot${TOKEN}/getMe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ a: 1 }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toMatchObject({ ok: true, result: { username: 'my_coder_bot' } });
    expect(proxy.tunnels.at(-1)).toBe(new URL(api.url).host);
    expect(api.requests.at(-1)).toMatchObject({ method: 'getMe', contentType: 'application/json' });
    expect(api.requests.at(-1)?.body.toString()).toBe('{"a":1}');
  });

  it('sends a file upload as multipart, boundary and all', async () => {
    const form = new FormData();
    form.set('photo', '{"type":"static"}');
    form.set('picture', new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' }), 'p.jpg');
    const res = await fetchThroughProxy(proxy.url)(`${api.url}/bot${TOKEN}/setMyProfilePhoto`, { method: 'POST', body: form });
    expect(await res.json()).toEqual({ ok: true, result: true });
    const sent = api.requests.at(-1);
    const boundary = sent?.contentType.match(/^multipart\/form-data; boundary=(.+)$/)?.[1];
    expect(boundary).toBeTruthy();
    const body = sent?.body.toString('latin1') ?? '';
    expect(body).toContain(`--${boundary}`);
    expect(body).toContain('name="picture"; filename="p.jpg"');
    expect(body).toContain('\xff\xd8\xff');
  });

  it('hands back an error status as a response, not a failure', async () => {
    const res = await fetchThroughProxy(proxy.url)(`${api.url}/botWRONG/getMe`, {});
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ ok: false, description: 'Unauthorized' });
  });

  it('rejects with the reason the request was aborted for', async () => {
    const hang = `${api.url}/bot${TOKEN}/hang`;
    const cancel = new AbortController();
    const mine = new Error('changed my mind');
    setTimeout(() => cancel.abort(mine), 50);
    expect(await fetchThroughProxy(proxy.url)(hang, { signal: cancel.signal }).catch((e: unknown) => e)).toBe(mine);

    const timedOut = await fetchThroughProxy(proxy.url)(hang, { signal: AbortSignal.timeout(50) }).catch((e: Error) => e);
    expect((timedOut as Error).name).toBe('TimeoutError');

    await expect(fetchThroughProxy(proxy.url)(hang, { signal: AbortSignal.abort(mine) })).rejects.toBe(mine);
  });

  it('fails when the proxy cannot be reached or is not a URL', async () => {
    const dead = await fetchThroughProxy('http://user:hunter2@127.0.0.1:1')(`${api.url}/bot${TOKEN}/getMe`, {}).catch((e: Error) => e);
    expect((dead as Error).message).toContain('ECONNREFUSED');
    expect((dead as Error).message).not.toContain('hunter2');
    await expect(fetchThroughProxy('not a url')(`${api.url}/bot${TOKEN}/getMe`, {})).rejects.toThrow('Invalid URL');
  });
});
