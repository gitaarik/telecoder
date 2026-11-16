import { Context } from 'grammy';
import { sessionManager } from '../../claude/session-manager.js';
import { getCachedUsage, getActiveProviderName } from '../../providers/provider-router.js';
import { userPreferences } from '../../providers/user-preferences.js';
import { describeModelId, isPremiumModel, PREMIUM_MODEL_ICON } from '../../claude/model-catalog.js';
import { config } from '../../config.js';
import { messageSender } from '../../telegram/message-sender.js';
import { getUptimeFormatted } from '../middleware/stale-filter.js';
import { getAvailableCommands } from '../../claude/command-parser.js';
import { isProcessing } from '../../claude/request-queue.js';
import { EntityText, joinMessages, trimMessage, type EntityMessage } from '../../telegram/entities.js';
import { replyFormatted, replyParts } from '../../telegram/send.js';
import { contextHealthColor, fmtTokens, getProgressBar } from '../../utils/format.js';
import * as path from 'path';
import { execFile } from 'child_process';
import { resolveShareableFile } from '../file-access.js';
import { resolvePtyClaudeBin } from '../../utils/resolve-claude-bin.js';
import { contextTokens } from '../../providers/types.js';
import { stopTurn } from '../middleware/queued-messages.js';
import { groupAvailableCommands, type AvailableCommands } from '../../claude/available-commands.js';
import { buildCommandSearchMessage, searchCommands } from '../command-catalog.js';
import { getSessionKeyFromCtx, parseSessionKey } from '../../utils/session-key.js';
import { replyMd, getEffortLabel, effortLevelLabel, withBackToPrevious } from './command/shared.js';
import { getSessionTopic } from './command/topic.js';
import { describeRole } from './command/access.js';
import { requireActiveSession } from './session-guard.js';

