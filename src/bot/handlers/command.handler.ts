import { Context } from 'grammy';
import { sessionManager } from '../../claude/session-manager.js';
import { sessionHistory } from '../../claude/session-history.js';
import { clearConversation, sendToAgent, sendLoopToAgent, getModel, isDangerousMode, getCachedUsage, getActiveProviderName } from '../../providers/provider-router.js';
import { config } from '../../config.js';
import { messageSender } from '../../telegram/message-sender.js';
import { getUptimeFormatted } from '../middleware/stale-filter.js';
import { getAvailableCommands } from '../../claude/command-parser.js';
import { cancelRequest, clearQueue, isProcessing, queueRequest, setAbortController } from '../../claude/request-queue.js';
import { createTelegraphFromFile } from '../../telegram/telegraph.js';
import { escapeMarkdownV2 as esc, processMessageForTelegram } from '../../telegram/markdown.js';
import { maybeSendVoiceReply } from '../../tts/voice-reply.js';
import { fmtTokens, getProgressBar } from './message.handler.js';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { getWorkspaceRoot, isPathWithinRoot } from '../../utils/workspace-guard.js';
import { getSessionKeyFromCtx, parseSessionKey } from '../../utils/session-key.js';
import { readRecentExchanges, readLastAssistantTurnText, type RecapExchange } from '../../claude/session-jsonl.js';
import { replyMd, parseCallback, projectStatusSuffix, resumeCommandMessage, truncateToBytes, getEffortLabel, formatTimeAgo, buildBackToPreviousButton } from './command/shared.js';
import { getSessionTopic, clearTopicAndRefreshBotName, restoreTopicAndRefreshBotName } from './command/topic.js';

// Re-exported so the modules that already import from this file keep working
// while the command handlers are split out domain by domain.
export {
  parseCallback,
  projectStatusSuffix,
  resumeCommandMessage,
  truncateToBytes,
  getEffortLabel,
  buildBackToPreviousButton,
} from './command/shared.js';
export {
  setSessionTopic,
  getSessionTopic,
  getMsSinceTopicSet,
  clearTopicAndRefreshBotName,
  restoreTopicAndRefreshBotName,
  handleTopic,
  handleBotName,
  handleBotNameCallback,
} from './command/topic.js';
export { getStreamingMode } from './command/streaming-mode.js';
export {
  executeRedditFetch,
  executeMediumFetch,
  handleReddit,
  handleVReddit,
  handleMedium,
  handleMediumCallback,
  handleRedditActionCallback,
} from './command/web-fetch.js';
export {
  sendTranscriptResult,
  handleTranscribe,
  handleTranscribeAudio,
  handleTranscribeDocument,
  handleExtract,
  showExtractMenu,
  handleExtractCallback,
  executeExtract,
} from './command/media.js';
export { handleTasks, handleTasksCallback, handleShells, handleShellsCallback } from './command/tasks.js';
export { handleBtw, btwLabel, formatSideAnswer } from './command/btw.js';
import { listProjectFiles } from './command/project.js';
export {
  handleProject,
  handleNewProject,
  handleProjectCallback,
} from './command/project.js';
export {
  handleUpdate,
  handleUpdateCallback,
  handleBotStatus,
  handleRestartBot,
  handleRestartBotCallback,
  handleRebuild,
  handleRebuildCallback,
} from './command/admin.js';
import { buildTelegraphMenu } from './command/settings.js';
export {
  handleMode,
  handleModeCallback,
  handleTerminalUI,
  handleTerminalUICallback,
  handleTTS,
  handleTTSCallback,
  handleTelegraphCallback,
  handleEffort,
  handleEffortCallback,
  handleVerbosity,
  handleVerbosityCallback,
  handleMethodCommand,
  handleMethodCallback,
  handleSuggestions,
  handleSuggestionsCallback,
  handleStatusLine,
  handleStatusLineCallback,
  sendStatusLine,
} from './command/settings.js';
export {
  handleModelCommand,
  handleModelCallback,
  handleProviderCommand,
  handleCcrCommand,
  handleProviderCallback,
  handleProviderSwitchCallback,
} from './command/model.js';

export function parseContextOutput(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return '⚠️ No context output received.';
  }

  const lines = trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let model = '';
  let tokensLine = '';
  const categories: Array<{ name: string; tokens: string; percent: string }> = [];
  let inCategories = false;

  for (const line of lines) {
    if (/^model:/i.test(line)) {
      model = line.replace(/^model:/i, '').trim();
      continue;
    }
    if (/^tokens:/i.test(line)) {
      tokensLine = line.replace(/^tokens:/i, '').trim();
      continue;
    }
    if (/estimated usage by category/i.test(line)) {
      inCategories = true;
      continue;
    }
    if (inCategories) {
      if (/^category/i.test(line)) continue;
      if (/^-+$/.test(line)) continue;

      const match = line.match(/^(.+?)\s{2,}([0-9.,kKmM]+)\s+([0-9.,]+%)$/);
      if (match) {
        categories.push({ name: match[1].trim(), tokens: match[2], percent: match[3] });
        continue;
      }

      const parts = line.split(/\s+/);
      if (parts.length >= 3 && parts[parts.length - 1].endsWith('%')) {
        const percent = parts.pop() as string;
        const tokens = parts.pop() as string;
        const name = parts.join(' ');
        categories.push({ name, tokens, percent });
      }
    }
  }

  if (!model && !tokensLine && categories.length === 0) {
    return `## 🧠 Context Usage\n\n\`\`\`\n${trimmed}\n\`\`\``;
  }

  let output = '## 🧠 Context Usage';
  if (model) output += `\n- **Model:** ${model}`;
  if (tokensLine) output += `\n- **Tokens:** ${tokensLine}`;

  if (categories.length > 0) {
    output += '\n\n### Estimated usage by category';
    for (const category of categories) {
      output += `\n- **${category.name}:** ${category.tokens} (${category.percent})`;
    }
  }

  output += '\n\n_If this looks stale, send a new message then run /context again._';
  return output;
}

