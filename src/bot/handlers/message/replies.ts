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
import { messageSender } from '../../../telegram/message-sender.js';
import { EntityText } from '../../../telegram/entities.js';
import { replyFormatted } from '../../../telegram/send.js';
import { createTelegraphFromFile } from '../../../telegram/telegraph.js';
import { maybeSendVoiceReply } from '../../../tts/voice-reply.js';
import {
  projectStatusSuffix,
  resumeCommandMessage,
  clearTopicAndRefreshBotName,
} from '../command.handler.js';
import { fireAutoTopic, requireSession, resolveUserFilePath, runQueuedTurn } from './shared.js';
import { refuseFilePublish } from '../../file-access.js';
import { progressCallbacks, toolCallbacks, withStreamingTurn } from '../../../telegram/streaming-turn.js';
import { closeTurn, relayCatchUpIfMissed } from './turn-notify.js';

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
  await clearTopicAndRefreshBotName(ctx, sessionKey);

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
    await ctx.reply('❌ Please provide a description.');
    return;
  }

  fireAutoTopic(ctx, sessionKey, trimmedInput);

  await runQueuedTurn(ctx, sessionKey, trimmedInput, `AgentReply:${mode}`, async () => {
    const startTime = Date.now();

    await withStreamingTurn(ctx, sessionKey, trimmedInput, async (abortController) => {
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

      await closeTurn(ctx, sessionKey, response, trimmedInput);
    });
  });
}

// Handle reply to telegraph ForceReply prompt
export async function handleTelegraphReply(ctx: Context, sessionKey: string, filePath: string): Promise<void> {
  if (await refuseFilePublish(ctx)) return;
  const fullPath = await resolveUserFilePath(ctx, sessionKey, filePath);
  if (!fullPath) return;

  const ext = path.extname(fullPath).toLowerCase();
  if (ext !== '.md' && ext !== '.markdown') {
    await ctx.reply('⚠️ Telegraph works best with Markdown files (.md)');
  }

  await ctx.reply('📤 Creating Telegraph page...');

  const pageUrl = await createTelegraphFromFile(fullPath);

  if (pageUrl) {
    const fileName = path.basename(fullPath);
    await replyFormatted(ctx, new EntityText()
      .add('📄 ').bold(fileName).newline(2)
      .link('Open in Instant View', pageUrl)
      .build());
  } else {
    await ctx.reply('❌ Failed to create Telegraph page.');
  }
}
