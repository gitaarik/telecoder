/**
 * IPC handlers that bridge the standalone MCP subprocess back into the main
 * bot process. The MCP subprocess (src/bin/mcp-server.ts) handles tool
 * registrations and JSON-RPC stdio with claude; the tool implementations that
 * need bot-side context (Telegram API, session state, …) POST to the loopback
 * IPC server, which dispatches to handlers registered here.
 *
 * All imports of bot/handlers/* are lazy to avoid circular dependencies:
 *   bot/handlers/command.handler → providers/provider-router → providers/claude-provider
 *     → claude/pty-provider → claude/mcp-bridge → (here)
 * Eager imports of command.handler would close the loop and TypeScript would
 * resolve some of the exports to `undefined` at module load.
 *
 * Side-effect module: importing it registers the handlers. PtyProvider does so
 * at module load so the IPC server has them ready before any MCP request
 * arrives.
 */

import { registerIpcHandler } from './ipc-server.js';

// ── /mcp/set_topic ───────────────────────────────────────────────────
registerIpcHandler('/mcp/set_topic', async (turn, body) => {
  const topic = String(body.topic ?? '').trim();

  // Topic now lives in the status line, not the Telegram bot name, so
  // setSessionTopic is the only thing we do here — no setMyName call.
  // (The persisted topic survives restarts and is what the status-line
  // renderer reads.)
  const { setSessionTopic } = await import('../bot/handlers/command.handler.js');
  setSessionTopic(turn.sessionKey, topic);

  return {
    success: true,
    message: topic ? `Topic set to "${topic}".` : 'Topic cleared.',
  };
});