const SESSION_ID_RE = /^[a-zA-Z0-9_-]{8,128}$/;

async function runClaudeContext(sessionId: string, cwd: string): Promise<string> {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error('Invalid session ID format');
  }
  return new Promise((resolve, reject) => {
    execFile(
      // Match the binary PTY mode spawns — CLAUDE_BIN and CLAUDE_EXECUTABLE_PATH
      // can point at different installs, and this resumes a PTY-written session.
      process.env.CLAUDE_BIN || config.CLAUDE_EXECUTABLE_PATH,
      // --fork-session + --no-session-persistence are load-bearing: a bare
      // `-p --resume <id>` CONTINUES that session and appends its own turn to
      // the JSONL. In PTY mode <id> is the *live* session, so /context would
      // inject a stray turn into the real conversation while the pty process
      // is writing the same file.
      ['-p', '--resume', sessionId, '--fork-session', '--no-session-persistence', '/context'],
      {
        cwd,
        timeout: 20_000,
        maxBuffer: 1024 * 1024,
        env: process.env,
      },
      (error, stdout, stderr) => {
        if (error) {
          const message = (stderr || error.message).trim();
          reject(new Error(message || 'Failed to run /context'));
          return;
        }
        resolve((stdout || stderr || '').trim());
      }
    );
  });
}

export async function handleStart(ctx: Context): Promise<void> {
  const dangerousWarning = isDangerousMode()
    ? '\n\n⚠️ *DANGEROUS MODE ENABLED* \\- All tool permissions auto\\-approved'
    : '';

  const keyInfo = getSessionKeyFromCtx(ctx);
  const chatId = keyInfo ? parseSessionKey(keyInfo.sessionKey).chatId : undefined;
  const effortLabel = chatId !== undefined ? (getEffortLabel(chatId) ?? 'Default') : 'Default';

  const welcomeMessage = `👋 *Welcome to TeleCoder\\!*

I bridge your messages to Claude Code running on your local machine\\.

*Getting Started:*
1\\. Set your project directory with \`/project /path/to/project\`
2\\. Start chatting with Claude about your code\\!

*Commands:*
• \`/project <path>\` \\- Open a project
• \`/newproject <name>\` \\- Create a new project
• \`/clear\` \\- Clear session and start fresh
• \`/status\` \\- Show current session info
• \`/commands\` \\- Show all available commands

Current mode: ${config.STREAMING_MODE}
Effort: ${esc(effortLabel)}${dangerousWarning}`;

  const currentConv = keyInfo
    ? sessionManager.getSession(keyInfo.sessionKey)?.conversationId
    : undefined;
  const backButton = keyInfo
    ? buildBackToPreviousButton(keyInfo.sessionKey, currentConv)
    : undefined;

  await ctx.reply(welcomeMessage, {
    parse_mode: 'MarkdownV2',
    ...(backButton ? { reply_markup: { inline_keyboard: backButton } } : {}),
  });
}

export async function handleClear(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  // After a bot restart the in-memory session map is empty; without this
  // pull-from-disk, startNewConversation silently no-ops and the project is
  // dropped, forcing the user to /project again. The default auto-restore
  // age cap doesn't apply here — the user is explicitly invoking /clear, so
  // any restorable project on disk should come back.
  sessionManager.getOrRestoreSession(sessionKey, Number.MAX_SAFE_INTEGER);

  const text = ctx.message?.text || '';
  const arg = text.split(' ').slice(1).join(' ').trim().toLowerCase();
  const skipConfirm = arg === '-y' || arg === '--yes' || arg === 'yes' || arg === 'force';

  if (skipConfirm) {
    clearConversation(sessionKey);
    sessionManager.startNewConversation(sessionKey);
    await clearTopicAndRefreshBotName(ctx, sessionKey);

    const session = sessionManager.getSession(sessionKey);
    const projectName = session ? path.basename(session.workingDirectory) : null;
    const msg = projectName
      ? `🔄 Conversation cleared\\. Project *${esc(projectName)}* is still selected\\.`
      : '🔄 Conversation cleared\\.';
    const newConv = session?.conversationId;
    const backButton = buildBackToPreviousButton(sessionKey, newConv);
    await ctx.reply(msg, {
      parse_mode: 'MarkdownV2',
      ...(backButton ? { reply_markup: { inline_keyboard: backButton } } : {}),
    });
    return;
  }

  const session = sessionManager.getSession(sessionKey);
  const projectName = session ? path.basename(session.workingDirectory) : 'current session';

  await ctx.reply(
    `⚠️ *Clear conversation?*\n\nThis wipes the conversation history for *${esc(projectName)}*\\. The project stays selected\\.\n\n_This cannot be undone\\._\n\n💡 Tip: \`/clear \\-y\` skips this confirmation\\.`,
    {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✓ Yes, clear it', callback_data: 'clear:confirm' },
            { text: '✗ Cancel', callback_data: 'clear:cancel' },
          ],
        ],
      },
    }
  );
}

