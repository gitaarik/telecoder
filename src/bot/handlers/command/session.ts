/**
 * Session lifecycle: /clear, /recap, /sync and /terminal, and the
 * ▶️ Continue button under a restart notice. /prompts, which branches as well
 * as lists, lives beside /tree in prompts.handler.ts.
 *
 * All of these move a chat between conversations — starting a fresh one,
 * picking an older one back up, or summarising what a previous one did — so
 * they share the session history, the JSONL reader and the topic restore.
 */

import { Context } from 'grammy';
import * as path from 'path';
import { config } from '../../../config.js';
import { sessionManager } from '../../../claude/session-manager.js';
import { sessionHistory } from '../../../claude/session-history.js';
import { clearConversation, getCachedUsage } from '../../../providers/provider-router.js';
import { prewarmClaude } from '../../../claude/prewarm.js';
import { messageSender } from '../../../telegram/message-sender.js';
import { EntityText, type EntityMessage } from '../../../telegram/entities.js';
import { replyFormatted, editCallbackMessage, replyMarkdown } from '../../../telegram/send.js';
import { taskListDisplay } from '../../../telegram/task-list.js';
import { summarizeUserPrompt, unwrapPaste, cutLabel } from '../../../telegram/prompt-label.js';
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
  sessionDisplayName,
  withBackToPrevious,
} from './shared.js';
import {
  buildLetteredKeyboard,
  letteredOptionLines,
} from '../../../telegram/lettered-options.js';
import {
  clearTopic,
  restoreTopic,
} from './topic.js';
import { sendStatusLine } from './settings.js';

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
    clearTopic(sessionKey);

    const session = sessionManager.getSession(sessionKey);
    const projectName = session ? path.basename(session.workingDirectory) : null;
    const back = withBackToPrevious(clearedMessage(projectName), sessionKey, session?.conversationId);
    await replyFormatted(ctx, back.text, back.options);
    void prewarmClaude(ctx, sessionKey);
    return;
  }

  const session = sessionManager.getSession(sessionKey);
  const projectName = session ? path.basename(session.workingDirectory) : 'current session';

  const confirm = new EntityText()
    .add('⚠️ ').bold('Clear conversation?')
    .add('\n\nThis wipes the conversation history for ').bold(projectName)
    .add('. The project stays selected.\n\n')
    .italic('This cannot be undone.')
    .add('\n\n💡 Tip: ').code('/clear -y').add(' skips this confirmation.')
    .build();

  await replyFormatted(ctx, confirm, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✓ Yes, clear it', callback_data: 'clear:confirm' },
          { text: '✗ Cancel', callback_data: 'clear:cancel' },
        ],
      ],
    },
  });
}

/** The confirmation once a conversation is cleared, naming the project kept. */
function clearedMessage(projectName: string | null): EntityMessage {
  const msg = new EntityText().add('🔄 Conversation cleared.');
  if (projectName) msg.add(' Project ').bold(projectName).add(' is still selected.');
  return msg.build();
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
    clearTopic(sessionKey);

    const session = sessionManager.getSession(sessionKey);
    const projectName = session ? path.basename(session.workingDirectory) : null;

    await ctx.answerCallbackQuery({ text: 'Conversation cleared!' });
    const back = withBackToPrevious(clearedMessage(projectName), sessionKey, session?.conversationId);
    await editCallbackMessage(ctx, back.text, back.options);
    void prewarmClaude(ctx, sessionKey);
  } else {
    await ctx.answerCallbackQuery({ text: 'Cancelled' });
    await editCallbackMessage(ctx, '👍 Clear cancelled. Your session is intact.');
  }
}

/**
 * Go back to a conversation from this chat's history — what the ↩️ Back
 * button does (`resume:<conversationId>`), and what the history-based /resume
 * picker did before /resume read Claude Code's transcripts (resume.ts).
 */
export async function resumeHistoryEntry(ctx: Context, sessionKey: string, conversationId: string): Promise<void> {
  const session = sessionManager.resumeSession(sessionKey, conversationId);

  if (!session) {
    await ctx.answerCallbackQuery({ text: 'Session not found' });
    return;
  }

  clearConversation(sessionKey);
  const entry = sessionHistory.getSessionByConversationId(sessionKey, conversationId);
  restoreTopic(sessionKey, entry?.topic);

  await ctx.answerCallbackQuery({ text: 'Session resumed!' });
  await editCallbackMessage(ctx, sessionRestoredMessage('✅ Resumed session for ', session.workingDirectory, sessionKey));

  // Send session ID as separate message for easy copying
  if (session.claudeSessionId) {
    await replyFormatted(ctx, resumeCommandMessage(session.claudeSessionId));
  }

  await taskListDisplay.showRestored(ctx.api, sessionKey, session.claudeSessionId);
  await sendRecapHint(ctx, sessionKey);
  void prewarmClaude(ctx, sessionKey);
}

