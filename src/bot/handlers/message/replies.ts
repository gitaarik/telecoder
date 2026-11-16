/**
 * Handlers for replies to the bot's ForceReply prompts — the flows where a
 * command posts a question and the user's *next* message is the answer
 * (/project path, /file path).
 *
 * `handleMessage` routes here by matching the prompt text it is replying to.
 */

import { Context } from 'grammy';
import * as fs from 'fs';
import * as path from 'path';
import { clearConversation } from '../../../providers/provider-router.js';
import { sessionManager } from '../../../claude/session-manager.js';
import { messageSender } from '../../../telegram/message-sender.js';
import { EntityText } from '../../../telegram/entities.js';
import { replyFormatted } from '../../../telegram/send.js';
import {
  projectStatusSuffix,
  resumeCommandMessage,
  clearTopic,
} from '../command.handler.js';
import { resolveUserFilePath } from './shared.js';

// Handle reply to project ForceReply prompt
export async function handleProjectReply(ctx: Context, sessionKey: string, projectPath: string): Promise<void> {
  let resolvedPath = projectPath.trim();

  // Handle ~ expansion
  if (resolvedPath.startsWith('~')) {
    resolvedPath = path.join(process.env.HOME || '', resolvedPath.slice(1));
  }

  // Resolve to absolute path. Manual path entry is treated as an explicit
  // user choice and may point anywhere on disk (mirrors typing `/project <abs>`).
  resolvedPath = path.resolve(resolvedPath);

  // Check if exists
  if (!fs.existsSync(resolvedPath)) {
    await replyFormatted(ctx, new EntityText()
      .add('❌ Path not found: ').code(resolvedPath).add('\n\nPlease check the path and try again.')
      .build());
    return;
  }

  // Check if directory
  if (!fs.statSync(resolvedPath).isDirectory()) {
    await replyFormatted(ctx, new EntityText().add('❌ Not a directory: ').code(resolvedPath).build());
    return;
  }

  // Set the project
  sessionManager.setWorkingDirectory(sessionKey, resolvedPath);
  clearConversation(sessionKey);
  clearTopic(sessionKey);

  const projectName = path.basename(resolvedPath);
  await replyFormatted(ctx, new EntityText()
    .add('✅ Project set: ').bold(projectName).newline(2)
    .code(resolvedPath).newline(2)
    .add('You can now chat with Claude about this project!')
    .append(projectStatusSuffix(sessionKey))
    .build());

  const s = sessionManager.getSession(sessionKey);
  if (s?.claudeSessionId) {
    await replyFormatted(ctx, resumeCommandMessage(s.claudeSessionId));
  }
}

// Handle reply to file ForceReply prompt
export async function handleFileReply(ctx: Context, sessionKey: string, filePath: string): Promise<void> {
  const fullPath = await resolveUserFilePath(ctx, sessionKey, filePath);
  if (!fullPath) return;

  const success = await messageSender.sendDocument(ctx, fullPath, `📎 ${path.basename(fullPath)}`);

  if (!success) {
    await ctx.reply('❌ Failed to send file. It may be too large (>50MB) or inaccessible.');
  }
}