// Re-exported so the modules that already import from this file keep working
// while the command handlers are split out domain by domain.
export {
  parseCallback,
  projectStatusSuffix,
  resumeCommandMessage,
  truncateToBytes,
  getEffortLabel,
  withBackToPrevious,
} from './command/shared.js';
export {
  setSessionTopic,
  getSessionTopic,
  getMsSinceTopicSet,
  clearTopic,
  restoreTopic,
  handleTopic,
} from './command/topic.js';
export { handleBotName } from './command/botname.js';
export { handleAllow, handleDeny, handleMembers } from './command/access.js';
export {
  sendTranscriptResult,
  handleTranscribe,
  handleTranscribeAudio,
  handleTranscribeDocument,
} from './command/media.js';
export { handleCost, parseCostOutput } from './command/cost.js';
export { handleTasks, handleTasksCallback, handleShells, handleShellsCallback } from './command/tasks.js';
export { handleBtw, btwLabel, formatSideAnswer } from './command/btw.js';
export {
  handleProject,
  handleProjectCallback,
} from './command/project.js';
export {
  handleUpdate,
  handleUpdateCallback,
  handleBotStatus,
  handleVersion,
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
  handleRecap,
  handleSync,
  handleTeleport,
} from './command/session.js';
export { handleResume, handleResumeCallback } from './command/resume.js';
export {
  handlePermissionMode,
  handlePermissionModeCallback,
  handleTTS,
  handleTTSCallback,
  handleEffort,
  handleEffortCallback,
  handleVerbosity,
  handleVerbosityCallback,
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
export { handlePrefsAllCallback } from './command/prefs-scope.js';

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
  const keyInfo = getSessionKeyFromCtx(ctx);
  const effortLabel = keyInfo ? (getEffortLabel(keyInfo.sessionKey) ?? 'Default') : 'Default';

  const welcome = new EntityText()
    .add('👋 ').bold('Welcome to TeleCoder!')
    .add('\n\nI bridge your messages to Claude Code running on your local machine.\n\n')
    .bold('Getting Started:')
    .add('\n1. Set your project directory with ').code('/project /path/to/project')
    .add('\n2. Start chatting with Claude about your code!\n\n')
    .bold('Commands:')
    .add('\n• ').code('/project <path>').add(' - Open a project')
    .add('\n• ').code('/clear').add(' - Clear session and start fresh')
    .add('\n• ').code('/status').add(' - Show current session info')
    .add('\n• ').code('/commands').add(' - Show all commands; ').code('/commands <words>').add(' searches them')
    .add(`\n\nEffort: ${effortLabel}`);

  const currentConv = keyInfo
    ? sessionManager.getSession(keyInfo.sessionKey)?.conversationId
    : undefined;
  const back = withBackToPrevious(welcome.build(), keyInfo?.sessionKey, currentConv);

  await replyFormatted(ctx, back.text, back.options);
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
      await replyMd(ctx, 'ℹ️ No active session.\n\nUse `/project /path/to/project` to get started.');
      return;
    }

    const provider = getActiveProviderName(sessionKey);
    const topic = getSessionTopic(sessionKey);

    const projectName = path.basename(session.workingDirectory);

    // On CCR, the model alias doesn't reflect which backend actually served
    // the turn — CCR picks per-request based on its router config. We
    // don't try to discover the true backend (would require log parsing).
    // The "Provider: ccr" line below already signals the routing.
    const cached = getCachedUsage(sessionKey);

    // Effort and model are what the session log says the last reply ran with,
    // each followed by who picked it: the chat, with /effort or /model, or
    // Claude Code. Before the first reply the log has nothing, and saying so
    // beats a bare "Default" that could mean either.
    const chosenEffort = getEffortLabel(sessionKey);
    const askedModel = userPreferences.getModel(sessionKey);
    // The cache's model falls back on the asked-for alias and then on a
    // placeholder when the log names none; neither is a model that served.
    const servedModel = cached?.model && cached.model !== askedModel && cached.model !== 'Claude Code default'
      ? cached.model
      : undefined;

    const status = new EntityText().add('📊 ').bold('Session Status').add('\n');
    // One `emoji *Label:* value` line; the value is added by the caller.
    const field = (emoji: string, label: string): EntityText =>
      status.add(`\n${emoji} `).bold(`${label}:`).add(' ');

    field('🤖', 'Bot Name').add(config.BOT_NAME);
    field('📦', 'Project').add(projectName);
    if (topic) field('🏷️', 'Topic').add(topic);
    else field('🏷️', 'Topic').italic('none');
    field('🎚️', 'Effort');
    if (chosenEffort) status.add(chosenEffort).add(' ').italic('(set with /effort)');
    else if (cached?.effort) status.add(effortLevelLabel(cached.effort)).add(' ').italic("(Claude Code's default)");
    else status.italic("Claude Code's default — known after the first reply");

    field('🧠', 'Model');
    if (servedModel) {
      const name = describeModelId(servedModel);
      if (isPremiumModel(servedModel)) status.add(`${PREMIUM_MODEL_ICON} `);
      status.add(name);
      if (name !== servedModel) status.add(' ').code(servedModel);
      if (provider === 'ccr') status.add(' ').italic('(routed via CCR)');
      else if (askedModel) status.add(' ').italic(`(set with /model ${askedModel})`);
      else status.add(' ').italic("(Claude Code's default)");
    } else if (askedModel) {
      status.code(askedModel).add(' ').italic('(set with /model, serving from the next reply)');
    } else {
      status.italic("Claude Code's default — known after the first reply");
    }
    field('🔌', 'Provider').add(provider);
    if (cached) {
      // Cache reads and writes are most of the context, and without them this
      // read about 0%. Same sum as the usage footer's.
      const used = contextTokens(cached);
      const pct = cached.contextWindow > 0
        ? Math.round((used / cached.contextWindow) * 100)
        : 0;
      field('📐', 'Context').add(`${pct}% (${fmtTokens(used)}/${fmtTokens(cached.contextWindow)})`);
      // Only when something has actually been tallied: PTY mode never receives
      // a cost figure, and a flat $0.0000 there reads as a free conversation
      // rather than as an unanswerable question.
      if (cached.sessionCostTurns > 0) {
        field('💰', 'Session Cost').add(`$${cached.sessionCostUsd.toFixed(4)} (${cached.sessionCostTurns} turns)`);
      }
    }

    // Only in a group, and only for a non-admin — it is the line that explains
    // why /restartbot just refused. Spectators never see it: they can't reach
    // /status in the first place.
    const role = describeRole(ctx);
    if (role && role !== 'admin') {
      field('👤', 'Your role here').add(role);
    }

    // The session id is one tap away under /statusline's "Show session", and
    // the bot's uptime is /botstatus's business.
    field('⏱️', 'Last Activity').add(session.lastActivity.toLocaleString());

    await replyFormatted(ctx, status.build());
  } catch (err) {
    console.error('[Status] Error:', err);
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.reply(`❌ /status failed: ${msg}`).catch(() => {});
  }
}

