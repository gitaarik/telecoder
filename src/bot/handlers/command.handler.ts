import { Context } from 'grammy';
import { sessionManager } from '../../claude/session-manager.js';
import { sendToAgent, sendLoopToAgent, getModel, isDangerousMode, getCachedUsage, getActiveProviderName } from '../../providers/provider-router.js';
import { config } from '../../config.js';
import { messageSender } from '../../telegram/message-sender.js';
import { getUptimeFormatted } from '../middleware/stale-filter.js';
import { getAvailableCommands } from '../../claude/command-parser.js';
import { cancelRequest, clearQueue, isProcessing, queueRequest } from '../../claude/request-queue.js';
import { createTelegraphFromFile } from '../../telegram/telegraph.js';
import { escapeMarkdownV2 as esc, escapeMarkdownV2Code as escCode } from '../../telegram/markdown.js';
import { maybeSendVoiceReply } from '../../tts/voice-reply.js';
import { fmtTokens, getProgressBar } from '../../utils/format.js';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { getWorkspaceRoot, isPathWithinRoot } from '../../utils/workspace-guard.js';
import { resolveClaudeExecutableForMethod } from '../../utils/resolve-claude-bin.js';
import { getActiveMethod } from '../../providers/claude-provider.js';
import { groupAvailableCommands, type AvailableCommands } from '../../claude/available-commands.js';
import { getSessionKeyFromCtx, parseSessionKey } from '../../utils/session-key.js';
import { replyMd, getEffortLabel, buildBackToPreviousButton } from './command/shared.js';
import { getSessionTopic } from './command/topic.js';
import { requireActiveSession } from './session-guard.js';
import { progressCallbacks, withStreamingTurn } from '../../telegram/streaming-turn.js';

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
  handleRestartCallback,
  handleStartupCallback,
  handleRebuild,
  handleRebuildCallback,
} from './command/admin.js';
export {
  handleClear,
  handleClearCallback,
  handleResume,
  handleResumeCallback,
  handleContinue,
  handleRecap,
  handleHandoff,
  handleSync,
  handleSessions,
  handleTeleport,
} from './command/session.js';
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

  const session = await requireActiveSession(ctx, sessionKey);
  if (!session) return;

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

  const session = await requireActiveSession(ctx, sessionKey);
  if (!session) return;

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
      await withStreamingTurn(ctx, sessionKey, async (abortController) => {
        const response = await sendToAgent(sessionKey, task, {
          ...progressCallbacks(ctx),
          abortController,
          telegramCtx: ctx,
          command: 'plan',
        });

        await messageSender.finishStreaming(ctx, response.text);
        await maybeSendVoiceReply(ctx, response.text);
      });
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

  const session = await requireActiveSession(ctx, sessionKey);
  if (!session) return;

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
      await withStreamingTurn(ctx, sessionKey, async (abortController) => {
        const response = await sendToAgent(sessionKey, question, {
          ...progressCallbacks(ctx),
          abortController,
          telegramCtx: ctx,
          command: 'explore',
        });

        await messageSender.finishStreaming(ctx, response.text);
        await maybeSendVoiceReply(ctx, response.text);
      });
    });
  } catch (error) {
    if ((error as Error).message === 'Queue cleared') return;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    await replyMd(ctx, `❌ Error: ${esc(errorMessage)}`);
  }
}

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

/**
 * List the current project's `.claude/commands/*.md` slash commands. They
 * pass through to claude code untouched (typing `/mycommand` in chat sends
 * `/mycommand` to claude, which dispatches to the file), so this is purely
 * a discoverability helper — no per-command registration needed.
 */
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
  const { getAvailableCommands: getClaudeCommands } = await import('../../claude/available-commands.js');
  const { getBotCommandNames } = await import('../../claude/command-parser.js');

  const projectCommands = getProjectCommands(session.workingDirectory);
  // Ask the binary this chat's turns actually run through. SDK and PTY mode
  // can be different installs at different versions, and their command sets
  // differ — listing the wrong one would name commands that don't exist here.
  const executable = resolveClaudeExecutableForMethod(getActiveMethod(keyInfo.chatId));
  // A cold cache means a probe — a fresh headless process — so show a typing
  // indicator rather than leaving the chat silent for a second or two.
  const typing = ctx.replyWithChatAction?.('typing');
  const snapshot = await getClaudeCommands(session.workingDirectory, executable);
  await typing?.catch(() => { /* chat action is best-effort */ });

  await replyMd(ctx, buildProjectCommandsMessage({
    directory: path.basename(session.workingDirectory),
    projectCommands,
    snapshot,
    botCommandNames: getBotCommandNames(),
  }));
}