export async function handleClearCallback(ctx: Context): Promise<void> {
  const cb = parseCallback(ctx, 'clear:');
  if (!cb) return;
  const { sessionKey, data } = cb;

  const action = data.replace('clear:', '');

  if (action === 'confirm') {
    // Same restore-from-disk guard as handleClear: a bot restart between the
    // confirm prompt and the tap would otherwise drop the project on confirm.
    sessionManager.getOrRestoreSession(sessionKey, Number.MAX_SAFE_INTEGER);
    // Preserve the working directory (project) — only wipe the conversation,
    // matching Claude Code's /clear semantics.
    clearConversation(sessionKey);
    sessionManager.startNewConversation(sessionKey);
    await clearTopicAndRefreshBotName(ctx, sessionKey);

    const session = sessionManager.getSession(sessionKey);
    const projectName = session ? path.basename(session.workingDirectory) : null;

    await ctx.answerCallbackQuery({ text: 'Conversation cleared!' });
    const msg = projectName
      ? `🔄 Conversation cleared\\. Project *${esc(projectName)}* is still selected\\.`
      : '🔄 Conversation cleared\\.';
    const newConv = session?.conversationId;
    const backButton = buildBackToPreviousButton(sessionKey, newConv);
    await ctx.editMessageText(msg, {
      parse_mode: 'MarkdownV2',
      ...(backButton ? { reply_markup: { inline_keyboard: backButton } } : {}),
    });
  } else {
    await ctx.answerCallbackQuery({ text: 'Cancelled' });
    await ctx.editMessageText('👍 Clear cancelled\\. Your session is intact\\.', { parse_mode: 'MarkdownV2' });
  }
}

export async function handleStatus(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) {
    await ctx.reply('❌ Could not determine chat context for /status.');
    return;
  }

  try {
    const { sessionKey } = keyInfo;
    const { chatId } = parseSessionKey(sessionKey);

    const session = sessionManager.getSession(sessionKey);

    if (!session) {
      await replyMd(ctx, 'ℹ️ No active session\\.\n\nUse `/project /path/to/project` to get started\\.');
      return;
    }

    const currentModel = getModel(chatId);
    const provider = getActiveProviderName(chatId);
    const dangerousMode = isDangerousMode() ? '⚠️ ENABLED' : 'Disabled';
    const effortLabel = getEffortLabel(chatId) ?? 'Default';
    const topic = getSessionTopic(sessionKey);

    const projectName = path.basename(session.workingDirectory);

    // On CCR, the SDK alias doesn't reflect which backend actually served
    // the turn — CCR picks per-request based on its router config. We
    // don't try to discover the true backend (would require log parsing).
    // The "Provider: ccr" line below already signals the routing.
    const cached = getCachedUsage(sessionKey);
    const modelLine =
      provider === 'ccr'
        ? `${esc(currentModel)} _\\(routed via CCR\\)_`
        : esc(currentModel);

    let status = `📊 *Session Status*

🤖 *Bot Name:* ${esc(config.BOT_NAME)}
📦 *Project:* ${esc(projectName)}
🏷️ *Topic:* ${topic ? esc(topic) : '_none_'}
🎚️ *Effort:* ${esc(effortLabel)}
🧠 *Model:* ${modelLine}
🔌 *Provider:* ${esc(provider)}
🆔 *Session ID:* \`${esc(session.claudeSessionId ?? session.conversationId)}\`
📁 *Working Directory:* \`${esc(session.workingDirectory)}\`
📡 *Mode:* ${esc(config.STREAMING_MODE)}
${isDangerousMode() ? '⚠️' : '🛡️'} *Dangerous Mode:* ${esc(dangerousMode)}`;
    if (cached) {
      const pct = cached.contextWindow > 0
        ? Math.round(((cached.inputTokens + cached.outputTokens) / cached.contextWindow) * 100)
        : 0;
      status += `\n📐 *Context:* ${esc(String(pct))}% \\(${esc(fmtTokens(cached.inputTokens + cached.outputTokens))}/${esc(fmtTokens(cached.contextWindow))}\\)`;
      status += `\n💰 *Session Cost:* \\$${esc(cached.totalCostUsd.toFixed(4))}`;
    }

    status += `\n🕰️ *Created:* ${esc(session.createdAt.toLocaleString())}`;
    status += `\n⏱️ *Last Activity:* ${esc(session.lastActivity.toLocaleString())}`;
    status += `\n⏳ *Uptime:* ${esc(getUptimeFormatted())}`;

    await replyMd(ctx, status);
  } catch (err) {
    console.error('[Status] Error:', err);
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.reply(`❌ /status failed: ${msg}`).catch(() => {});
  }
}

export async function handlePing(ctx: Context): Promise<void> {
  const uptime = getUptimeFormatted();
  await replyMd(ctx, `🏓 Pong\\!\n\nUptime: ${esc(uptime)}`);
}