export async function handlePing(ctx: Context): Promise<void> {
  const uptime = getUptimeFormatted();
  await ctx.reply(`🏓 Pong!\n\nUptime: ${uptime}`);
}

export async function handleContext(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { chatId, sessionKey } = keyInfo;

  const session = await requireActiveSession(ctx, sessionKey);
  if (!session) return;

  // Try the cached usage first (instant, no CLI shell-out)
  const cached = getCachedUsage(sessionKey);
  if (cached) {
    const used = contextTokens(cached);
    const pct = cached.contextWindow > 0
      ? Math.round((used / cached.contextWindow) * 100)
      : 0;
    const bar = getProgressBar(pct, contextHealthColor(used, cached.contextWindow));

    const output = `## 🧠 Context Usage\n\n`
      + `${bar} **${pct}%** of context window\n\n`
      + `- **Model:** ${cached.model}\n`
      + `- **Input tokens:** ${fmtTokens(cached.inputTokens)}\n`
      + `- **Output tokens:** ${fmtTokens(cached.outputTokens)}\n`
      + `- **Cache read:** ${fmtTokens(cached.cacheReadTokens)}\n`
      + `- **Cache write:** ${fmtTokens(cached.cacheWriteTokens)}\n`
      + `- **Context window:** ${fmtTokens(cached.contextWindow)}\n`
      + `- **Turns this session:** ${cached.numTurns}\n`
      + `- **Cost this query:** $${cached.totalCostUsd.toFixed(4)}\n`
      + (cached.sessionCostTurns > 0
        ? `- **Cost this chat:** $${cached.sessionCostUsd.toFixed(4)} across ${cached.sessionCostTurns} turns\n`
        : '')
      + `\n_Data from last query. Send a message then run /context for fresh data._`;

    await messageSender.sendMessage(ctx, output);
    return;
  }

  // Fallback: CLI shell-out approach (Claude only)
  if (!session.claudeSessionId) {
    await replyMd(
      ctx,
      '⚠️ No Claude session ID found.\n\nSend a message to Claude after resuming, then run `/context` again.'
    );
    return;
  }

  const ack = await ctx.reply('🧠 Checking context...');

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
  const { stopped: cancelled, dropped: clearedCount } = await stopTurn(ctx.api, sessionKey);

  if (cancelled || clearedCount > 0) {
    let message = '🛑 Cancelled.';
    if (clearedCount > 0) {
      message += ` (${clearedCount} queued request${clearedCount > 1 ? 's' : ''} cleared)`;
    }
    await ctx.reply(message);
  } else if (!wasProcessing) {
    await ctx.reply('ℹ️ Nothing to cancel.');
  }
}

export async function handleCommands(ctx: Context): Promise<void> {
  // `/commands kill` searches names and descriptions — Telegram's own `/`
  // menu only filters on the start of a name.
  const query = (ctx.message?.text ?? '').split(' ').slice(1).join(' ').trim();
  if (query) {
    await replyFormatted(ctx, buildCommandSearchMessage(query, searchCommands(query)));
    return;
  }
  await replyParts(ctx, getAvailableCommands());
}

