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
import type { Context } from 'grammy';

interface TelegramCtxLike {
  api?: {
    setMyName: (name: string) => Promise<unknown>;
  };
}

function getTelegramCtx(options: unknown): TelegramCtxLike | undefined {
  if (!options || typeof options !== 'object') return undefined;
  const ctx = (options as { telegramCtx?: unknown }).telegramCtx;
  if (!ctx || typeof ctx !== 'object') return undefined;
  return ctx as TelegramCtxLike;
}

// ── /mcp/set_topic ───────────────────────────────────────────────────
registerIpcHandler('/mcp/set_topic', async (turn, body) => {
  const topic = String(body.topic ?? '').trim();

  const [{ isBotNameEnabled, rateLimitedSetMyName }, { setSessionTopic }] = await Promise.all([
    import('../telegram/botname-settings.js'),
    import('../bot/handlers/command.handler.js'),
  ]);

  if (!isBotNameEnabled(turn.sessionKey)) {
    return {
      success: false,
      displayName: '',
      message: 'Dynamic bot name is disabled for this session.',
    };
  }

  const ctx = getTelegramCtx(turn.options as unknown);
  if (!ctx?.api) {
    return {
      success: false,
      displayName: '',
      message: 'No Telegram API available for this turn.',
    };
  }

  const displayName = setSessionTopic(turn.sessionKey, topic);
  try {
    // First arg is a per-bot rate-state key (any object identity works);
    // ctx.api is convenient and stable for the lifetime of the bot instance.
    await rateLimitedSetMyName(ctx.api as unknown as object, (n) => ctx.api!.setMyName(n), displayName);
  } catch (err) {
    console.error('[mcp-bridge /mcp/set_topic] setMyName failed:', err);
  }

  return {
    success: true,
    displayName,
    message: topic
      ? `Topic set to "${topic}". Bot name: ${displayName}`
      : `Topic cleared. Bot name: ${displayName}`,
  };
});

// Re-export Context so consumers (none yet, but anticipated) have it via this
// module without dragging in grammy directly.
export type { Context };
