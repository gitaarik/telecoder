import * as http from 'http';
import type { AgentOptions } from '../providers/types.js';

/**
 * Loopback HTTP server used by:
 *  - hook commands spawned by an interactive `claude` process under PtyProvider,
 *    which POST hook payloads (PreToolUse / PostToolUse / Stop / …) here so the
 *    main bot can drive its verbose UI off them.
 *  - the standalone MCP subprocess (bin/mcp-server.ts), which routes tools that
 *    need Telegram-side context (send_file, ask_user, set_topic, …) through here.
 *
 * The server is bound to 127.0.0.1 only. Port is auto-picked at startup unless
 * CLAUDEGRAM_IPC_PORT is set, and surfaced via getIpcPort() / getIpcUrl() so the
 * spawned subprocesses can be told where to reach us.
 *
 * Dispatch model: producers POST to /<category>/<name> (e.g. /hook/preToolUse,
 * /mcp/send_file). The category/name combo is the handler key. Handlers register
 * themselves at module load via registerIpcHandler — keeping the wiring close to
 * the producer rather than centralized here.
 */

export interface ActiveTurn {
  /** The bot's session key (chatId or chatId:threadId). */
  sessionKey: string;
  /** AgentOptions for the in-flight turn; drives the bot's verbose UI callbacks. */
  options: AgentOptions;
  /**
   * Invoked when claude's Stop hook fires. PtyProvider sets this so the hook
   * handler in this module can trigger end-of-turn resolution without needing
   * to know about pty internals.
   */
  onClaudeStop?: () => void;
  /**
   * Bumped on PreToolUse, decremented on PostToolUse/Failure. PtyProvider uses
   * this to refuse the idle-fallback end-of-turn while a tool is still in
   * flight (e.g. claudegram_ask_user can block for minutes waiting on a button
   * tap; otherwise we'd resolve the turn long before the tool returns).
   */
  onToolStart?: () => void;
  onToolEnd?: () => void;
}

const activeTurns = new Map<string, ActiveTurn>();

export function registerActiveTurn(claudeSessionId: string, turn: ActiveTurn): void {
  activeTurns.set(claudeSessionId, turn);
}

export function unregisterActiveTurn(claudeSessionId: string): void {
  activeTurns.delete(claudeSessionId);
}

export function getActiveTurn(claudeSessionId: string): ActiveTurn | undefined {
  return activeTurns.get(claudeSessionId);
}

export type IpcHandler = (turn: ActiveTurn, body: Record<string, unknown>) => Promise<unknown> | unknown;

const handlers = new Map<string, IpcHandler>();

export function registerIpcHandler(path: string, fn: IpcHandler): void {
  if (handlers.has(path)) {
    console.warn(`[IPC] Replacing existing handler for ${path}`);
  }
  handlers.set(path, fn);
}

let ipcPort: number | null = null;
let ipcServerInstance: http.Server | null = null;

export function getIpcPort(): number {
  if (ipcPort === null) {
    throw new Error('IPC server has not started yet — call startIpcServer() first');
  }
  return ipcPort;
}

export function getIpcUrl(): string {
  return `http://127.0.0.1:${getIpcPort()}`;
}

function extractSessionId(body: Record<string, unknown>, req: http.IncomingMessage): string | undefined {
  // Claude's hook payloads use snake_case `session_id`. MCP bridge calls pass
  // it explicitly in the same field for consistency.
  const fromBody = typeof body.session_id === 'string' ? body.session_id : undefined;
  if (fromBody) return fromBody;
  const fromHeader = req.headers['x-telecoder-session-id'];
  if (typeof fromHeader === 'string') return fromHeader;
  return undefined;
}

export async function startIpcServer(): Promise<{ port: number }> {
  if (ipcServerInstance) return { port: getIpcPort() };

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'method not allowed' }));
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      const path = (req.url || '/').split('?')[0];

      let payload: Record<string, unknown>;
      try {
        payload = body ? JSON.parse(body) : {};
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid JSON body' }));
        return;
      }

      const handler = handlers.get(path);
      if (!handler) {
        // 404 is intentional — callers can probe for endpoint availability.
        // Hooks ignore body so this won't block claude either way.
        console.warn(`[IPC] No handler for ${path}`);
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'no handler', path }));
        return;
      }

      const sessionId = extractSessionId(payload, req);
      const turn = sessionId ? activeTurns.get(sessionId) : undefined;
      if (!turn) {
        // Don't surface as an error to the caller — hooks that fail noisily
        // can block claude. Just log and ack.
        console.warn(`[IPC] ${path} received with no active turn (sessionId=${sessionId ?? 'missing'})`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ignored: true }));
        return;
      }

      try {
        const result = await handler(turn, payload);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result ?? { ok: true }));
      } catch (err) {
        console.error(`[IPC] Handler ${path} threw:`, err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    });
  });

  // Long-poll friendly: claudegram_ask_user can hold a request open for up to
  // 10 min waiting on a user button tap, and Node's default requestTimeout
  // (5 min in Node 18+) would otherwise kill the connection mid-wait. This
  // server is bound to 127.0.0.1 only, so disabling the cap doesn't expose
  // anything to the network.
  server.requestTimeout = 0;
  server.headersTimeout = 0;

  const envPort = process.env.CLAUDEGRAM_IPC_PORT
    ? parseInt(process.env.CLAUDEGRAM_IPC_PORT, 10)
    : 0;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(envPort, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        ipcPort = addr.port;
        console.log(`[IPC] Listening on http://127.0.0.1:${addr.port}`);
        resolve();
      } else {
        reject(new Error('Failed to determine IPC port from server.address()'));
      }
    });
  });

  ipcServerInstance = server;
  return { port: getIpcPort() };
}