/** Show the current permission-gate state and the patterns it enforces. */
export async function handlePermissions(ctx: Context): Promise<void> {
  const { isPermissionGateEnabled, isPermissionGateImplicit, listDangerousPatterns } =
    await import('../../claude/permission-gate.js');
  const { getAdminIds, getApproverIds, getGuestIds, hasGuestUsers, isAdmin, isApprover } =
    await import('../../utils/admins.js');
  const enabled = isPermissionGateEnabled();
  const patterns = listDangerousPatterns();

  // One line each; an empty one is the gap between sections.
  const lines: EntityMessage[] = [];
  const line = (build: (b: EntityText) => unknown = () => {}): void => {
    const b = new EntityText();
    build(b);
    lines.push(b.build());
  };

  line((b) => b.add('🔐 ').bold('Permission gate').add(` — ${enabled ? '✅ enabled' : '⛔️ disabled'}`));
  line();
  if (enabled) {
    line((b) => b.add('Bash commands matching the patterns below trigger a Telegram approval prompt before claude executes them. Other tools auto-allow.'));
  } else {
    line((b) => b.add('Disabled. Set ').code('TELECODER_PERMISSION_PROMPTS=1').add(' and restart the bot to enable.'));
  }

  // An open window changes what the gate does right now, so it belongs above
  // everything that describes what it would do otherwise.
  const { getWindow, formatRemaining } = await import('../../claude/auto-approve.js');
  const window = ctx.chat?.id !== undefined ? getWindow(ctx.chat.id) : null;
  if (window) {
    line();
    line((b) => b.add('⚡ ').bold('Auto-approve is on here')
      .add(` — ${formatRemaining(window)} left, opened by ${window.openedByName}.`));
    line((b) => b.add('Guarded commands run without asking and are posted as they happen. End it with ')
      .code('/autoapprove off').add('.'));
  }

  if (enabled && isPermissionGateImplicit()) {
    line();
    line((b) => b.add('On automatically because this bot has non-admin users. Set ')
      .code('TELECODER_PERMISSION_PROMPTS=0').add(' to turn it off.'));
  }

  if (enabled) {
    const { isScopeGuardEnabled, getAllowedRoots } = await import('../../claude/scope-guard.js');
    line();
    if (isScopeGuardEnabled(true)) {
      line((b) => b.bold('Scope guard:').add(' ✅ on'));
      line((b) => b.add('Tool calls naming a path outside these prompt too:'));
      for (const root of getAllowedRoots()) line((b) => b.add('• ').code(root));
    } else {
      line((b) => b.bold('Scope guard:').add(' ⛔️ off'));
    }
  }

  const { isCharterJudgeEnabled, getCharter } = await import('../../claude/charter-judge.js');
  if (isCharterJudgeEnabled()) {
    const { source } = getCharter();
    line();
    line((b) => b.bold('Charter judge:').add(' ✅ on'));
    line((b) => {
      b.add('Every guest message is read against ');
      if (source === '(default)') b.add('the built-in charter');
      else b.code(source);
      b.add(' before it reaches Claude.');
    });
  }

  if (hasGuestUsers()) {
    const admins = getAdminIds();
    const approvers = getApproverIds();
    // getGuestIds() means "not an admin", which includes the approvers. Split
    // them out so the counts add up to the roster rather than double-counting.
    const guests = getGuestIds().filter((id) => !approvers.includes(id));
    const roles = [
      `${admins.length} admin${admins.length === 1 ? '' : 's'}`,
      ...(approvers.length > 0 ? [`${approvers.length} approver${approvers.length === 1 ? '' : 's'}`] : []),
      `${guests.length} guest${guests.length === 1 ? '' : 's'}`,
    ];
    line();
    line((b) => b.bold('Roles:').add(` ${roles.join(', ')}`));
    if (isAdmin(ctx.from?.id)) {
      line((b) => b.add('You are an ').bold('admin')
        .add(' — approval prompts and bot-lifecycle commands are yours to answer.'));
    } else if (isApprover(ctx.from?.id)) {
      line((b) => b.add('You are an ').bold('approver')
        .add(' — you can answer anyone else’s approval prompt, but not your own. ' +
          'Bot-lifecycle commands stay with the admins.'));
    } else {
      line((b) => b.add('You are a ').bold('guest')
        .add(' — an admin or approver answers guarded commands, and admins own ' +
          'bot-lifecycle commands.'));
    }
  }

  line();
  line((b) => b.bold('Guarded patterns:'));
  for (const p of patterns) line((b) => b.add(`• ${p.reason}`));
  await replyParts(ctx, joinMessages(lines, '\n'));
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
    await replyMd(ctx, '⚠️ No project set. Use `/project` first.');
    return;
  }

  const { getProjectCommands } = await import('../../claude/project-commands.js');
  const { getAvailableCommands: getClaudeCommands } = await import('../../claude/available-commands.js');
  const { getBotCommandNames } = await import('../../claude/command-parser.js');

  const projectCommands = getProjectCommands(session.workingDirectory);
  // Ask the binary the chat's turns actually run through: command sets differ
  // between releases, and another install's list would name commands that
  // don't exist here.
  const executable = resolvePtyClaudeBin();
  // A cold cache means a probe — a fresh headless process — so show a typing
  // indicator rather than leaving the chat silent for a second or two.
  const typing = ctx.replyWithChatAction?.('typing');
  const snapshot = await getClaudeCommands(session.workingDirectory, executable);
  await typing?.catch(() => { /* chat action is best-effort */ });

  await replyFormatted(ctx, buildProjectCommandsMessage({
    directory: path.basename(session.workingDirectory),
    projectCommands,
    snapshot,
    botCommandNames: getBotCommandNames(),
  }));
}

