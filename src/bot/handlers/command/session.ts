/**
 * Session lifecycle: /clear, /resume, /continue, /recap, /handoff, /sync,
 * /sessions and /teleport.
 *
 * All of these move a chat between conversations — starting a fresh one,
 * picking an older one back up, or summarising what a previous one did — so
 * they share the session history, the JSONL reader and the topic restore.
 */

import { Context } from 'grammy';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../../../config.js';
import { sessionManager } from '../../../claude/session-manager.js';
import { sessionHistory } from '../../../claude/session-history.js';
import { clearConversation } from '../../../providers/provider-router.js';
import { messageSender } from '../../../telegram/message-sender.js';
import { escapeMarkdownV2 as esc, processMessageForTelegram } from '../../../telegram/markdown.js';
import {
  readRecentExchanges,
  readLastAssistantTurnText,
  type RecapExchange,
} from '../../../claude/session-jsonl.js';
import { getSessionKeyFromCtx, parseSessionKey } from '../../../utils/session-key.js';
import {
  replyMd,
  parseCallback,
  projectStatusSuffix,
  resumeCommandMessage,
  truncateToBytes,
  formatTimeAgo,
  buildBackToPreviousButton,
} from './shared.js';
import {
  getSessionTopic,
  clearTopicAndRefreshBotName,
  restoreTopicAndRefreshBotName,
} from './topic.js';

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
