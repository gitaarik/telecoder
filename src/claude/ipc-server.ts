
import * as http from 'http';

const PORT = 8787;

export function startIpcServer() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      console.log(`[IPC Server] Received ${req.method} ${req.url}`);
      if (body) {
        try {
          const parsedBody = JSON.parse(body);
          console.log('[IPC Server] Request Body:', parsedBody);
        } catch (e) {
          console.error('[IPC Server] Failed to parse JSON body:', body);
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', message: 'Request received' }));
    });
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[IPC Server] Listening on http://127.0.0.1:${PORT}`);
  });

  return server;
}
