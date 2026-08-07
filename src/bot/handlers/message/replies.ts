/**
 * Handlers for replies to the bot's ForceReply prompts — the flows where a
 * command posts a question and the user's *next* message is the answer
 * (/project path, /file path, /telegraph path, /plan|/explore|/loop task).
 *
 * `handleMessage` routes here by matching the prompt text it is replying to.
 */

import { Context } from 'grammy';
import * as fs from 'fs';
import * as path from 'path';
import { sendToAgent, sendLoopToAgent, clearConversation } from '../../../providers/provider-router.js';
import { sessionManager } from '../../../claude/session-manager.js';
import { setAbortController } from '../../../claude/request-queue.js';
import { messageSender } from '../../../telegram/message-sender.js';
import { escapeMarkdownV2 as esc } from '../../../telegram/markdown.js';
import { createTelegraphFromFile } from '../../../telegram/telegraph.js';
import { maybeSendVoiceReply } from '../../../tts/voice-reply.js';
import {
  projectStatusSuffix,
  resumeCommandMessage,
  clearTopicAndRefreshBotName,
  sendStatusLine,
} from '../command.handler.js';
import { fireAutoTopic, requireSession, resolveUserFilePath, runQueuedTurn } from './shared.js';
import { progressCallbacks, toolCallbacks } from './turn-runner.js';
import { relayCatchUpIfMissed, sendTurnNotifications } from './turn-notify.js';

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
    await ctx.reply(
      `❌ Path not found: \`${esc(resolvedPath)}\`\n\nPlease check the path and try again\\.`,
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  // Check if directory
  if (!fs.statSync(resolvedPath).isDirectory()) {
    await ctx.reply(
      `❌ Not a directory: \`${esc(resolvedPath)}\``,
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  // Set the project
  sessionManager.setWorkingDirectory(sessionKey, resolvedPath);
  clearConversation(sessionKey);
  await clearTopicAndRefreshBotName(ctx, sessionKey);

  const projectName = path.basename(resolvedPath);
  await ctx.reply(
    `✅ Project set: *${esc(projectName)}*\n\n\`${esc(resolvedPath)}\`\n\nYou can now chat with Claude about this project\\!${projectStatusSuffix(sessionKey)}`,
    { parse_mode: 'MarkdownV2' }
  );

  const s = sessionManager.getSession(sessionKey);
  if (s?.claudeSessionId) {
    await ctx.reply(resumeCommandMessage(s.claudeSessionId), { parse_mode: 'MarkdownV2' });
  }
}

// Handle reply to file ForceReply prompt
export async function handleFileReply(ctx: Context, sessionKey: string, filePath: string): Promise<void> {
  const fullPath = await resolveUserFilePath(ctx, sessionKey, filePath);
  if (!fullPath) return;

  const success = await messageSender.sendDocument(ctx, fullPath, `📎 ${path.basename(fullPath)}`);

  if (!success) {
    await ctx.reply(
      '❌ Failed to send file\\. It may be too large \\(\\>50MB\\) or inaccessible\\.',
      { parse_mode: 'MarkdownV2' }
    );
  }
}

// Handle reply to plan/explore/loop ForceReply prompts
export async function handleAgentReply(
  ctx: Context,
  sessionKey: string,
  input: string,
  mode: 'plan' | 'explore' | 'loop'
): Promise<void> {
  if (!await requireSession(ctx, sessionKey)) return;

  const trimmedInput = input.trim();
  if (!trimmedInput) {
    await ctx.reply(
      '❌ Please provide a description\\.',
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  fireAutoTopic(ctx, sessionKey, trimmedInput);

  await runQueuedTurn(ctx, sessionKey, trimmedInput, `AgentReply:${mode}`, async () => {
    const startTime = Date.now();
    await messageSender.startStreaming(ctx);

    const abortController = new AbortController();
    setAbortController(sessionKey, abortController);

    try {
      let response;
      if (mode === 'loop') {
        response = await sendLoopToAgent(sessionKey, trimmedInput, {
          ...progressCallbacks(ctx),
          abortController,
          telegramCtx: ctx,
        });
      } else {
        response = await sendToAgent(sessionKey, trimmedInput, {
          ...progressCallbacks(ctx),
          ...toolCallbacks(ctx, sessionKey),
          abortController,
          command: mode,
          telegramCtx: ctx,
        });
      }

      await messageSender.finishStreaming(ctx, response.text, { nextPromptSuggestion: response.nextPromptSuggestion });
      await relayCatchUpIfMissed(ctx, sessionKey, response.text || '');
      await maybeSendVoiceReply(ctx, response.text);

      // Completion notification for long tasks
      await messageSender.sendCompletionNotification(ctx, Date.now() - startTime);

      // Context visibility notifications
      await sendTurnNotifications(ctx, sessionKey, response);

      const chatId = ctx.chat?.id;
      if (chatId !== undefined) await sendStatusLine(ctx, chatId, sessionKey, response.usage, trimmedInput);
    } catch (error) {
      await messageSender.cancelStreaming(ctx, error as Error);
      throw error;
    }
  });
}

// Handle reply to telegraph ForceReply prompt
export async function handleTelegraphReply(ctx: Context, sessionKey: string, filePath: string): Promise<void> {
  const fullPath = await resolveUserFilePath(ctx, sessionKey, filePath);
  if (!fullPath) return;

  const ext = path.extname(fullPath).toLowerCase();
  if (ext !== '.md' && ext !== '.markdown') {
    await ctx.reply(
      '⚠️ Telegraph works best with Markdown files \\(\\.md\\)',
      { parse_mode: 'MarkdownV2' }
    );
  }

  await ctx.reply('📤 Creating Telegraph page\\.\\.\\.', { parse_mode: 'MarkdownV2' });

  const pageUrl = await createTelegraphFromFile(fullPath);

  if (pageUrl) {
    const fileName = path.basename(fullPath);
    await ctx.reply(
      `📄 *${esc(fileName)}*\n\n[Open in Instant View](${esc(pageUrl)})`,
      { parse_mode: 'MarkdownV2' }
    );
  } else {
    await ctx.reply(
      '❌ Failed to create Telegraph page\\.',
      { parse_mode: 'MarkdownV2' }
    );
  }
}