export async function handleContext(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { chatId, sessionKey } = keyInfo;

  const session = sessionManager.getSession(sessionKey);
  if (!session) {
    await ctx.reply(
      '⚠️ No project set\\.\n\nIf the bot restarted, use `/continue` or `/resume` to restore your last session\\.\nOr use `/project` to open a project first\\.',
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  // Try cached SDK usage first (instant, no CLI shell-out)
  const cached = getCachedUsage(sessionKey);
  if (cached) {
    const pct = cached.contextWindow > 0
      ? Math.round(((cached.inputTokens + cached.outputTokens + cached.cacheReadTokens) / cached.contextWindow) * 100)
      : 0;
    const bar = getProgressBar(pct);

    const output = `## 🧠 Context Usage\n\n`
      + `${bar} **${pct}%** of context window\n\n`
      + `- **Model:** ${cached.model}\n`
      + `- **Input tokens:** ${fmtTokens(cached.inputTokens)}\n`
      + `- **Output tokens:** ${fmtTokens(cached.outputTokens)}\n`
      + `- **Cache read:** ${fmtTokens(cached.cacheReadTokens)}\n`
      + `- **Cache write:** ${fmtTokens(cached.cacheWriteTokens)}\n`
      + `- **Context window:** ${fmtTokens(cached.contextWindow)}\n`
      + `- **Turns this session:** ${cached.numTurns}\n`
      + `- **Cost this query:** $${cached.totalCostUsd.toFixed(4)}\n\n`
      + `_Data from last query. Send a message then run /context for fresh data._`;

    await messageSender.sendMessage(ctx, output);
    return;
  }

  // Fallback: CLI shell-out approach (Claude only)
  if (!session.claudeSessionId) {
    await replyMd(
      ctx,
      '⚠️ No Claude session ID found\\.\n\nSend a message to Claude after resuming, then run `/context` again\\.'
    );
    return;
  }

  const ack = await ctx.reply('🧠 Checking context...', { parse_mode: undefined });

  try {
    const raw = await runClaudeContext(session.claudeSessionId, session.workingDirectory);
    const formatted = parseContextOutput(raw);
    await messageSender.sendMessage(ctx, formatted);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const hint = message.toLowerCase().includes('unknown') || message.toLowerCase().includes('command')
      ? '\n\nThis CLI may not support `/context` yet.'
      : '';
    await messageSender.sendMessage(ctx, `❌ Failed to fetch context: ${message}${hint}`);
  } finally {
    try {
      await ctx.api.deleteMessage(chatId, ack.message_id);
    } catch {
      // ignore cleanup errors
    }
  }
}

export async function handleRestartCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  if (data === 'restart:continue') {
    await ctx.answerCallbackQuery();
    await handleContinue(ctx);
  } else if (data === 'restart:resume') {
    await ctx.answerCallbackQuery();
    await handleResume(ctx);
  } else {
    await ctx.answerCallbackQuery();
  }
}

export async function handleStartupCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  await ctx.answerCallbackQuery();

  // Remove the inline keyboard so the buttons can't be tapped twice.
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
  } catch {
    // ignore — message may have been edited or deleted
  }

  const keyInfo = getSessionKeyFromCtx(ctx);

  if (data === 'startup:continue') {
    // Continuing counts as engaging with the session: refresh its activity so a
    // subsequent restart silently restores it (and stays quiet) instead of
    // re-prompting about an hours-stale session.
    if (keyInfo) sessionHistory.touchActivity(keyInfo.sessionKey);
    await handleContinue(ctx);
    return;
  }

  if (data === 'startup:fresh') {
    // Mark the prompt resolved so a later restart stays quiet rather than
    // re-asking about a session the user has chosen to abandon. No session is in
    // memory — the next user message naturally starts a new conversation.
    if (keyInfo) sessionHistory.resolveStartupPrompt(keyInfo.sessionKey);
    await replyMd(ctx, '🆕 Starting fresh\\. Send a message to begin a new session\\.');
    return;
  }
}

export async function handleCancel(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const wasProcessing = isProcessing(sessionKey);
  const cancelled = await cancelRequest(sessionKey);
  const clearedCount = clearQueue(sessionKey);

  if (cancelled || clearedCount > 0) {
    let message = '🛑 Cancelled\\.';
    if (clearedCount > 0) {
      message += ` \\(${clearedCount} queued request${clearedCount > 1 ? 's' : ''} cleared\\)`;
    }
    await replyMd(ctx, message);
  } else if (!wasProcessing) {
    await replyMd(ctx, 'ℹ️ Nothing to cancel\\.');
  }
}

export async function handleCommands(ctx: Context): Promise<void> {
  await replyMd(ctx, getAvailableCommands());
}

export async function handlePlan(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const session = sessionManager.getSession(sessionKey);
  if (!session) {
    await replyMd(ctx, '⚠️ No project set\\.\n\nIf the bot restarted, use `/continue` or `/resume` to restore your last session\\.\nOr use `/project` to open a project first\\.');
    return;
  }

  const text = ctx.message?.text || '';
  const task = text.split(' ').slice(1).join(' ').trim();

  if (!task) {
    await ctx.reply(
      `📋 *Plan Mode*\n\n_Project: ${esc(path.basename(session.workingDirectory))}_\n\nClaude will analyze your task and create a detailed implementation plan before coding\\.\n\n👇 _Describe your task:_`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'Add user authentication with JWT...',
          selective: true,
        },
      }
    );
    return;
  }

  try {
    await queueRequest(sessionKey, task, async () => {
      await messageSender.startStreaming(ctx);

      const abortController = new AbortController();
      setAbortController(sessionKey, abortController);

      try {
        const response = await sendToAgent(sessionKey, task, {
          onProgress: (progressText) => {
            messageSender.updateStream(ctx, progressText);
          },
          abortController,
          command: 'plan',
        });

        await messageSender.finishStreaming(ctx, response.text);
        await maybeSendVoiceReply(ctx, response.text);
      } catch (error) {
        await messageSender.cancelStreaming(ctx, error as Error);
        throw error;
      }
    });
  } catch (error) {
    if ((error as Error).message === 'Queue cleared') return;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    await replyMd(ctx, `❌ Error: ${esc(errorMessage)}`);
  }
}

export async function handleExplore(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const session = sessionManager.getSession(sessionKey);
  if (!session) {
    await replyMd(ctx, '⚠️ No project set\\.\n\nIf the bot restarted, use `/continue` or `/resume` to restore your last session\\.\nOr use `/project` to open a project first\\.');
    return;
  }

  const text = ctx.message?.text || '';
  const question = text.split(' ').slice(1).join(' ').trim();

  if (!question) {
    await ctx.reply(
      `🔍 *Explore Mode*\n\n_Project: ${esc(path.basename(session.workingDirectory))}_\n\nClaude will search and analyze the codebase to answer your question\\.\n\n👇 _What would you like to know?_`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'How does the auth system work?',
          selective: true,
        },
      }
    );
    return;
  }

  try {
    await queueRequest(sessionKey, question, async () => {
      await messageSender.startStreaming(ctx);

      const abortController = new AbortController();
      setAbortController(sessionKey, abortController);

      try {
        const response = await sendToAgent(sessionKey, question, {
          onProgress: (progressText) => {
            messageSender.updateStream(ctx, progressText);
          },
          abortController,
          command: 'explore',
        });

        await messageSender.finishStreaming(ctx, response.text);
        await maybeSendVoiceReply(ctx, response.text);
      } catch (error) {
        await messageSender.cancelStreaming(ctx, error as Error);
        throw error;
      }
    });
  } catch (error) {
    if ((error as Error).message === 'Queue cleared') return;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    await replyMd(ctx, `❌ Error: ${esc(errorMessage)}`);
  }
}