/** "<lead><project>", the working directory and the project status block. */
function sessionRestoredMessage(lead: string, workingDirectory: string, sessionKey: string): EntityMessage {
  return new EntityText()
    .add(lead).bold(path.basename(workingDirectory))
    .add('\n\nWorking directory: ').code(workingDirectory)
    .append(projectStatusSuffix(sessionKey))
    .build();
}

/**
 * Pick the chat's most recent session back up: what the ▶️ Continue button
 * under a restart notice does. Startup continues a chat by itself these days
 * (startup/auto-continue.ts); this is the manual path for one it left alone.
 */
export async function continueLastSession(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const session = sessionManager.resumeLastSession(sessionKey);

  if (!session) {
    await replyMd(ctx, 'ℹ️ No previous session to continue.\n\nUse `/resume` to pick one, or `/project <name>` to start a new session.');
    return;
  }

  clearConversation(sessionKey);
  const entry = sessionHistory.getLastSession(sessionKey);
  restoreTopic(sessionKey, entry?.topic);

  await replyFormatted(ctx, sessionRestoredMessage('✅ Continuing ', session.workingDirectory, sessionKey));

  // Send session ID as separate message for easy copying
  if (session.claudeSessionId) {
    await replyFormatted(ctx, resumeCommandMessage(session.claudeSessionId));
  }

  await taskListDisplay.showRestored(ctx.api, sessionKey, session.claudeSessionId);
  await sendRecapHint(ctx, sessionKey);
  void prewarmClaude(ctx, sessionKey);
}

// Cap for the user-prompt blockquote — long pasted prompts shouldn't dominate
// the recap. Assistant replies are NOT truncated: they go through the same
// markdown-to-entities converter and splitter as the original delivery, so
// their markdown renders (bold, code, lists) instead of showing raw marks.
const RECAP_USER_MAX_CHARS = 500;
const RECAP_DEFAULT_N = 3;
const RECAP_MAX_N = 10;

function truncateUserPrompt(text: string, max: number = RECAP_USER_MAX_CHARS): string {
  return cutLabel(summarizeUserPrompt(unwrapPaste(text)).replace(/\s+/g, ' ').trim(), max);
}

/**
 * Post the recap as a sequence of messages: a header, then for each exchange
 * the user prompt as a blockquote followed by the assistant reply rendered
 * with its original markdown intact. This mirrors how the assistant text
 * looked on first delivery, instead of cramming everything into one
 * blockquote where `**bold**` / backticks / lists show as raw characters.
 */
async function sendRecap(ctx: Context, exchanges: RecapExchange[]): Promise<void> {
  await replyFormatted(
    ctx,
    new EntityText()
      .add('📋 ').bold('Recap')
      .add(` — last ${exchanges.length} exchange${exchanges.length === 1 ? '' : 's'}`)
      .build(),
  );

  for (const ex of exchanges) {
    const userText = truncateUserPrompt(ex.user);
    await replyFormatted(
      ctx,
      new EntityText().wrap('blockquote', (b) => b.bold('You:').add(` ${userText}`)).build(),
    );

    // replyMarkdown already falls back to plain text when Telegram refuses the
    // formatting; this only keeps one undeliverable reply from ending the
    // whole recap.
    try {
      await replyMarkdown(ctx, ex.assistant);
    } catch (error) {
      console.error('[Recap] Failed to send an assistant reply:', error);
    }
  }
}

/** Post a one-line tip pointing the user at /recap. Used after explicit restore. */
export async function sendRecapHint(ctx: Context, sessionKey: string): Promise<void> {
  const session = sessionManager.getSession(sessionKey);
  if (!session?.claudeSessionId) return;
  const exchanges = readRecentExchanges(session.workingDirectory, session.claudeSessionId, 1);
  if (exchanges.length === 0) return;
  await replyMd(ctx, '💡 Tip: use `/recap` to see your last messages from this session.');
}