/**
 * Render the `/projectcommands` listing. Pure so what it sends — the command
 * names as code, the descriptions as they were written — is unit-testable.
 *
 * `snapshot` is undefined when Claude Code's own command list couldn't be
 * read; the project commands still list, since those come off disk.
 */
export function buildProjectCommandsMessage(input: {
  directory: string;
  projectCommands: Array<{ name: string; description: string }>;
  snapshot: AvailableCommands | undefined;
  botCommandNames: ReadonlySet<string>;
}): EntityMessage {
  const { directory, projectCommands, snapshot, botCommandNames } = input;
  const lines: EntityMessage[] = [];
  const line = (build: (b: EntityText) => unknown = () => {}): void => {
    const b = new EntityText();
    build(b);
    lines.push(b.build());
  };
  // `/a`, `/b`, … as one line of code spans.
  const commandList = (names: string[]) => (b: EntityText): void => {
    names.forEach((n, i) => {
      if (i > 0) b.add(', ');
      b.code(`/${n}`);
    });
  };

  line((b) => b.add('📜 ').bold('Commands available in').add(' ').code(directory));
  line();

  if (projectCommands.length > 0) {
    line((b) => b.bold('Project').add(' (').code('.claude/commands/').add('):'));
    line();
    for (const c of projectCommands) {
      line((b) => {
        b.add('• ').code(`/${c.name}`);
        if (c.description) b.add(` — ${c.description}`);
      });
    }
    line();
  }

  if (snapshot) {
    const { skills, plugins, builtIns } = groupAvailableCommands(snapshot);
    // A command TeleCoder registers never reaches Claude Code — grammY matches
    // it first — so listing it as passthrough would be a lie. Name them
    // separately instead, so nobody wonders why /schedule isn't the skill.
    const shadowed = snapshot.slashCommands.filter((n) => botCommandNames.has(n)).sort();
    const passthrough = (names: string[]): string[] => names.filter((n) => !botCommandNames.has(n));

    const groups: Array<[string, string[]]> = [
      ['Skills:', passthrough(skills)],
      ['Plugin:', passthrough(plugins)],
      ['Built-in:', passthrough(builtIns)],
    ];
    for (const [title, names] of groups) {
      if (names.length === 0) continue;
      line((b) => b.bold(title));
      line();
      line(commandList(names));
      line();
    }

    if (shadowed.length > 0) {
      line((b) => b.add('⚠️ ').bold('Shadowed by TeleCoder')
        .add(" — these run the bot's own command, not Claude Code's:"));
      line();
      line(commandList(shadowed));
      line();
    }
  } else {
    line((b) => b.italic("Claude Code's own command list is unavailable right now."));
    line();
  }

  if (projectCommands.length === 0) {
    line((b) => b.add('Add markdown files under ').code('.claude/commands/')
      .add(' to define project commands — see ')
      .link('docs', 'https://docs.claude.com/en/docs/claude-code/slash-commands').add('.'));
  }

  return joinWithinLimit(lines, 3900);
}

/**
 * Join lines up to a length budget, dropping whole lines rather than cutting
 * mid-line, so the list ends on a whole command name and says it was cut.
 * Counted in UTF-16 code units, the unit of Telegram's 4096 cap.
 */
function joinWithinLimit(lines: EntityMessage[], maxLength: number): EntityMessage {
  const notice = new EntityText().add('\n').italic('…list truncated.').build();
  const budget = maxLength - notice.text.length;
  const kept: EntityMessage[] = [];
  let size = 0;
  for (const line of lines) {
    const cost = line.text.length + 1;
    if (size + cost > budget) {
      return joinMessages([trimMessage(joinMessages(kept, '\n')), notice], '');
    }
    kept.push(line);
    size += cost;
  }
  return trimMessage(joinMessages(kept, '\n'));
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
    await replyFormatted(ctx, new EntityText()
      .add('📎 Usage: ').code('/file <path>')
      .add(', relative to the project, e.g. ').code('/file src/index.ts')
      .add('. Or just ask Claude to send you the file.')
      .build());
    return;
  }

  const fullPath = await resolveShareableFile(ctx, session.workingDirectory, filePath);
  if (!fullPath) return;

  const success = await messageSender.sendDocument(ctx, fullPath, `📎 ${path.basename(fullPath)}`);

  if (!success) {
    await ctx.reply('❌ Failed to send file. It may be too large (>50MB) or inaccessible.');
  }
}