export async function handleResume(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const history = sessionManager.getSessionHistory(sessionKey, 10);
  // Only show sessions that actually have a Claude session (were chatted in)
  const resumable = history.filter((entry) => entry.claudeSessionId);

  if (resumable.length === 0) {
    await replyMd(ctx, 'ℹ️ No resumable sessions found\\.\n\nSessions need at least one Claude response to be resumable\\.\nUse `/project <name>` to start a new session\\.');
    return;
  }

  const keyboard = resumable.map((entry) => {
    const date = new Date(entry.lastActivity);
    const timeAgo = formatTimeAgo(date);
    const suffix = ` (${timeAgo})`;
    const base = entry.topic
      ? `${entry.projectName} · ${entry.topic}`
      : entry.projectName;
    // Telegram caps inline button labels at 64 bytes — truncate from the right
    // so the project name stays visible.
    const budget = 64 - suffix.length - 1;
    const text = (Buffer.byteLength(base, 'utf8') > budget
      ? truncateToBytes(base, budget - 1) + '…'
      : base) + suffix;

    return [
      {
        text,
        callback_data: `resume:${entry.conversationId}`,
      },
    ];
  });

  await ctx.reply('📜 *Recent Sessions*\n\nSelect a session to resume:', {
    parse_mode: 'MarkdownV2',
    reply_markup: {
      inline_keyboard: keyboard,
    },
  });
}

export async function handleResumeCallback(ctx: Context): Promise<void> {
  const cb = parseCallback(ctx, 'resume:');
  if (!cb) return;
  const { sessionKey, data } = cb;

  const conversationId = data.replace('resume:', '');
  const session = sessionManager.resumeSession(sessionKey, conversationId);

  if (!session) {
    await ctx.answerCallbackQuery({ text: 'Session not found' });
    return;
  }

  clearConversation(sessionKey);
  const entry = sessionHistory.getSessionByConversationId(sessionKey, conversationId);
  await restoreTopicAndRefreshBotName(ctx, sessionKey, entry?.topic);

  await ctx.answerCallbackQuery({ text: 'Session resumed!' });
  await ctx.editMessageText(
    `✅ Resumed session for *${esc(path.basename(session.workingDirectory))}*\n\n` +
    `Working directory: \`${esc(session.workingDirectory)}\`${projectStatusSuffix(sessionKey)}`,
    { parse_mode: 'MarkdownV2' }
  );

  // Send session ID as separate message for easy copying
  if (session.claudeSessionId) {
    await replyMd(ctx, resumeCommandMessage(session.claudeSessionId));
  }

  await sendRecapHint(ctx, sessionKey);
}

export async function handleContinue(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const session = sessionManager.resumeLastSession(sessionKey);

  if (!session) {
    await replyMd(ctx, 'ℹ️ No previous session to continue\\.\n\nUse `/project <name>` to start a new session\\.');
    return;
  }

  clearConversation(sessionKey);
  const entry = sessionHistory.getLastSession(sessionKey);
  await restoreTopicAndRefreshBotName(ctx, sessionKey, entry?.topic);

  await replyMd(ctx,
    `✅ Continuing *${esc(path.basename(session.workingDirectory))}*\n\n` +
    `Working directory: \`${esc(session.workingDirectory)}\`${projectStatusSuffix(sessionKey)}`
  );

  // Send session ID as separate message for easy copying
  if (session.claudeSessionId) {
    await replyMd(ctx, resumeCommandMessage(session.claudeSessionId));
  }

  await sendRecapHint(ctx, sessionKey);
}

// Cap for the user-prompt blockquote — long pasted prompts shouldn't dominate
// the recap. Assistant replies are NOT truncated: they go through the same
// converter+chunker as the original delivery, so their markdown renders
// (bold, code, lists) instead of showing escaped literals.
const RECAP_USER_MAX_CHARS = 500;
const RECAP_DEFAULT_N = 3;
const RECAP_MAX_N = 10;

function truncateUserPrompt(text: string, max: number = RECAP_USER_MAX_CHARS): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max - 1).trimEnd() + '…';
}

/**
 * Post the recap as a sequence of messages: a header, then for each exchange
 * the user prompt as a blockquote followed by the assistant reply rendered
 * with its original markdown intact. This mirrors how the assistant text
 * looked on first delivery, instead of cramming everything into one escaped
 * blockquote block where `*bold*` / backticks / lists show as raw characters.
 */
async function sendRecap(ctx: Context, exchanges: RecapExchange[]): Promise<void> {
  await replyMd(
    ctx,
    `📋 *Recap* — last ${exchanges.length} exchange${exchanges.length === 1 ? '' : 's'}`,
  );

  for (const ex of exchanges) {
    const userText = esc(truncateUserPrompt(ex.user));
    await replyMd(ctx, `>*You:* ${userText}`);

    for (const part of processMessageForTelegram(ex.assistant)) {
      try {
        await ctx.reply(part, { parse_mode: 'MarkdownV2' });
      } catch (error) {
        // Same fallback shape as MessageSender.sendMessage: if MarkdownV2 parse
        // fails (malformed entity from the converter), strip backslash-escapes
        // and resend as plain text rather than dropping the chunk.
        console.error('[Recap] MarkdownV2 send failed, falling back to plain text:', error);
        try {
          await ctx.reply(part.replace(/\\(.)/g, '$1'), { parse_mode: undefined });
        } catch (plainError) {
          console.error('[Recap] Plain text send also failed:', plainError);
        }
      }
    }
  }
}

