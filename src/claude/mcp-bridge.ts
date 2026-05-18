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

import * as fs from 'fs';
import * as path from 'path';
import { InputFile, type Context } from 'grammy';
import { registerIpcHandler } from './ipc-server.js';
import { sessionManager } from './session-manager.js';
import { getWorkspaceRoot, isPathWithinRoot } from '../utils/workspace-guard.js';

const TELEGRAM_MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

function getTelegramCtx(options: unknown): Context | undefined {
  if (!options || typeof options !== 'object') return undefined;
  const ctx = (options as { telegramCtx?: unknown }).telegramCtx;
  if (!ctx || typeof ctx !== 'object') return undefined;
  return ctx as Context;
}

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

// ── /mcp/send_file ───────────────────────────────────────────────────
// Sends a file from the bot's filesystem (workspace or /tmp) to the user via
// Telegram. Mirrors the SDK in-process MCP tool in src/claude/mcp-tools.ts but
// routed through IPC so the MCP subprocess can stay out of process.
registerIpcHandler('/mcp/send_file', async (turn, body) => {
  const filePath = String(body.file_path ?? '');
  const caption = typeof body.caption === 'string' && body.caption.length > 0 ? body.caption : undefined;

  const session = sessionManager.getSession(turn.sessionKey);
  if (!session) {
    return { success: false, message: 'Error: No active session.' };
  }

  const ctx = getTelegramCtx(turn.options as unknown);
  if (!ctx) {
    return { success: false, message: 'Error: No Telegram context for this turn.' };
  }

  // Resolve relative paths against the session's workspace, same as SDK mode.
  const resolvedPath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(session.workingDirectory, filePath);

  // Path must be inside the workspace root or /tmp — anything outside is
  // treated as an exfiltration attempt and rejected. Same guards as the
  // in-process MCP version.
  const workspaceRoot = getWorkspaceRoot();
  if (!isPathWithinRoot(workspaceRoot, resolvedPath) && !isPathWithinRoot('/tmp', resolvedPath)) {
    return { success: false, message: `Error: File path must be within the workspace (${workspaceRoot}) or /tmp. Access denied.` };
  }

  if (!fs.existsSync(resolvedPath)) {
    return { success: false, message: `Error: File not found: ${path.basename(resolvedPath)}` };
  }

  const stat = fs.statSync(resolvedPath);
  if (stat.isDirectory()) {
    return { success: false, message: `Error: Path is a directory, not a file: ${path.basename(resolvedPath)}` };
  }
  if (stat.size > TELEGRAM_MAX_FILE_SIZE) {
    const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
    return { success: false, message: `Error: File too large (${sizeMB}MB). Telegram limit is 50MB.` };
  }

  const fileName = path.basename(resolvedPath);
  try {
    const fileBuffer = fs.readFileSync(resolvedPath);
    const inputFile = new InputFile(fileBuffer, fileName);
    await ctx.replyWithDocument(inputFile, caption ? { caption } : undefined);
  } catch (err) {
    return {
      success: false,
      message: `Error sending file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const sizeMB = (stat.size / (1024 * 1024)).toFixed(2);
  return {
    success: true,
    message: `File sent to user: ${fileName} (${sizeMB}MB)`,
  };
});