/**
 * Render the `/projectcommands` listing. Pure so the MarkdownV2 escaping —
 * which only fails at send time, as a Telegram 400 — is unit-testable.
 *
 * `snapshot` is undefined when Claude Code's own command list couldn't be
 * read; the project commands still list, since those come off disk.
 */
export function buildProjectCommandsMessage(input: {
  directory: string;
  projectCommands: Array<{ name: string; description: string }>;
  snapshot: AvailableCommands | undefined;
  botCommandNames: ReadonlySet<string>;
}): string {
  const { directory, projectCommands, snapshot, botCommandNames } = input;
  const lines: string[] = [`📜 *Commands available in* \`${escCode(directory)}\``, ''];

  if (projectCommands.length > 0) {
    lines.push('*Project* \\(`.claude/commands/`\\):', '');
    for (const c of projectCommands) {
      const desc = c.description ? ` — ${esc(c.description)}` : '';
      lines.push(`• \`/${escCode(c.name)}\`${desc}`);
    }
    lines.push('');
  }

  if (snapshot) {
    const { skills, plugins, builtIns } = groupAvailableCommands(snapshot);
    // A command TeleCoder registers never reaches Claude Code — grammY matches
    // it first — so listing it as passthrough would be a lie. Name them
    // separately instead, so nobody wonders why /loop isn't the skill.
    const shadowed = snapshot.slashCommands.filter((n) => botCommandNames.has(n)).sort();
    const passthrough = (names: string[]): string =>
      names.filter((n) => !botCommandNames.has(n)).map((n) => `\`/${escCode(n)}\``).join(', ');

    const groups: Array<[string, string]> = [
      ['*Skills:*', passthrough(skills)],
      ['*Plugin:*', passthrough(plugins)],
      ['*Built\\-in:*', passthrough(builtIns)],
    ];
    for (const [title, list] of groups) {
      if (list) lines.push(title, '', list, '');
    }

    if (shadowed.length > 0) {
      lines.push(
        "⚠️ *Shadowed by TeleCoder* — these run the bot's own command, not Claude Code's:",
        '',
        shadowed.map((n) => `\`/${escCode(n)}\``).join(', '),
        '',
      );
    }
  } else {
    lines.push("_Claude Code's own command list is unavailable right now\\._", '');
  }

  if (projectCommands.length === 0) {
    lines.push(
      'Add markdown files under `.claude/commands/` to define project commands — '
      + 'see [docs](https://docs.claude.com/en/docs/claude-code/slash-commands)\\.',
    );
  }

  return joinWithinLimit(lines, 3900);
}

/**
 * Join lines up to a byte budget, dropping whole lines rather than cutting
 * mid-line. A byte-wise truncation would happily split a MarkdownV2 escape or
 * leave a backtick unclosed, and Telegram rejects the whole message for it.
 */
function joinWithinLimit(lines: string[], maxBytes: number): string {
  const notice = '\n_…list truncated\\._';
  const budget = maxBytes - Buffer.byteLength(notice, 'utf8');
  const kept: string[] = [];
  let size = 0;
  for (const line of lines) {
    const cost = Buffer.byteLength(line, 'utf8') + 1;
    if (size + cost > budget) {
      return kept.join('\n').trimEnd() + notice;
    }
    kept.push(line);
    size += cost;
  }
  return kept.join('\n').trimEnd();
}

export async function handleLoop(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const session = await requireActiveSession(ctx, sessionKey);
  if (!session) return;

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
      await withStreamingTurn(ctx, sessionKey, async (abortController) => {
        const response = await sendLoopToAgent(sessionKey, task, {
          ...progressCallbacks(ctx),
          abortController,
          telegramCtx: ctx,
        });

        await messageSender.finishStreaming(ctx, response.text);
        await maybeSendVoiceReply(ctx, response.text);
      });
    });
  } catch (error) {
    if ((error as Error).message === 'Queue cleared') return;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    await replyMd(ctx, `❌ Error: ${esc(errorMessage)}`);
  }
}

export async function handleFile(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const text = ctx.message?.text || '';
  const filePath = text.split(' ').slice(1).join(' ').trim();

  const session = await requireActiveSession(ctx, sessionKey);
  if (!session) return;

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

  const session = await requireActiveSession(ctx, sessionKey);
  if (!session) return;

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