/** Post a one-line tip pointing the user at /recap. Used after explicit restore. */
async function sendRecapHint(ctx: Context, sessionKey: string): Promise<void> {
  const session = sessionManager.getSession(sessionKey);
  if (!session?.claudeSessionId) return;
  const exchanges = readRecentExchanges(session.workingDirectory, session.claudeSessionId, 1);
  if (exchanges.length === 0) return;
  await replyMd(ctx, '💡 Tip: use `/recap` to see your last messages from this session\\.');
}

export async function handleRecap(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const text = ctx.message?.text || '';
  const arg = text.split(' ').slice(1).join(' ').trim();

  let n = RECAP_DEFAULT_N;
  if (arg) {
    const parsed = parseInt(arg, 10);
    if (Number.isNaN(parsed) || parsed < 1) {
      await replyMd(ctx, '⚠️ Usage: `/recap [N]` where N is the number of exchanges \\(default 3, max 10\\)\\.');
      return;
    }
    n = Math.min(parsed, RECAP_MAX_N);
  }

  const session = sessionManager.getSession(sessionKey);
  if (!session) {
    await replyMd(ctx, '⚠️ No active session\\. Use `/continue` or `/resume` first\\.');
    return;
  }
  if (!session.claudeSessionId) {
    await replyMd(ctx, 'ℹ️ This session has no recorded messages yet\\.');
    return;
  }

  const exchanges = readRecentExchanges(session.workingDirectory, session.claudeSessionId, n);
  if (exchanges.length === 0) {
    await replyMd(ctx, 'ℹ️ No recoverable exchanges found in this session\\.');
    return;
  }

  await sendRecap(ctx, exchanges);
}

/**
 * Dump the current session's conversation to a markdown file and deliver
 * via Telegram (Telegraph link + downloadable file). Useful before switching
 * projects, clearing context, or handing off to a teammate. Captures all
 * exchanges (capped at 200) plus session metadata.
 */
export async function handleHandoff(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const session = sessionManager.getSession(sessionKey);
  if (!session) {
    await replyMd(ctx, '⚠️ No active session\\. Use `/continue` or `/resume` first\\.');
    return;
  }
  if (!session.claudeSessionId) {
    await replyMd(ctx, 'ℹ️ This session has no recorded messages yet\\.');
    return;
  }

  const exchanges = readRecentExchanges(session.workingDirectory, session.claudeSessionId, 200);
  if (exchanges.length === 0) {
    await replyMd(ctx, 'ℹ️ No recoverable exchanges in this session\\.');
    return;
  }

  const projectName = path.basename(session.workingDirectory);
  const topic = getSessionTopic(sessionKey);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  const headerLines: string[] = [
    `# Session handoff — ${projectName}`,
    '',
    `**Project:** \`${session.workingDirectory}\`  `,
    `**Session id:** \`${session.claudeSessionId}\`  `,
    `**Conversation id:** \`${session.conversationId}\`  `,
    `**Exported:** ${new Date().toLocaleString()}  `,
    topic ? `**Topic:** ${topic}  ` : '',
    `**Exchanges:** ${exchanges.length}`,
    '',
    `Resume with: \`claude --resume ${session.claudeSessionId}\``,
    '',
    '---',
    '',
  ].filter(Boolean);

  const bodyLines: string[] = [];
  exchanges.forEach((ex, i) => {
    bodyLines.push(`## Exchange ${i + 1}`);
    bodyLines.push('');
    bodyLines.push('### User');
    bodyLines.push('');
    bodyLines.push(ex.user.trim());
    bodyLines.push('');
    bodyLines.push('### Assistant');
    bodyLines.push('');
    bodyLines.push(ex.assistant.trim());
    bodyLines.push('');
    bodyLines.push('---');
    bodyLines.push('');
  });

  const md = [...headerLines, ...bodyLines].join('\n');
  const outDir = path.join(session.workingDirectory, '.claudegram', 'handoffs');
  try {
    fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    await replyMd(ctx, `❌ Couldn't create handoff dir: ${esc(err instanceof Error ? err.message : String(err))}`);
    return;
  }
  const filePath = path.join(outDir, `handoff-${ts}.md`);
  try {
    fs.writeFileSync(filePath, md, { mode: 0o600 });
  } catch (err) {
    await replyMd(ctx, `❌ Couldn't write handoff: ${esc(err instanceof Error ? err.message : String(err))}`);
    return;
  }

  await replyMd(
    ctx,
    `📦 *Handoff written* — \`${esc(path.relative(session.workingDirectory, filePath))}\`\n` +
    `${exchanges.length} exchange${exchanges.length === 1 ? '' : 's'} captured\\.`,
  );

  // Telegraph preview + downloadable file (mirrors /telegraph)
  await messageSender.sendMarkdownFile(ctx, filePath, { useTelegraph: true, sendAsDocument: true });
}

/**
 * Manual safety net for the PTY → Telegram translation. Reads the canonical
 * latest assistant turn from Claude Code's session JSONL and posts whatever
 * the user hasn't seen yet. Mirrors the proactive catch-up that runs after
 * each turn (relayCatchUpIfMissed in message.handler.ts); /sync exists for
 * cases where the user suspects a miss outside that automatic window — e.g.
 * a quietly-failed catch-up, or after a bot restart that wiped the relayed
 * tracker.
 */
