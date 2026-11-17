import * as http from 'http';
import * as net from 'net';
import type { AddressInfo } from 'net';
import type { Duplex } from 'stream';

export interface TestProxy {
  /** `http://127.0.0.1:<port>` */
  url: string;
  /** The `host:port` of every tunnel asked for, in order. */
  tunnels: string[];
  close(): Promise<void>;
}

/**
 * An HTTP proxy on localhost that opens CONNECT tunnels, as the proxy in
 * front of Telegram does. `refuseWith` makes it answer every CONNECT with
 * that status instead, as a proxy wanting a password would (407).
 */
export async function startConnectProxy({ refuseWith }: { refuseWith?: number } = {}): Promise<TestProxy> {
  const tunnels: string[] = [];
  // A tunnel's sockets are no longer the HTTP server's to close.
  const open = new Set<Duplex>();
  const track = (socket: Duplex) => {
    open.add(socket);
    socket.on('close', () => open.delete(socket));
  };
  const proxy = http.createServer((_req, res) => {
    res.statusCode = 405;
    res.end();
  });
  proxy.on('connect', (req, client, head) => {
    tunnels.push(req.url ?? '');
    track(client);
    if (refuseWith) {
      client.end(`HTTP/1.1 ${refuseWith} Refused\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    const [host, port] = (req.url ?? '').split(':');
    const upstream = net.connect(Number(port), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    track(upstream);
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
    tunnels,
    close: async () => {
      for (const socket of open) socket.destroy();
      proxy.closeAllConnections();
      await new Promise((resolve) => proxy.close(resolve));
    },
  };
}

export interface FakeBotApi {
  /** `http://127.0.0.1:<port>`, to use as the API root. */
  url: string;
  /** Every request received: its path after `/bot<token>/`, content-type and body. */
  requests: Array<{ token: string; method: string; contentType: string; body: Buffer }>;
  close(): Promise<void>;
}

/**
 * A Bot API on localhost that knows one token. getMe answers for
 * `@<username>`, `hang` never answers, and any other method answers `true`.
 * Another token gets Telegram's 401.
 */
export async function startFakeBotApi(token: string, username = 'my_coder_bot'): Promise<FakeBotApi> {
  const requests: FakeBotApi['requests'] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const [, asked = '', method = ''] = (req.url ?? '').match(/^\/bot([^/]+)\/(\w+)/) ?? [];
      requests.push({ token: asked, method, contentType: req.headers['content-type'] ?? '', body: Buffer.concat(chunks) });
      if (method === 'hang') return;
      res.setHeader('content-type', 'application/json');
      if (asked !== token) {
        res.statusCode = 401;
        res.end(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }));
      } else if (method === 'getMe') {
        res.end(JSON.stringify({ ok: true, result: { id: 7012345678, is_bot: true, first_name: 'My Coder', username } }));
      } else {
        res.end(JSON.stringify({ ok: true, result: true }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
