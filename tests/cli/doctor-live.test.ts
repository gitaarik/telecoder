import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { checkLive } from '../../src/cli/commands/doctor.js';
import { startConnectProxy, startFakeBotApi, type FakeBotApi, type TestProxy } from '../helpers/connect-proxy.js';

const GOOD = '7012345678:AAHgoodgoodgoodgoodgoodgoodgoodgood1';
const BAD = '7012345678:AAHbadbadbadbadbadbadbadbadbadbad222';

/**
 * `telecoder doctor --live` asks Telegram about each token the way its bot
 * would reach Telegram: through the proxy, on a network that needs one.
 */
describe('doctor --live', () => {
  let api: FakeBotApi;
  let proxy: TestProxy;

  beforeAll(async () => {
    api = await startFakeBotApi(GOOD);
    proxy = await startConnectProxy();
  });
  afterAll(async () => {
    await proxy.close();
    await api.close();
  });

  it('asks Telegram directly when there is no proxy', async () => {
    expect(await checkLive(GOOD, undefined, api.url)).toEqual({
      status: 'ok', label: 'Telegram knows the token: @my_coder_bot', detail: [],
    });
    expect(proxy.tunnels).toEqual([]);
  });

  it('goes through the proxy, and says so', async () => {
    expect(await checkLive(GOOD, proxy.url, api.url)).toEqual({
      status: 'ok', label: `Telegram knows the token: @my_coder_bot (through the proxy ${proxy.url})`, detail: [],
    });
    expect(proxy.tunnels).toEqual([new URL(api.url).host]);
  });

  it('fails a token Telegram turns down, through the proxy too', async () => {
    expect(await checkLive(BAD, undefined, api.url)).toEqual({ status: 'fail', label: 'Telegram rejected the token', detail: ['Unauthorized'] });
    expect(await checkLive(BAD, proxy.url, api.url)).toEqual({ status: 'fail', label: 'Telegram rejected the token', detail: ['Unauthorized'] });
  });

  it('warns that the proxy is the problem when it is down, without its password or the token', async () => {
    const result = await checkLive(GOOD, 'http://ada:hunter2@127.0.0.1:1', api.url);
    expect(result).toEqual({
      status: 'warn',
      label: "Couldn't reach Telegram through the proxy http://<redacted>@127.0.0.1:1",
      detail: ['connect ECONNREFUSED 127.0.0.1:1', 'Check that the proxy is running and reachable.'],
    });
  });

  it('warns when the proxy answers for itself', async () => {
    const refusing = await startConnectProxy({ refuseWith: 407 });
    try {
      const result = await checkLive(GOOD, refusing.url, api.url);
      expect(result.status).toBe('warn');
      expect(result.label).toBe(`Couldn't reach Telegram through the proxy ${refusing.url}`);
      expect(result.detail?.[0]).toBe('HTTP 407, not a Bot API answer');
    } finally {
      await refusing.close();
    }
  });

  it('names the proxy setting when Telegram cannot be reached directly, without the token', async () => {
    // A port nothing listens on: the one a server just gave back.
    const gone = await startFakeBotApi(GOOD);
    await gone.close();
    const result = await checkLive(GOOD, undefined, gone.url);
    expect(result.status).toBe('warn');
    expect(result.label).toBe("Couldn't reach Telegram");
    expect(result.detail?.[0]).toContain('ECONNREFUSED');
    expect(result.detail?.[1]).toContain('set TELEGRAM_PROXY_URL to an HTTP or HTTPS proxy');
    expect(JSON.stringify(result)).not.toContain('AAHgood');
  });
});