export async function handleSync(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const session = sessionManager.getSession(sessionKey);
  if (!session) {
    await replyMd(ctx, '⚠️ No active session\\. Use `/continue` or `/resume` first\\.');
    return;
  }
  if (!session.claudeSessionId) {
    await replyMd(ctx, 'ℹ️ This session has no recorded messages yet\\.');
    return;
  }

  const jsonlText = readLastAssistantTurnText(session.workingDirectory, session.claudeSessionId);
  if (!jsonlText) {
    await replyMd(ctx, 'ℹ️ No assistant reply found for the current turn\\.');
    return;
  }

  const relayed = sessionManager.getLastRelayedAssistantText(sessionKey);
  // Same 20-char slack as the proactive check — trim/whitespace deltas don't
  // count as a real miss.
  if (jsonlText.length <= relayed.length + 20) {
    await replyMd(ctx, "✅ You're caught up — nothing new in the session log\\.");
    return;
  }

  const missing = jsonlText.startsWith(relayed) && relayed.length > 0
    ? jsonlText.slice(relayed.length).trim()
    : jsonlText;
  if (!missing) {
    await replyMd(ctx, "✅ You're caught up — nothing new in the session log\\.");
    return;
  }

  await replyMd(ctx, '📨 *Sync* — from session log');
  await messageSender.sendMessage(ctx, missing);
  sessionManager.setLastRelayedAssistantText(sessionKey, jsonlText);
}

/**
 * List the current project's `.claude/commands/*.md` slash commands. They
 * pass through to claude code untouched (typing `/mycommand` in chat sends
 * `/mycommand` to claude, which dispatches to the file), so this is purely
 * a discoverability helper — no per-command registration needed.
 */
/** Show the current permission-gate state and the patterns it enforces. */
export async function handlePermissions(ctx: Context): Promise<void> {
  const { isPermissionGateEnabled, listDangerousPatterns } = await import('../../claude/permission-gate.js');
  const enabled = isPermissionGateEnabled();
  const patterns = listDangerousPatterns();

  const lines: string[] = [
    `🔐 *Permission gate* — ${enabled ? '✅ enabled' : '⛔️ disabled'}`,
    '',
    enabled
      ? 'Bash commands matching the patterns below trigger a Telegram approval prompt before claude executes them\\. Other tools auto\\-allow\\.'
      : 'Disabled\\. Set `TELECODER_PERMISSION_PROMPTS=1` and restart the bot to enable\\.',
    '',
    '*Guarded patterns:*',
    ...patterns.map((p) => `• ${esc(p.reason)}`),
  ];
  await replyMd(ctx, lines.join('\n'));
}

export async function handleProjectCommands(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const session = sessionManager.getSession(sessionKey);
  if (!session) {
    await replyMd(ctx, '⚠️ No project set\\. Use `/project` first\\.');
    return;
  }

  const { getProjectCommands } = await import('../../claude/project-commands.js');
  const commands = getProjectCommands(session.workingDirectory);
  if (commands.length === 0) {
    await replyMd(
      ctx,
      `No project slash commands in \`${esc(path.basename(session.workingDirectory))}\`\\.\n\n` +
      `Add markdown files under \`.claude/commands/\` to define them — see [docs](https://docs.claude.com/en/docs/claude-code/slash-commands)\\.`,
    );
    return;
  }

  const lines: string[] = [
    `📜 *Project commands* \\(${commands.length}\\) in \`${esc(path.basename(session.workingDirectory))}\``,
    '',
    ...commands.map((c) => {
      const desc = c.description ? ` — ${esc(c.description)}` : '';
      return `• \`/${esc(c.name)}\`${desc}`;
    }),
  ];
  await replyMd(ctx, lines.join('\n'));
}

export async function handleLoop(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const session = sessionManager.getSession(sessionKey);
  if (!session) {
    await replyMd(ctx, '⚠️ No project set\\.\n\nIf the bot restarted, use `/continue` or `/resume` to restore your last session\\.\nOr use `/project` to open a project first\\.');
    return;
  }

  const text = ctx.message?.text || '';
  const task = text.split(' ').slice(1).join(' ').trim();

  if (!task) {
    await ctx.reply(
      `🔄 *Loop Mode*\n\n_Project: ${esc(path.basename(session.workingDirectory))}_\n\nClaude will work iteratively until done \\(max ${config.MAX_LOOP_ITERATIONS} iterations\\)\\.\n\n👇 _Describe the task:_`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'Fix all TypeScript errors in src/',
          selective: true,
        },
      }
    );
    return;
  }

  try {
    await queueRequest(sessionKey, task, async () => {
      await messageSender.startStreaming(ctx);

      const abortController = new AbortController();
      setAbortController(sessionKey, abortController);

      try {
        const response = await sendLoopToAgent(sessionKey, task, {
          onProgress: (progressText) => {
            messageSender.updateStream(ctx, progressText);
          },
          abortController,
        });

        await messageSender.finishStreaming(ctx, response.text);
        await maybeSendVoiceReply(ctx, response.text);
      } catch (error) {
        await messageSender.cancelStreaming(ctx, error as Error);
        throw error;
      }
    });
  } catch (error) {
    if ((error as Error).message === 'Queue cleared') return;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    await replyMd(ctx, `❌ Error: ${esc(errorMessage)}`);
  }
}

export async function handleSessions(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const history = sessionManager.getSessionHistory(sessionKey, 10);
  const currentSession = sessionManager.getSession(sessionKey);

  if (history.length === 0 && !currentSession) {
    await replyMd(ctx, 'ℹ️ No sessions found\\.\n\nUse `/project <name>` to start a new session\\.');
    return;
  }

  let message = '📋 *Sessions*\n\n';

  if (currentSession) {
    message += `*Active:*\n• \`${esc(path.basename(currentSession.workingDirectory))}\` \\(${esc(formatTimeAgo(currentSession.lastActivity))}\\)\n\n`;
  }

  if (history.length > 0) {
    message += '*Recent:*\n';
    for (const entry of history) {
      const isActive = currentSession && currentSession.conversationId === entry.conversationId;
      const marker = isActive ? '→ ' : '• ';
      const date = new Date(entry.lastActivity);
      const topicSuffix = entry.topic ? ` — _${esc(entry.topic)}_` : '';
      message += `${marker}\`${esc(entry.projectName)}\` \\(${esc(formatTimeAgo(date))}\\)${topicSuffix}\n`;
    }
  }

  message += '\n_Use `/resume` to switch sessions or `/continue` to resume the last one\\._';

  await replyMd(ctx, message);
}

