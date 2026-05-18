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
import { createPendingQuestion } from './ask-user.js';

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

// ── /mcp/ask_user ────────────────────────────────────────────────────
// Long-polling IPC handler: registers a pending question in the same shared
// ask-user registry SDK mode uses, sends a Telegram inline keyboard, and
// awaits the user's button tap. The existing callback-query dispatcher
// (handling `q:<id>:<idx>` callback_data) resolves the promise so we can
// return the chosen label to claude. Times out at 10 min via createPendingQuestion's default.
registerIpcHandler('/mcp/ask_user', async (turn, body) => {
  const question = String(body.question ?? '').trim();
  const rawOptions = Array.isArray(body.options) ? body.options : [];
  const options = rawOptions
    .map((o): { label: string; description?: string } | null => {
      if (!o || typeof o !== 'object') return null;
      const oo = o as Record<string, unknown>;
      if (typeof oo.label !== 'string' || !oo.label) return null;
      return {
        label: oo.label,
        description: typeof oo.description === 'string' ? oo.description : undefined,
      };
    })
    .filter((o): o is { label: string; description?: string } => o !== null);

  if (!question || options.length < 2) {
    return { success: false, message: 'Error: ask_user requires a non-empty question and ≥ 2 options.' };
  }

  const ctx = getTelegramCtx(turn.options as unknown);
  if (!ctx?.chat?.id) {
    return { success: false, message: 'Error: no Telegram context available to ask the user.' };
  }

  const optionLabels = options.map((o) => o.label);
  const { id, promise } = createPendingQuestion(optionLabels, undefined, turn.sessionKey);

  const lines: string[] = [`❓ ${question}`];
  const annotated = options.filter((o) => o.description);
  if (annotated.length > 0) {
    lines.push('');
    for (const o of options) {
      if (o.description) lines.push(`• *${o.label}* — ${o.description}`);
    }
  }

  const keyboard = options.map((o, idx) => [{
    text: o.label.length > 60 ? o.label.slice(0, 57) + '…' : o.label,
    callback_data: `q:${id}:${idx}`,
  }]);

  const threadId = ctx.message?.is_topic_message ? ctx.message?.message_thread_id : undefined;
  await ctx.api.sendMessage(ctx.chat.id, lines.join('\n'), {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard },
    ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
  });

  const answer = await promise;
  if (!answer) {
    return {
      success: true,
      message: 'User did not respond within 10 minutes. Proceed using your best judgment or ask again.',
    };
  }
  return { success: true, message: `User selected: ${answer.label}` };
});

// ── /mcp/switch_project ──────────────────────────────────────────────
// Updates the session's working directory. PtyProvider's _getOrCreateSession
// detects the cwd mismatch on the next turn and respawns the pty in the new
// dir — so the switch is logically "happens on next query," same as SDK mode.
registerIpcHandler('/mcp/switch_project', async (turn, body) => {
  const projectName = String(body.project_name ?? '').trim();
  if (!projectName) {
    return { success: false, message: 'Error: project_name is required.' };
  }

  const workspaceRoot = getWorkspaceRoot();
  const targetPath = path.resolve(workspaceRoot, projectName);

  if (!isPathWithinRoot(workspaceRoot, targetPath)) {
    return { success: false, message: `Error: Path must be within workspace root: ${workspaceRoot}` };
  }

  if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
    return { success: false, message: `Error: Project not found: ${projectName}` };
  }

  sessionManager.setWorkingDirectory(turn.sessionKey, targetPath);

  return {
    success: true,
    message: `Switched to project: ${projectName} (${targetPath}). The new working directory will take effect on the next query.`,
  };
});

// ── /mcp/extract_media ───────────────────────────────────────────────
// Extracts text/audio/video from a YouTube/Instagram/TikTok URL via yt-dlp,
// uploads the resulting media files to the user via Telegram, and returns
// a text summary back to claude. Mirrors the SDK in-process extractMediaTool.
registerIpcHandler('/mcp/extract_media', async (turn, body) => {
  const url = String(body.url ?? '');
  const mode = String(body.mode ?? '') as 'text' | 'audio' | 'video' | 'all';

  if (!url) return { success: false, message: 'Error: url is required.' };
  if (!['text', 'audio', 'video', 'all'].includes(mode)) {
    return { success: false, message: `Error: mode must be one of text/audio/video/all (got "${mode}").` };
  }

  const ctx = getTelegramCtx(turn.options as unknown);
  if (!ctx) {
    return { success: false, message: 'Error: No Telegram context for this turn.' };
  }

  const { extractMedia, cleanupExtractResult } = await import('../media/extract.js');
  let result: Awaited<ReturnType<typeof extractMedia>> | undefined;

  try {
    result = await extractMedia({ url, mode });
    const parts: string[] = [];

    if (result.videoPath) {
      try {
        await ctx.replyWithVideo(new InputFile(result.videoPath), { caption: `📹 ${result.title}` });
        parts.push('Video sent to user.');
      } catch (err) {
        parts.push(`Video send failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (result.audioPath && (mode === 'audio' || mode === 'all')) {
      try {
        await ctx.replyWithAudio(new InputFile(result.audioPath), { caption: `🎵 ${result.title}` });
        parts.push('Audio sent to user.');
      } catch (err) {
        parts.push(`Audio send failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (result.transcript) {
      parts.push(`Transcript:\n\n${result.transcript}`);
    }

    if (result.warnings.length > 0) {
      parts.push(`Warnings: ${result.warnings.join('; ')}`);
    }

    if (parts.length === 0) {
      parts.push('Extraction completed but no content was produced.');
    }

    return { success: true, message: parts.join('\n\n') };
  } catch (err) {
    return {
      success: false,
      message: `Media extraction error: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    if (result) cleanupExtractResult(result);
  }
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
