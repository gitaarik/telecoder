import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { downloadFileSecure, isValidDownloadUrl, getTelegramFileUrl } from '../../src/utils/download.js';
import { startConnectProxy, type TestProxy } from '../helpers/connect-proxy.js';

const TOKEN = '1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ';

describe('isValidDownloadUrl', () => {
  it('accepts http and https', () => {
    expect(isValidDownloadUrl('https://api.telegram.org/file/botX/a.jpg')).toBe(true);
    expect(isValidDownloadUrl('http://127.0.0.1:8081/file/botX/a.jpg')).toBe(true);
  });

  it('rejects other schemes, garbage and control characters', () => {
    expect(isValidDownloadUrl('file:///etc/passwd')).toBe(false);
    expect(isValidDownloadUrl('ftp://example.com/x')).toBe(false);
    expect(isValidDownloadUrl('not a url')).toBe(false);
    expect(isValidDownloadUrl('https://example.com/a\nHost: evil')).toBe(false);
  });
});

describe('downloadFileSecure', () => {
  let server: http.Server;
  let base: string;
  const hits: Record<string, number> = {};
  let dir: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = req.url ?? '';
      hits[url] = (hits[url] ?? 0) + 1;
      if (url.endsWith('/ok.txt')) {
        res.end('hello');
      } else if (url.endsWith('/flaky.txt') && hits[url] === 1) {
        res.statusCode = 503;
        res.end();
      } else if (url.endsWith('/flaky.txt')) {
        res.end('second time');
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-test-'));
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes the body to the destination', async () => {
    const dest = path.join(dir, 'ok.txt');
    await downloadFileSecure(`${base}/file/bot${TOKEN}/ok.txt`, dest);
    expect(fs.readFileSync(dest, 'utf8')).toBe('hello');
  });

  it('retries a server error', async () => {
    const dest = path.join(dir, 'flaky.txt');
    await downloadFileSecure(`${base}/file/bot${TOKEN}/flaky.txt`, dest);
    expect(fs.readFileSync(dest, 'utf8')).toBe('second time');
    expect(hits[`/file/bot${TOKEN}/flaky.txt`]).toBe(2);
  }, 10_000);

  it('fails a 404 at once, without the token in the error', async () => {
    const url = `${base}/file/bot${TOKEN}/missing.txt`;
    const err = await downloadFileSecure(url, path.join(dir, 'missing.txt')).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('Failed to download file: HTTP 404');
    expect(hits[`/file/bot${TOKEN}/missing.txt`]).toBe(1);
  });

  it('rejects an invalid URL before any request', async () => {
    await expect(downloadFileSecure('file:///etc/passwd', path.join(dir, 'x'))).rejects.toThrow('Invalid URL');
  });

  it('builds Telegram file URLs', () => {
    expect(getTelegramFileUrl('T', 'a/b.jpg')).toBe('https://api.telegram.org/file/botT/a/b.jpg');
  });

  // A network that blocks Telegram reaches it through a proxy, and a file sent
  // to the bot has to come the same way as the API calls do.
  describe('through a proxy', () => {
    let proxy: TestProxy;
    let proxyUrl: string;

    beforeAll(async () => {
      proxy = await startConnectProxy();
      proxyUrl = proxy.url;
    });

    afterAll(() => proxy.close());

    it('fetches the file through it', async () => {
      const dest = path.join(dir, 'proxied.txt');
      const before = hits[`/file/bot${TOKEN}/ok.txt`] ?? 0;
      await downloadFileSecure(`${base}/file/bot${TOKEN}/ok.txt`, dest, { proxyUrl });
      expect(fs.readFileSync(dest, 'utf8')).toBe('hello');
      expect(proxy.tunnels).toEqual([new URL(base).host]);
      expect(hits[`/file/bot${TOKEN}/ok.txt`]).toBe(before + 1);
    });

    it('fails a 404 at once, without the token in the error', async () => {
      const url = `${base}/file/bot${TOKEN}/missing-proxied.txt`;
      const err = await downloadFileSecure(url, path.join(dir, 'missing-proxied.txt'), { proxyUrl }).catch((e: Error) => e);
      expect((err as Error).message).toBe('Failed to download file: HTTP 404');
      expect(hits[`/file/bot${TOKEN}/missing-proxied.txt`]).toBe(1);
    });

    it('says so when the proxy cannot be reached, without its password', async () => {
      // Port 1 refuses at once, so this takes the three retries: six seconds.
      const dead = 'http://user:hunter2@127.0.0.1:1';
      const err = await downloadFileSecure(`${base}/file/bot${TOKEN}/ok.txt`, path.join(dir, 'dead.txt'), { proxyUrl: dead })
        .catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/^Failed to download file: /);
      expect((err as Error).message).not.toContain('hunter2');
      expect((err as Error).message).not.toContain(TOKEN);
    }, 15_000);
  });
});