export async function handleTeleport(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;
  const { chatId } = parseSessionKey(sessionKey);

  const session = sessionManager.getSession(sessionKey);

  if (!session) {
    await replyMd(ctx, 'ℹ️ No active session to teleport\\.\n\nStart a conversation first with `/project <name>`\\.');
    return;
  }

  if (!session.claudeSessionId) {
    await replyMd(ctx, 'ℹ️ No Claude session available yet\\.\n\nSend a message first to start a session, then use `/teleport`\\.');
    return;
  }

  const projectName = path.basename(session.workingDirectory);
  const claudeBin = config.CLAUDE_EXECUTABLE_PATH ?? 'claude';
  const command = `cd "${session.workingDirectory}" && ${claudeBin} --resume ${session.claudeSessionId}`;

  const message = `🚀 *Teleport to Terminal*

*Project:* \`${esc(projectName)}\`
*Session:* \`${esc(session.claudeSessionId.substring(0, 8))}\\.\\.\\.\`

Copy and run in your terminal:

\`\`\`
${esc(command)}
\`\`\`

_Both Telegram and terminal can continue independently \\(forked session\\)\\._`;

  await replyMd(ctx, message);
}

export async function handleFile(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const text = ctx.message?.text || '';
  const filePath = text.split(' ').slice(1).join(' ').trim();

  const session = sessionManager.getSession(sessionKey);
  if (!session) {
    await replyMd(ctx, '⚠️ No project set\\.\n\nIf the bot restarted, use `/continue` or `/resume` to restore your last session\\.\nOr use `/project <path>` to open a project first\\.');
    return;
  }

  if (!filePath) {
    // List some files in the project to help user
    const projectFiles = listProjectFiles(session.workingDirectory);
    const fileList = projectFiles.length > 0
      ? `\n\n*Recent files:*\n${projectFiles.slice(0, 8).map(f => `• \`${esc(f)}\``).join('\n')}`
      : '';

    await ctx.reply(
      `📎 *Download File*\n\n_Project: ${esc(path.basename(session.workingDirectory))}_${fileList}\n\n👇 _Enter the file path:_`,
      {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          force_reply: true,
          input_field_placeholder: 'src/index.ts',
          selective: true,
        },
      }
    );
    return;
  }

  const fullPath = filePath.startsWith('/')
    ? filePath
    : path.join(session.workingDirectory, filePath);
  const workspaceRoot = getWorkspaceRoot();

  if (!isPathWithinRoot(workspaceRoot, fullPath)) {
    await replyMd(ctx, `❌ File path must be within workspace root: \`${esc(workspaceRoot)}\``);
    return;
  }

  if (!fs.existsSync(fullPath)) {
    await replyMd(ctx, `❌ File not found: \`${esc(filePath)}\``);
    return;
  }

  if (fs.statSync(fullPath).isDirectory()) {
    await replyMd(ctx, `❌ Path is a directory, not a file: \`${esc(filePath)}\``);
    return;
  }

  const success = await messageSender.sendDocument(ctx, fullPath, `📎 ${path.basename(fullPath)}`);

  if (!success) {
    await replyMd(ctx, '❌ Failed to send file\\. It may be too large \\(\\>50MB\\) or inaccessible\\.');
  }
}

export async function handleTelegraph(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const text = ctx.message?.text || '';
  const filePath = text.split(' ').slice(1).join(' ').trim();

  // If no argument provided, show the settings menu
  if (!filePath) {
    const menu = buildTelegraphMenu(sessionKey);
    await ctx.reply(menu.text, {
      parse_mode: 'MarkdownV2',
      reply_markup: menu.keyboard.length > 0 ? { inline_keyboard: menu.keyboard } : undefined,
    });
    return;
  }

  const session = sessionManager.getSession(sessionKey);
  if (!session) {
    await replyMd(ctx, '⚠️ No project set\\.\n\nIf the bot restarted, use `/continue` or `/resume` to restore your last session\\.\nOr use `/project <path>` to open a project first\\.');
    return;
  }

  const fullPath = filePath.startsWith('/')
    ? filePath
    : path.join(session.workingDirectory, filePath);
  const workspaceRoot = getWorkspaceRoot();

  if (!isPathWithinRoot(workspaceRoot, fullPath)) {
    await replyMd(ctx, `❌ File path must be within workspace root: \`${esc(workspaceRoot)}\``);
    return;
  }

  if (!fs.existsSync(fullPath)) {
    await replyMd(ctx, `❌ File not found: \`${esc(filePath)}\``);
    return;
  }

  const ext = path.extname(fullPath).toLowerCase();
  if (ext !== '.md' && ext !== '.markdown') {
    await replyMd(ctx, '⚠️ Telegraph works best with Markdown files \\(\\.md\\)');
  }

  await replyMd(ctx, '📤 Creating Telegraph page\\.\\.\\.');

  const pageUrl = await createTelegraphFromFile(fullPath);

  if (pageUrl) {
    const fileName = path.basename(fullPath);
    await replyMd(ctx, `📄 *${esc(fileName)}*\n\n[Open in Instant View](${esc(pageUrl)})`);
  } else {
    await replyMd(ctx, '❌ Failed to create Telegraph page\\.');
  }
}