export async function handleRecap(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { chatId, sessionKey } = keyInfo;

  const text = ctx.message?.text || '';
  const arg = text.split(' ').slice(1).join(' ').trim();

  let n = RECAP_DEFAULT_N;
  if (arg) {
    const parsed = parseInt(arg, 10);
    if (Number.isNaN(parsed) || parsed < 1) {
      await replyMd(ctx, '⚠️ Usage: `/recap [N]` where N is the number of exchanges (default 3, max 10).');
      return;
    }
    n = Math.min(parsed, RECAP_MAX_N);
  }

  const session = sessionManager.getSession(sessionKey);
  if (!session) {
    await replyMd(ctx, '⚠️ No active session. Use `/resume` first.');
    return;
  }
  if (!session.claudeSessionId) {
    await replyMd(ctx, 'ℹ️ This session has no recorded messages yet.');
    return;
  }

  const exchanges = readRecentExchanges(session.workingDirectory, session.claudeSessionId, n);
  if (exchanges.length === 0) {
    await replyMd(ctx, 'ℹ️ No recoverable exchanges found in this session.');
    return;
  }

  await sendRecap(ctx, exchanges);

  // End the way a turn ends. A long reply leaves the chat on its tail, with the
  // prompt it answers scrolled away, and after a jump to a fork or an earlier
  // point the context is no longer the figure last shown.
  const usage = getCachedUsage(sessionKey);
  await sendStatusLine(ctx, chatId, sessionKey, usage, exchanges[exchanges.length - 1]!.user);
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
    await replyMd(ctx, '⚠️ No active session. Use `/resume` first.');
    return;
  }
  if (!session.claudeSessionId) {
    await replyMd(ctx, 'ℹ️ This session has no recorded messages yet.');
    return;
  }

  const jsonlText = readLastAssistantTurnText(session.workingDirectory, session.claudeSessionId);
  if (!jsonlText) {
    await replyMd(ctx, 'ℹ️ No assistant reply found for the current turn.');
    return;
  }

  const relayed = sessionManager.getLastRelayedAssistantText(sessionKey);
  // Same 20-char slack as the proactive check — trim/whitespace deltas don't
  // count as a real miss.
  if (jsonlText.length <= relayed.length + 20) {
    await replyMd(ctx, "✅ You're caught up — nothing new in the session log.");
    return;
  }

  const missing = jsonlText.startsWith(relayed) && relayed.length > 0
    ? jsonlText.slice(relayed.length).trim()
    : jsonlText;
  if (!missing) {
    await replyMd(ctx, "✅ You're caught up — nothing new in the session log.");
    return;
  }

  await replyMd(ctx, '📨 **Sync** — from session log');
  await messageSender.sendMessage(ctx, missing);
  sessionManager.setLastRelayedAssistantText(sessionKey, jsonlText);
}

/**
 * /terminal: the command line that carries this session on in a terminal, as
 * a fork. It was /teleport until Claude Code had a /teleport of its own (send
 * a session to the cloud, or resume one from claude.ai), which the bot's
 * command of that name kept anyone from reaching.
 */
export async function handleTerminal(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;
  const { chatId } = parseSessionKey(sessionKey);

  const session = sessionManager.getSession(sessionKey);

  if (!session) {
    await replyMd(ctx, 'ℹ️ No active session to continue in a terminal.\n\nStart a conversation first with `/project <name>`.');
    return;
  }

  if (!session.claudeSessionId) {
    await replyMd(ctx, 'ℹ️ No Claude session available yet.\n\nSend a message first to start a session, then use `/terminal`.');
    return;
  }

  const projectName = path.basename(session.workingDirectory);
  const claudeBin = config.CLAUDE_EXECUTABLE_PATH ?? 'claude';
  // --fork-session: the chat's own claude still has this session open, and a
  // plain --resume would have two processes appending to one log. The fork
  // starts with the whole conversation under an id of its own.
  const command = `cd "${session.workingDirectory}" && ${claudeBin} --resume ${session.claudeSessionId} --fork-session`;

  const message = new EntityText()
    .add('💻 ').bold('Continue in a terminal')
    .add('\n\n').bold('Project:').add(' ').code(projectName)
    .newline().bold('Session:').add(' ').code(`${session.claudeSessionId.substring(0, 8)}...`)
    .add('\n\nCopy and run in your terminal:\n\n')
    .pre(command)
    .add('\n\n')
    .italic('The terminal gets a copy of the conversation as a new session, so this chat and the terminal can each carry on.')
    .build();

  await replyFormatted(ctx, message);
}
