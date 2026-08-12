import { Context, Api, InputFile, GrammyError } from 'grammy';
import { config } from '../config.js';
import { processMessageForTelegram, escapeMarkdownV2, splitMessage } from './markdown.js';
import { shouldUseTelegraph, createTelegraphPage, createTelegraphFromFile } from './telegraph.js';
import { isTerminalUIEnabled } from './terminal-settings.js';
import {
  getSpinnerFrame,
  getThinkingVerb,
  getToolIcon,
  getToolAction,
  renderStatusLine,
  renderBackgroundFooter,
  extractToolDetail,
  formatBashCommandBlock,
  elideToolOutput,
  stripAnsi,
  TOOL_ICONS,
} from './terminal-renderer.js';
import { taskTracker, type TaskState } from './task-tracker.js';
import type { TaskEvent, ToolResultEvent, EditDiffEvent } from '../providers/types.js';
import { getSessionKeyFromCtx, parseSessionKey } from '../utils/session-key.js';
import { resolveVerbosityFlags } from '../utils/verbosity.js';
import { actionLogger } from './action-logger.js';
import { sessionManager } from '../claude/session-manager.js';
import { sessionJsonlPath } from '../claude/session-jsonl.js';
import { messageOffsets, countJsonlLines } from '../claude/message-offsets.js';
import { storeSuggestion } from '../claude/pending-suggestions.js';
import { hasPendingQuestionForSession } from '../claude/ask-user.js';
import * as fs from 'fs';
import * as path from 'path';

const FORK_KEYBOARD = { inline_keyboard: [[{ text: '🍴 Fork', callback_data: 'fork:pick' }]] };

/**
 * Status-bubble text shown while an ask_user question is waiting on a tap.
 * Replaces the spinner: the watchdog is deliberately paused during a pending
 * question, so nothing else stops the bubble animating "Thinking…" at a turn
 * that is actually parked on the user.
 */
const AWAITING_ANSWER_LINE = '⏸️ Waiting for your answer — see the question above ↑';

/**
 * Truncate a suggestion text for inline button display. Telegram inline
 * button labels render best at <= ~40 chars; longer ones wrap awkwardly on
 * narrow screens.
 */
function formatSuggestionLabel(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 38 ? `💡 ${flat.slice(0, 36)}…` : `💡 ${flat}`;
}

/**
 * Register a suggestion in the pending-suggestions store and return the
 * options bag `attachForkButton` expects for adding the inline button.
 * Returns an empty options object when the suggestion is missing or blank
 * (caller still gets just the fork button).
 */
function buildSuggestionAttachOpts(
  sessionKey: string,
  suggestion: string | undefined,
): { suggestionId?: string; suggestionText?: string } {
  if (!suggestion || !suggestion.trim()) return {};
  const id = storeSuggestion(sessionKey, suggestion);
  return { suggestionId: id, suggestionText: suggestion };
}

export interface ToolOperation {
  name: string;
  detail?: string;
  /**
   * Multi-line command body rendered beneath the status header while the tool
   * runs (Bash only). Shown in a separate block so the header — and its live
   * timer — stay on one clean line.
   */
  commandBlock?: string;
}

interface StreamState {
  chatId: number;
  threadId?: number;
  sessionKey: string;
  messageId: number | null;
  content: string;
  lastUpdate: number;
  updateScheduled: boolean;
  typingInterval: NodeJS.Timeout | null;
  // Terminal UI mode additions
  terminalMode: boolean;
  spinnerIndex: number;
  spinnerInterval: NodeJS.Timeout | null;
  currentOperation: ToolOperation | null;
  operationStartTime: number;
  rateLimitedUntil: number;
  lastRateLimitDurationMs: number;
  // Claude Code's live spinner tip (PTY mode), mirrored under the status line.
  // Null when no tip is currently on screen.
  tip: string | null;
  // TodoWrite live-checklist rendering: id of the per-turn message we
  // edit on every TodoWrite call. Reset to null at the start of each turn
  // so the next TodoWrite posts a fresh checklist below the prior one.
  todoMessageId: number | null;
  todoLastRendered: string;
  // Action logging for verbose mode
  actionLogEnabled: boolean;
}

interface TodoItem {
  content: string;
  activeForm?: string;
  status: 'pending' | 'in_progress' | 'completed' | string;
}

const TYPING_INTERVAL_MS = 4000; // Send typing every 4 seconds
const MIN_EDIT_INTERVAL_MS = 10000; // Minimum time between message edits (~5 edits/min safe zone)
const MONITOR_TASK_TYPE = 'monitor_mcp';

// `mcp__claudegram-tools__claudegram_send_file` → `claudegram_send_file`
function stripMcpServerPrefix(toolName: string): string {
  if (!toolName.startsWith('mcp__')) return toolName;
  const lastSep = toolName.lastIndexOf('__');
  return lastSep > 0 ? toolName.slice(lastSep + 2) : toolName;
}

/**
 * Trim long absolute paths so a diff header reads `src/foo.ts` rather than
 * `/home/rik/dev/telecoder/src/foo.ts`. Falls back to the full path if no
 * prefix matches.
 */
function stripWorkingDir(filePath: string): string {
  const cwd = process.cwd();
  if (filePath.startsWith(cwd + '/')) return filePath.slice(cwd.length + 1);
  const home = process.env.HOME;
  if (home && filePath.startsWith(home + '/')) return '~/' + filePath.slice(home.length + 1);
  return filePath;
}

function formatTodoList(todos: TodoItem[]): string {
  const lines = ['📝 Todos'];
  for (const todo of todos) {
    if (todo.status === 'completed') {
      lines.push(`✅ ${todo.content}`);
    } else if (todo.status === 'in_progress') {
      lines.push(`⏳ ${todo.activeForm || todo.content}`);
    } else {
      lines.push(`☐ ${todo.content}`);
    }
  }
  return lines.join('\n');
}

export class MessageSender {
  private streamStates: Map<string, StreamState> = new Map();
  // Per-stream counter of new chat messages posted during the turn (TodoWrite
  // first render, monitor armed/events, sub-turn echoes, backgrounded task
  // completions). Drives two behaviors when > 0:
  //   - finishStreaming posts the final response as a fresh bottom message
  //     and reduces the original "Processing..." bubble to a pointer, so the
  //     final answer isn't buried above the intervening messages.
  //   - sendCompletionNotification suppresses the generic "✅ Done" ping —
  //     the bottom-posted final message is itself a notification.
  // Reset on startStreaming.
  private interveningPostsThisStream: Map<string, number> = new Map();

  private noteInterveningPost(sessionKey: string | undefined): void {
    if (!sessionKey) return;
    const prev = this.interveningPostsThisStream.get(sessionKey) ?? 0;
    this.interveningPostsThisStream.set(sessionKey, prev + 1);
  }

  /**
   * Send a message with hybrid approach:
   * - Short content: MarkdownV2 inline
   * - Long content or tables: Telegraph page link
   *
   * Returns the message_id of the last Telegram message posted, or null if
   * nothing was sent (every attempt failed). Callers that want to attach the
   * /fork button use this to know which message to anchor onto.
   */
  async sendMessage(ctx: Context, text: string): Promise<number | null> {
    const keyInfo = getSessionKeyFromCtx(ctx);
    let lastMessageId: number | null = null;
    // Check if we should use Telegraph for this content
    if (shouldUseTelegraph(text, keyInfo?.sessionKey)) {
      const pageUrl = await createTelegraphPage('Claude Response', text);

      if (pageUrl) {
        // Send Telegraph link with a brief summary
        const summary = text.substring(0, 200).replace(/[#*_`\[\]]/g, '') + '...';
        const message = `📄 *Full response available:*\n\n${escapeMarkdownV2(summary)}\n\n[Open in Instant View](${escapeMarkdownV2(pageUrl)})`;

        try {
          const sent = await ctx.reply(message, { parse_mode: 'MarkdownV2' });
          return sent.message_id;
        } catch (error) {
          console.error('[Telegraph] Failed to send link, falling back to chunks:', error);
        }
      }
    }

    // Default: MarkdownV2 with chunking
    const parts = processMessageForTelegram(text, config.MAX_MESSAGE_LENGTH);

    for (const part of parts) {
      try {
        const sent = await ctx.reply(part, { parse_mode: 'MarkdownV2' });
        lastMessageId = sent.message_id;
      } catch (error) {
        // MarkdownV2 failed for this part — fallback to plain text for just this part
        console.error('MarkdownV2 send failed for part, falling back to plain text:', error);
        try {
          // Try to send this specific part as plain text
          const sent = await ctx.reply(part.replace(/\\(.)/g, '$1'), { parse_mode: undefined });
          lastMessageId = sent.message_id;
        } catch (plainError) {
          console.error('Plain text send also failed for part:', plainError);
          // Last resort: send error message
          try {
            const sent = await ctx.reply('⚠️ Message formatting error', { parse_mode: undefined });
            lastMessageId = sent.message_id;
          } catch { /* give up */ }
        }
      }
    }
    return lastMessageId;
  }

  /**
   * Attach a "🍴 Fork" button to a past assistant message and record the
   * JSONL truncation point that corresponds to it. Idempotent: calling this
   * twice on the same message just re-records the offset (Telegram returns
   * "message is not modified" on the second edit, which we swallow).
   *
   * Safe to call when there's no active claudeSessionId or JSONL yet — we
   * silently skip in that case so the assistant turn isn't blocked by a
   * fork-tracking edge case.
   */
  async attachForkButton(
    ctx: Context,
    sessionKey: string,
    messageId: number | null | undefined,
    options: { suggestionId?: string; suggestionText?: string } = {},
  ): Promise<void> {
    if (!messageId) return;
    const session = sessionManager.getSession(sessionKey);
    if (!session?.claudeSessionId) return;

    const jsonlPath = sessionJsonlPath(session.workingDirectory, session.claudeSessionId);
    const lineCount = countJsonlLines(jsonlPath);
    if (lineCount === 0) return;

    messageOffsets.record(sessionKey, messageId, {
      claudeSessionId: session.claudeSessionId,
      projectPath: session.workingDirectory,
      lineCount,
      conversationId: session.conversationId,
    });

    // When a prompt suggestion is available, attach it on a row above the
    // fork button so the suggestion is the primary call-to-action and fork
    // stays available as the secondary affordance.
    const rows: Array<Array<{ text: string; callback_data: string }>> = [];
    if (options.suggestionId && options.suggestionText) {
      rows.push([{
        text: formatSuggestionLabel(options.suggestionText),
        callback_data: `sgt:${options.suggestionId}`,
      }]);
    }
    rows.push([{ text: '🍴 Fork', callback_data: 'fork:pick' }]);
    const replyMarkup = rows.length === 1 ? FORK_KEYBOARD : { inline_keyboard: rows };

    try {
      await ctx.api.editMessageReplyMarkup(
        ctx.chat!.id,
        messageId,
        { reply_markup: replyMarkup },
      );
    } catch (err) {
      // "message is not modified" or "message to edit not found" — non-fatal.
      const msg = err instanceof Error ? err.message.toLowerCase() : '';
      if (!msg.includes('not modified') && !msg.includes('not found') && !msg.includes('message_id_invalid')) {
        console.debug('[Fork] attachForkButton edit failed:', err instanceof Error ? err.message : err);
      }
    }
  }

  /**
   * Send a file as a document attachment
   */
  async sendDocument(ctx: Context, filePath: string, caption?: string): Promise<boolean> {
    try {
      if (!fs.existsSync(filePath)) {
        console.error('[Document] File not found:', filePath);
        return false;
      }

      const fileName = path.basename(filePath);
      const fileBuffer = fs.readFileSync(filePath);
      const inputFile = new InputFile(fileBuffer, fileName);

      await ctx.replyWithDocument(inputFile, {
        caption: caption ? escapeMarkdownV2(caption) : undefined,
        parse_mode: caption ? 'MarkdownV2' : undefined
      });

      return true;
    } catch (error) {
      console.error('[Document] Failed to send:', error);
      return false;
    }
  }

  /**
   * Send a markdown file with Telegraph preview option
   */
  async sendMarkdownFile(
    ctx: Context,
    filePath: string,
    options: { useTelegraph?: boolean; sendAsDocument?: boolean } = {}
  ): Promise<boolean> {
    const { useTelegraph = true, sendAsDocument = false } = options;

    try {
      if (!fs.existsSync(filePath)) {
        console.error('[Markdown] File not found:', filePath);
        return false;
      }

      const fileName = path.basename(filePath);
      const content = fs.readFileSync(filePath, 'utf-8');

      // Option 1: Telegraph (Instant View)
      if (useTelegraph) {
        const pageUrl = await createTelegraphFromFile(filePath);

        if (pageUrl) {
          const message = `📄 *${escapeMarkdownV2(fileName)}*\n\n[Open in Instant View](${escapeMarkdownV2(pageUrl)})`;

          await ctx.reply(message, { parse_mode: 'MarkdownV2' });

          // Also send as document if requested
          if (sendAsDocument) {
            await this.sendDocument(ctx, filePath, 'Download file');
          }

          return true;
        }
      }

      // Option 2: Send as document
      if (sendAsDocument) {
        return await this.sendDocument(ctx, filePath, `📎 ${fileName}`);
      }

      // Option 3: Send content inline
      await this.sendMessage(ctx, content);
      return true;
    } catch (error) {
      console.error('[Markdown] Failed to send:', error);
      return false;
    }
  }

  async startStreaming(ctx: Context): Promise<void> {
    const keyInfo = getSessionKeyFromCtx(ctx);
    if (!keyInfo) return;
    const { chatId, threadId, sessionKey } = keyInfo;

    const terminalMode = isTerminalUIEnabled(sessionKey);
    const verbosityFlags = resolveVerbosityFlags(chatId);
    const actionLogEnabled = verbosityFlags.useActionLog && (verbosityFlags.showToolResults || verbosityFlags.showDiffs);


    const initialText = `${getSpinnerFrame(0)} ${TOOL_ICONS.thinking} ${getThinkingVerb()}...`;
    const message = await ctx.reply(initialText, { parse_mode: undefined });

    // Start continuous typing indicator
    const typingInterval = this.startTypingIndicator(ctx.api, chatId, threadId);

    const now = Date.now();
    const state: StreamState = {
      chatId,
      threadId,
      sessionKey,
      messageId: message.message_id,
      content: '',
      lastUpdate: now,
      updateScheduled: false,
      typingInterval,
      // Terminal UI mode
      terminalMode,
      spinnerIndex: 0,
      spinnerInterval: null,
      currentOperation: null,
      operationStartTime: now,
      rateLimitedUntil: 0,
      lastRateLimitDurationMs: 0,
      tip: null,
      todoMessageId: null,
      todoLastRendered: '',
      actionLogEnabled,
    };

    // Register before anything else can throw. The typing indicator and the
    // thinking bubble are already live at this point, and the only handle on
    // them is `state` — if we bail out before registering, finish/cancel can't
    // find the stream and the "typing…" interval ticks forever.
    this.streamStates.set(sessionKey, state);
    this.interveningPostsThisStream.set(sessionKey, 0);

    // Initialize action logging if enabled. Cosmetic, so a failure here
    // degrades to a turn without an action log rather than no turn at all.
    if (actionLogEnabled) {
      try {
        await actionLogger.initialize(ctx, sessionKey);
      } catch (error) {
        console.error('[ActionLog] initialize failed, continuing without it:', error);
      }
    }

    // Periodic refresh so the elapsed timer and spinner update even during long tool runs
    if (terminalMode) {
      state.spinnerInterval = setInterval(() => {
        state.spinnerIndex += 1;
        if (ctx) {
          this.flushTerminalUpdate(ctx, state).catch(() => {});
        }
      }, MIN_EDIT_INTERVAL_MS);
    }
  }

  private stopSpinnerAnimation(state: StreamState): void {
    if (state.spinnerInterval) {
      clearInterval(state.spinnerInterval);
      state.spinnerInterval = null;
    }
  }

  startTypingIndicator(api: Api, chatId: number, threadId?: number): NodeJS.Timeout {
    const opts = threadId !== undefined ? { message_thread_id: threadId } : {};
    // Send typing immediately
    api.sendChatAction(chatId, 'typing', opts).catch(() => {});

    // Then send every TYPING_INTERVAL_MS
    return setInterval(() => {
      api.sendChatAction(chatId, 'typing', opts).catch(() => {});
    }, TYPING_INTERVAL_MS);
  }

  private stopTypingIndicator(state: StreamState): void {
    if (state.typingInterval) {
      clearInterval(state.typingInterval);
      state.typingInterval = null;
    }
  }

  stopTypingInterval(interval: NodeJS.Timeout): void {
    clearInterval(interval);
  }

  /**
   * Update the current tool operation (terminal UI mode).
   * Event-driven: triggers a status message edit on each tool change.
   */
  updateToolOperation(sessionKey: string, toolName: string, input?: Record<string, unknown>, ctx?: Context): void {
    const state = this.streamStates.get(sessionKey);
    if (!state) return;

    // TodoWrite gets a dedicated live-checklist message instead of the
    // generic terminal-UI status bubble — render and skip the normal path.
    if (toolName === 'TodoWrite' && ctx && Array.isArray((input as { todos?: unknown })?.todos)) {
      this.renderTodoWrite(ctx, state, (input as { todos: TodoItem[] }).todos).catch((err) => {
        console.error('[TodoWrite] Render failed:', err);
      });
      return;
    }

    if (!state.terminalMode) return;

    const { chatId } = parseSessionKey(sessionKey);
    const verbose = resolveVerbosityFlags(chatId).terminalUiVerbose;
    if (toolName === 'Bash') {
      // Show the full command in a block beneath the header (capped per the
      // verbose flag) instead of just its first line on the `→` row — a leading
      // `cd` otherwise hides the slow work the timer is actually counting.
      const command = typeof input?.command === 'string' ? input.command : undefined;
      state.currentOperation = { name: toolName, commandBlock: formatBashCommandBlock(command, verbose) };
    } else {
      const detail = input ? extractToolDetail(toolName, input, verbose) : undefined;
      state.currentOperation = { name: toolName, detail };
    }
    state.operationStartTime = Date.now();
    state.spinnerIndex += 1;

    if (ctx) {
      this.flushTerminalUpdate(ctx, state).catch(() => {});
    }
  }

  /**
   * Render TodoWrite as a single Telegram message that we edit in place
   * for every subsequent TodoWrite call in the same turn.
   */
  private async renderTodoWrite(ctx: Context, state: StreamState, todos: TodoItem[]): Promise<void> {
    const text = formatTodoList(todos);
    if (text === state.todoLastRendered) return;

    const sendOpts = state.threadId !== undefined ? { message_thread_id: state.threadId } : {};

    if (state.todoMessageId === null) {
      const sent = await ctx.api.sendMessage(state.chatId, text, sendOpts);
      state.todoMessageId = sent.message_id;
      state.todoLastRendered = text;
      this.noteInterveningPost(state.sessionKey);
      return;
    }

    try {
      await ctx.api.editMessageText(state.chatId, state.todoMessageId, text);
      state.todoLastRendered = text;
    } catch (err) {
      const description = err instanceof GrammyError ? err.description : '';
      if (description.includes('message is not modified')) {
        state.todoLastRendered = text;
        return;
      }
      // Message gone or unreachable — fall back to posting a fresh one.
      const sent = await ctx.api.sendMessage(state.chatId, text, sendOpts);
      state.todoMessageId = sent.message_id;
      state.todoLastRendered = text;
      this.noteInterveningPost(state.sessionKey);
    }
  }

  /**
   * Clear the current tool operation (terminal UI mode)
   */
  clearToolOperation(sessionKey: string): void {
    const state = this.streamStates.get(sessionKey);
    if (!state) return;
    state.currentOperation = null;
  }

  /**
   * Apply an SDK task lifecycle event. Updates the per-session task tracker,
   * surfaces Monitor task events as their own chat messages, posts a
   * chat-level completion message on backgrounded `task_notification` events,
   * and refreshes the streaming UI footer.
   */
  async notifyTaskEvent(ctx: Context, sessionKey: string, event: TaskEvent): Promise<void> {
    const state = taskTracker.handleEvent(sessionKey, event);
    const isMonitor = state?.taskType === MONITOR_TASK_TYPE;

    if (event.type === 'started' && state && isMonitor) {
      await this.postMonitorArmed(ctx, state);
    } else if (event.type === 'progress' && state && isMonitor) {
      const eventText = event.summary ?? event.description;
      if (eventText) await this.postMonitorEvent(ctx, state, eventText);
    } else if (event.type === 'notification' && state) {
      await this.postTaskCompletion(ctx, state);
      taskTracker.remove(sessionKey, event.taskId);
    }

    const streamState = this.streamStates.get(sessionKey);
    if (streamState && streamState.terminalMode) {
      streamState.spinnerIndex += 1;
      this.flushTerminalUpdate(ctx, streamState).catch(() => {});
    }
  }

  private async postMonitorArmed(ctx: Context, task: TaskState): Promise<void> {
    if (task.skipTranscript) return;
    const description = task.description.length > 100
      ? task.description.substring(0, 97) + '...'
      : task.description;
    const text = `📡 Monitor "${escapeMarkdownV2(description)}" armed`;
    let posted: { message_id: number } | null = null;
    try {
      posted = await ctx.reply(text, { parse_mode: 'MarkdownV2' });
    } catch (error) {
      console.error('[Task] Failed to post monitor armed:', error instanceof Error ? error.message : error);
      try {
        posted = await ctx.reply(`📡 Monitor "${task.description}" armed`);
      } catch { /* ignore */ }
    }
    if (posted) {
      task.armedMessageId = posted.message_id;
      this.noteInterveningPost(getSessionKeyFromCtx(ctx)?.sessionKey);
    }
  }

  private async postMonitorEvent(ctx: Context, task: TaskState, eventText: string): Promise<void> {
    if (task.skipTranscript) return;

    // Use action logging if enabled
    const keyInfo = getSessionKeyFromCtx(ctx);
    const sessionKey = keyInfo?.sessionKey;
    if (sessionKey && actionLogger.isActive(sessionKey)) {
      await actionLogger.addMonitorEvent(ctx, sessionKey, task, eventText);
      return;
    }

    // Fall back to original behavior
    const truncated = eventText.length > 1000
      ? eventText.substring(0, 997) + '...'
      : eventText;
    const text = `📡 Monitor event: ${escapeMarkdownV2(truncated)}`;
    let posted = false;
    try {
      await ctx.reply(text, { parse_mode: 'MarkdownV2' });
      posted = true;
    } catch (error) {
      console.error('[Task] Failed to post monitor event:', error instanceof Error ? error.message : error);
      try {
        await ctx.reply(`📡 Monitor event: ${eventText.substring(0, 1000)}`);
        posted = true;
      } catch { /* ignore */ }
    }
    if (posted) this.noteInterveningPost(getSessionKeyFromCtx(ctx)?.sessionKey);
  }

  /**
   * Post the "🔔 Scheduled: …" header that precedes a scheduled-task fire.
   * The scheduled prompt itself is then enqueued through the normal turn
   * pipeline; this header just makes the unprompted message obvious so the
   * user understands why a turn appeared with no input from them.
   */
  async postScheduledFire(ctx: Context, label: string, prompt: string): Promise<void> {
    const preview = prompt.length > 100 ? prompt.substring(0, 97) + '...' : prompt;
    const headline = label
      ? `🔔 *Scheduled* — ${escapeMarkdownV2(label)}`
      : `🔔 *Scheduled fire*`;
    const text = `${headline}\n\`${escapeMarkdownV2(preview)}\``;
    try {
      await ctx.reply(text, { parse_mode: 'MarkdownV2' });
    } catch (error) {
      console.error('[Schedule] Failed to post scheduled header:', error instanceof Error ? error.message : error);
      try {
        await ctx.reply(`🔔 Scheduled${label ? ` — ${label}` : ''}\n${preview}`);
      } catch { /* ignore */ }
    }
    this.noteInterveningPost(getSessionKeyFromCtx(ctx)?.sessionKey);
  }

  /**
   * Post the model's text response from an SDK-driven sub-turn (monitor
   * event echoes, post-task_notification commentary) as its own Telegram
   * message. Routed through the MarkdownV2 formatter so the model's
   * intended formatting renders, with a per-part fallback to plain text
   * for chunks that fail to parse (raw log content can contain unescaped
   * `_*[]`).
   */
  async postSubTurnResponse(ctx: Context, text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    const parts = processMessageForTelegram(trimmed, config.MAX_MESSAGE_LENGTH);
    const sessionKey = getSessionKeyFromCtx(ctx)?.sessionKey;
    for (const part of parts) {
      try {
        await ctx.reply(part, { parse_mode: 'MarkdownV2' });
      } catch (error) {
        console.error('[Task] MarkdownV2 sub-turn send failed, falling back to plain text:', error instanceof Error ? error.message : error);
        try {
          // Remove escaping for plain text fallback
          await ctx.reply(part.replace(/\\(.)/g, '$1'), { parse_mode: undefined });
        } catch (plainError) {
          console.error('[Task] Plain-text sub-turn send failed:', plainError instanceof Error ? plainError.message : plainError);
          await ctx.reply('⚠️ Message formatting error', { parse_mode: undefined });
        }
      }
    }
    this.noteInterveningPost(sessionKey);
  }

  /**
   * If action-log mode is on for this chat AND the verbosity tier shows tool
   * output, lazily initialize the logger and hand off to `forward`. Returns
   * true when the action log took the message — callers fall through to the
   * direct-post path when it returns false.
   */
  private async routeToActionLog(
    ctx: Context,
    forward: (sessionKey: string) => Promise<void>,
  ): Promise<boolean> {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return false;
    const flags = resolveVerbosityFlags(chatId);
    if (!flags.useActionLog || !(flags.showToolResults || flags.showDiffs)) return false;
    const sessionKey = getSessionKeyFromCtx(ctx)?.sessionKey;
    if (!sessionKey) return false;
    if (!actionLogger.isActive(sessionKey)) {
      // No log for this session. Only open one if a turn is actually
      // streaming — otherwise this is a straggler arriving after the turn
      // ended and the log was collapsed and cleaned up (5s after finishStream),
      // and initializing here would start a *second*, live-looking action log
      // below the collapsed summary. Stragglers post as their own message
      // instead, matching what postMonitorEvent already does.
      if (!this.streamStates.has(sessionKey)) {
        console.debug(`[ActionLog] Straggler for ${sessionKey} after log cleanup — posting directly instead of opening a new log`);
        return false;
      }
      await actionLogger.initialize(ctx, sessionKey);
    }
    await forward(sessionKey);
    return true;
  }

  /**
   * Post a truncated preview of a tool's result. In action log mode, adds to
   * the consolidated log; otherwise sends as its own Telegram message.
   * Sent only when the chat's verbosity tier resolves `showToolResults: true`
   * (caller is responsible for the gate). Uses plain text — tool output can
   * contain anything, and trying to escape it into MarkdownV2 invites parse
   * errors. The streaming bubble is pushed below via `noteInterveningPost`.
   */
  async postToolResult(
    ctx: Context,
    event: ToolResultEvent,
    maxLines: number,
    maxChars: number,
  ): Promise<void> {
    if (await this.routeToActionLog(ctx, (sk) => actionLogger.addToolResult(ctx, sk, event, maxLines, maxChars))) {
      return;
    }

    // Fall back to original behavior
    const cleaned = stripAnsi(event.content).replace(/\s+$/u, '');
    if (!cleaned && !event.isError) return;

    const icon = event.toolName ? getToolIcon(event.toolName) : '🔹';
    const label = event.toolName ? stripMcpServerPrefix(event.toolName) : 'tool';
    const verb = event.isError ? 'error' : 'result';

    // Tail-biased for errors (failures land at the end), head-biased for
    // success — middle elided either way (see elideToolOutput).
    const body = elideToolOutput(cleaned || '(no output)', maxLines, maxChars, { isError: event.isError });

    const detail = event.toolName && event.input
      ? extractToolDetail(event.toolName, event.input, true)
      : undefined;
    const detailLine = detail
      ? `${event.toolName === 'Bash' ? '$ ' : ''}${detail}\n`
      : '';

    const text = `${icon} ${label} ${verb}\n${detailLine}${body}`;
    try {
      await ctx.reply(text, { parse_mode: undefined });
      this.noteInterveningPost(getSessionKeyFromCtx(ctx)?.sessionKey);
    } catch (err) {
      console.error('[ToolResult] Failed to post:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Post a before/after preview for a successful Edit or Write call. In action
   * log mode, adds to the consolidated log; otherwise sends as its own message.
   * Each side is independently capped at `maxLines` and prefixed with `-`/`+`.
   * Write (new file) skips the `-` side. Plain-text rendering — tool output
   * can contain anything that would break MarkdownV2 parsing.
   */
  async postEditDiff(ctx: Context, event: EditDiffEvent, maxLines: number): Promise<void> {
    if (await this.routeToActionLog(ctx, (sk) => actionLogger.addEditDiff(ctx, sk, event, maxLines))) {
      return;
    }

    // Fall back to original behavior
    const fileLabel = stripWorkingDir(event.filePath);
    const headerIcon = event.toolName === 'Write' ? '✏️' : '🔧';
    const lines: string[] = [`${headerIcon} ${event.toolName} ${fileLabel}`];

    if (typeof event.oldString === 'string' && event.oldString.length > 0) {
      const oldLines = event.oldString.split('\n');
      const oldShown = oldLines.slice(0, maxLines).map((l) => `- ${l}`);
      if (oldLines.length > maxLines) {
        oldShown.push(`- [+${oldLines.length - maxLines} more lines]`);
      }
      lines.push(...oldShown);
    }

    const newLines = event.newString.split('\n');
    const newShown = newLines.slice(0, maxLines).map((l) => `+ ${l}`);
    if (newLines.length > maxLines) {
      newShown.push(`+ [+${newLines.length - maxLines} more lines]`);
    }
    lines.push(...newShown);

    const text = lines.join('\n');
    try {
      await ctx.reply(text, { parse_mode: undefined });
      this.noteInterveningPost(getSessionKeyFromCtx(ctx)?.sessionKey);
    } catch (err) {
      console.error('[EditDiff] Failed to post:', err instanceof Error ? err.message : err);
    }
  }

  private async postTaskCompletion(ctx: Context, task: TaskState): Promise<void> {
    // Skip ambient/housekeeping tasks and foreground subagents — only
    // backgrounded tasks deserve a separate notification message.
    if (task.skipTranscript) return;
    if (!task.isBackgrounded) return;

    // Use action logging if enabled
    const keyInfo = getSessionKeyFromCtx(ctx);
    const sessionKey = keyInfo?.sessionKey;
    if (sessionKey && actionLogger.isActive(sessionKey)) {
      await actionLogger.addTaskCompletion(ctx, sessionKey, task);
      return;
    }

    // Fall back to original behavior

    const isMonitor = task.taskType === MONITOR_TASK_TYPE;

    const statusIcon = task.status === 'completed'
      ? (isMonitor ? '📡' : '✅')
      : task.status === 'stopped' ? '🛑' : '❌';
    const verb = task.status === 'completed'
      ? (isMonitor ? 'stream ended' : 'completed')
      : task.status === 'stopped' ? 'stopped' : 'failed';

    const elapsedMs = (task.endedAt ?? Date.now()) - task.startedAt;
    const seconds = Math.round(elapsedMs / 1000);
    const duration = seconds >= 60
      ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
      : `${seconds}s`;

    const description = task.description.length > 100
      ? task.description.substring(0, 97) + '...'
      : task.description;

    // Single-line format matching Claude Code's TUI:
    //   ✅ Background task "<description>" completed in 54s
    //   📡 Monitor "<description>" stream ended after 12s
    const headline = isMonitor
      ? `${statusIcon} Monitor "${escapeMarkdownV2(description)}" ${escapeMarkdownV2(verb)} after ${escapeMarkdownV2(duration)}`
      : `${statusIcon} Background task "${escapeMarkdownV2(description)}" ${verb} in ${escapeMarkdownV2(duration)}`;
    const lines: string[] = [headline];
    if (task.error) {
      lines.push(`⚠️ ${escapeMarkdownV2(task.error)}`);
    }
    const body = lines.join('\n');
    const fallbackBody = isMonitor
      ? `${statusIcon} Monitor "${task.description}" ${verb} after ${duration}${task.error ? `\n⚠️ ${task.error}` : ''}`
      : `${statusIcon} Background task "${task.description}" ${verb} in ${duration}${task.error ? `\n⚠️ ${task.error}` : ''}`;

    // If we still know the armed-message id, edit it in place so the chat
    // doesn't keep showing a stale "armed" line. Only post a fresh message
    // (which triggers a Telegram notification and lands at the bottom of the
    // chat) when the task ran long enough that the user likely walked away —
    // matching sendCompletionNotification's threshold — or when there's an
    // error the user needs to see.
    const chatId = ctx.chat?.id;
    const longRunning = elapsedMs >= config.NOTIFICATION_THRESHOLD_SECONDS * 1000;
    const shouldEdit = task.armedMessageId !== undefined && chatId !== undefined;
    const shouldPostFresh = !shouldEdit || longRunning || !!task.error;

    if (shouldEdit) {
      try {
        await ctx.api.editMessageText(chatId!, task.armedMessageId!, body, { parse_mode: 'MarkdownV2' });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        // "message is not modified" is benign; everything else falls back to
        // posting a fresh message so the user still learns about completion.
        if (!/not modified/i.test(msg)) {
          console.error('[Task] Failed to edit armed message:', msg);
          try {
            await ctx.api.editMessageText(chatId!, task.armedMessageId!, fallbackBody);
          } catch { /* fall through to fresh post if posting was already gated */ }
        }
      }
    }

    if (!shouldPostFresh) return;

    let posted = false;
    try {
      await ctx.reply(body, { parse_mode: 'MarkdownV2' });
      posted = true;
    } catch (error) {
      console.error('[Task] Failed to post completion message:', error instanceof Error ? error.message : error);
      try {
        await ctx.reply(fallbackBody);
        posted = true;
      } catch { /* ignore */ }
    }
    if (posted) this.noteInterveningPost(getSessionKeyFromCtx(ctx)?.sessionKey);
  }

  private async flushTerminalUpdate(ctx: Context, state: StreamState): Promise<void> {
    // Verify state is still active
    const currentState = this.streamStates.get(state.sessionKey);
    if (!currentState || currentState !== state || !state.messageId || !state.terminalMode) {
      return;
    }

    // Respect Telegram's retry_after backoff on 429
    const now = Date.now();
    if (now < state.rateLimitedUntil) {
      return;
    }

    // Throttle edits to avoid rate limits
    const timeSinceLastUpdate = now - state.lastUpdate;
    if (timeSinceLastUpdate < MIN_EDIT_INTERVAL_MS) {
      return;
    }

    const parts: string[] = [];

    // A pending ask_user question outranks the tool/thinking status: the turn
    // is blocked on a button tap, and a spinner here reads as work still in
    // progress, which is exactly the cue that makes a question easy to miss.
    const awaitingAnswer = hasPendingQuestionForSession(state.sessionKey);
    if (awaitingAnswer) {
      parts.push(AWAITING_ANSWER_LINE);
    } else if (state.currentOperation) {
      const icon = getToolIcon(state.currentOperation.name);
      const action = getToolAction(state.currentOperation.name);
      const detail = state.currentOperation.detail ? ` ${state.currentOperation.detail}` : '';
      const elapsedMs = now - state.operationStartTime;
      const pausedMs = state.lastRateLimitDurationMs > 0 ? state.lastRateLimitDurationMs : undefined;
      parts.push(renderStatusLine(state.spinnerIndex, icon, action, detail ? detail.trim() : undefined, elapsedMs, pausedMs));
      // Bash commands render their (possibly multi-line) command in a separate
      // block below the header so the timer stays on a clean single line. The
      // `$ ` prefix marks the first line like a shell paste.
      if (state.currentOperation.commandBlock) {
        parts.push(`$ ${state.currentOperation.commandBlock}`);
      }
    }

    // If nothing to show, show thinking indicator
    if (parts.length === 0) {
      parts.push(`${getSpinnerFrame(state.spinnerIndex)} ${TOOL_ICONS.thinking} ${getThinkingVerb()}...`);
    }

    // Mirror Claude Code's live spinner tip under the status line, as the TUI
    // shows it. Scraped from the PTY render; null when no tip is on screen.
    // Suppressed while a question is pending — the tip is whatever was on
    // screen when the model blocked, and it dilutes the one line that matters.
    if (state.tip && !awaitingAnswer) {
      parts.push(`  ⎿ 💡 ${state.tip}`);
    }

    // Append compact footer when SDK background tasks are running.
    const backgroundedTasks = taskTracker.getBackgroundedTasks(state.sessionKey);
    const footer = renderBackgroundFooter(backgroundedTasks);
    if (footer) {
      parts.push('');
      parts.push(footer);
    }

    const displayContent = parts.join('\n');

    try {
      await ctx.api.editMessageText(
        state.chatId,
        state.messageId,
        displayContent,
        { parse_mode: undefined }
      );
      state.lastUpdate = Date.now();
      // Successful edit — clear any rate-limit annotation after it's been shown once
      state.lastRateLimitDurationMs = 0;
    } catch (error: unknown) {
      if (error instanceof GrammyError && error.error_code === 429) {
        const retryAfter = error.parameters.retry_after ?? 60;
        state.rateLimitedUntil = Date.now() + retryAfter * 1000;
        state.lastRateLimitDurationMs = retryAfter * 1000;
        console.warn(`[Terminal] Rate limited, backing off for ${retryAfter}s (session:${state.sessionKey})`);
        return;
      }
      // Ignore "message not modified" and "message ID invalid" errors
      // The latter happens when streaming ends and message is replaced
      if (error instanceof Error) {
        const msg = error.message.toLowerCase();
        if (!msg.includes('message is not modified') && !msg.includes('message_id_invalid')) {
          console.error('Error updating terminal stream:', error);
        }
      }
    }
  }

  /**
   * Accumulate streamed text content internally without triggering Telegram edits.
   * The full content is only displayed when finishStreaming() is called.
   */
  updateStream(_ctx: Context, content: string): void {
    const keyInfo = getSessionKeyFromCtx(_ctx);
    if (!keyInfo) return;

    const state = this.streamStates.get(keyInfo.sessionKey);
    if (!state || !state.messageId) return;

    state.content = content;
  }

  /**
   * Mirror Claude Code's live spinner tip (PTY mode) under the status line.
   * Pass null to clear it. Attempts an immediate flush so the tip appears
   * promptly; the flush respects the normal edit throttle, and the periodic
   * spinner refresh picks it up otherwise.
   */
  updateTip(ctx: Context, tip: string | null): void {
    const keyInfo = getSessionKeyFromCtx(ctx);
    if (!keyInfo) return;

    const state = this.streamStates.get(keyInfo.sessionKey);
    if (!state || !state.messageId || !state.terminalMode) return;
    if (state.tip === tip) return;

    state.tip = tip;
    this.flushTerminalUpdate(ctx, state).catch(() => {});
  }

  /**
   * An ask_user question has just been posted to the chat.
   *
   * Counts it as an intervening post so finishStreaming publishes the final
   * answer as a fresh message at the bottom. Without this the counter stays at
   * 0 and the answer is edited into the status bubble — which sits *above* the
   * question — and a Telegram edit neither notifies nor re-orders, so the
   * question remains the last thing in the chat while the answer lands
   * silently upstream where it is easy to never see.
   *
   * Also repoints the status bubble at the user; see {@link AWAITING_ANSWER_LINE}.
   */
  async noteQuestionPosted(ctx: Context, sessionKey: string): Promise<void> {
    this.noteInterveningPost(sessionKey);
    await this.refreshQuestionStatus(ctx, sessionKey);
  }

  /**
   * Counterpart to {@link noteQuestionPosted}, called once the question is
   * resolved — by a tap or by timing out — so the bubble drops the waiting
   * notice and goes back to reporting progress.
   */
  async noteQuestionAnswered(ctx: Context, sessionKey: string): Promise<void> {
    await this.refreshQuestionStatus(ctx, sessionKey);
  }

  /**
   * Re-render the status bubble to match the session's current pending-question
   * state. Reads the registry rather than tracking a flag of its own, so the
   * bubble cannot disagree with it — overlapping asks and timeouts both land
   * on the right text without extra bookkeeping.
   */
  private async refreshQuestionStatus(ctx: Context, sessionKey: string): Promise<void> {
    const state = this.streamStates.get(sessionKey);
    if (!state || !state.messageId) return;

    if (state.terminalMode) {
      // Bypass the edit throttle: the point of the notice is that it lands
      // now, not up to MIN_EDIT_INTERVAL_MS later on the next spinner tick.
      state.lastUpdate = 0;
      await this.flushTerminalUpdate(ctx, state).catch(() => {});
      return;
    }

    // Non-terminal mode never re-renders the bubble on its own — updateStream
    // only accumulates text for finishStreaming — so edit it directly.
    const text = hasPendingQuestionForSession(sessionKey)
      ? AWAITING_ANSWER_LINE
      : `${getSpinnerFrame(state.spinnerIndex)} ${TOOL_ICONS.thinking} ${getThinkingVerb()}...`;
    try {
      await ctx.api.editMessageText(state.chatId, state.messageId, text, { parse_mode: undefined });
    } catch {
      // Cosmetic — a failed edit just leaves the previous status text in place.
    }
  }

  async finishStreaming(
    ctx: Context,
    finalContent: string,
    options: { nextPromptSuggestion?: string } = {},
  ): Promise<void> {
    const keyInfo = getSessionKeyFromCtx(ctx);
    if (!keyInfo) return;
    const { chatId, sessionKey } = keyInfo;

    const state = this.streamStates.get(sessionKey);
    if (!state) return;

    // Stop typing indicator and spinner
    this.stopTypingIndicator(state);
    this.stopSpinnerAnimation(state);
    state.currentOperation = null;

    // Track the last Telegram message we posted in this turn so the /fork
    // button can be anchored to the final user-visible message (so a tap
    // forks AT that point, not at some earlier chunk).
    let lastMessageId: number | null = state.messageId;

    if (state.messageId) {
      const hasInterveningPosts = (this.interveningPostsThisStream.get(sessionKey) ?? 0) > 0;
      const actionLogWasActive = actionLogger.isActive(sessionKey);

      // If the action log was used OR other messages interrupted the flow,
      // post the final answer as a new message for better visibility.
      if (hasInterveningPosts || actionLogWasActive) {
        const trimmedFinal = finalContent.trim();
        if (!trimmedFinal) {
          try {
            await ctx.api.editMessageText(chatId, state.messageId, '✅ Done', { parse_mode: undefined });
          } catch (err) {
            console.debug('[Stream] Done edit failed:', err instanceof Error ? err.message : err);
          }
        } else {
          try {
            await ctx.api.editMessageText(
              chatId,
              state.messageId,
              '✅ Done — full response below ↓',
              { parse_mode: undefined },
            );
          } catch (err) {
            console.debug('[Stream] Pointer edit failed:', err instanceof Error ? err.message : err);
          }
          const sentId = await this.sendMessage(ctx, finalContent);
          if (sentId) lastMessageId = sentId;
        }
      } else {
        // Original behavior: No intervening posts, so edit the main message directly.
        if (shouldUseTelegraph(finalContent, sessionKey)) {
          const pageUrl = await createTelegraphPage('Claude Response', finalContent);
          if (pageUrl) {
            try {
              const summary = finalContent.substring(0, 200).replace(/[#*_`\[\]]/g, '') + '...';
              const message = `📄 *Response ready:*\n\n${escapeMarkdownV2(summary)}\n\n[Open in Instant View](${escapeMarkdownV2(pageUrl)})`;
              await ctx.api.editMessageText(chatId, state.messageId, message, { parse_mode: 'MarkdownV2' });
              await this.attachForkButton(ctx, sessionKey, state.messageId, buildSuggestionAttachOpts(sessionKey, options.nextPromptSuggestion));
              // Early exit on success
              this.streamStates.delete(sessionKey);
              return;
            } catch (error) {
              console.error('[Telegraph] Failed, falling back to chunks:', error);
            }
          }
        }

        const parts = processMessageForTelegram(finalContent, config.MAX_MESSAGE_LENGTH);
        try {
          const firstPart = parts[0] || 'Done\\.';
          await ctx.api.editMessageText(chatId, state.messageId, firstPart, { parse_mode: 'MarkdownV2' });

          for (let i = 1; i < parts.length; i++) {
            try {
              const sent = await ctx.reply(parts[i], { parse_mode: 'MarkdownV2' });
              lastMessageId = sent.message_id;
            } catch (partError) {
              console.error(`MarkdownV2 failed for part ${i + 1}:`, partError);
              const sent = await ctx.reply(parts[i].replace(/\\(.)/g, '$1'), { parse_mode: undefined });
              lastMessageId = sent.message_id;
            }
          }
        } catch (mdError) {
            const errMsg = mdError instanceof Error ? mdError.message : '';
            if (errMsg.includes('message is not modified')) {
              console.debug('[Stream] Edit skipped — content unchanged');
            } else {
              console.error('MarkdownV2 edit failed, falling back to sendMessage:', mdError);
              try {
                await ctx.api.deleteMessage(chatId, state.messageId);
              } catch { /* ignore */ }
              const sentId = await this.sendMessage(ctx, finalContent);
              lastMessageId = sentId ?? null;
            }
        }
      }
    }

    await this.attachForkButton(ctx, sessionKey, lastMessageId, buildSuggestionAttachOpts(sessionKey, options.nextPromptSuggestion));

    this.streamStates.delete(sessionKey);

    // Delay action logging cleanup to allow for any remaining tool results,
    // then collapse the live log into a Telegraph link before discarding state.
    if (keyInfo?.sessionKey && actionLogger.isActive(keyInfo.sessionKey)) {
      const sk = keyInfo.sessionKey;
      setTimeout(async () => {
        try {
          await actionLogger.finalize(ctx, sk);
        } finally {
          actionLogger.cleanup(sk);
        }
      }, 5000); // 5 second delay to allow tool results to be processed
    }
  }

  /**
   * Edit the in-flight streaming message to a cancel/error banner and tear
   * down the per-turn streaming state. `reason` is either an explicit banner
   * string or the Error that ended the turn; an Error whose `name` is
   * `ClaudeApiError` gets a distinct banner so users can tell a Claude Code
   * API failure apart from a /stop they initiated themselves.
   */
  async cancelStreaming(ctx: Context, reason: string | Error = '⚠️ Request cancelled'): Promise<void> {
    const banner = typeof reason === 'string'
      ? reason
      : (reason?.name === 'ClaudeApiError' ? '⚠️ Claude API error — turn aborted' : '⚠️ Request cancelled');

    const keyInfo = getSessionKeyFromCtx(ctx);
    if (!keyInfo) return;
    const { chatId, sessionKey } = keyInfo;

    const state = this.streamStates.get(sessionKey);
    if (state) {
      // Stop typing indicator and spinner
      this.stopTypingIndicator(state);
      this.stopSpinnerAnimation(state);

      if (state.messageId) {
        try {
          await ctx.api.editMessageText(
            chatId,
            state.messageId,
            banner,
            { parse_mode: undefined }
          );
        } catch (error) {
          console.error('Error cancelling stream:', error);
        }
      }
    }

    this.streamStates.delete(sessionKey);

    // Delay action logging cleanup to allow for any remaining tool results,
    // then collapse the live log into a Telegraph link before discarding state.
    if (keyInfo?.sessionKey && actionLogger.isActive(keyInfo.sessionKey)) {
      const sk = keyInfo.sessionKey;
      setTimeout(async () => {
        try {
          await actionLogger.finalize(ctx, sk);
        } finally {
          actionLogger.cleanup(sk);
        }
      }, 5000); // 5 second delay to allow tool results to be processed
    }
  }

  /**
   * Send a brief new message to trigger a push notification after a long task.
   * Telegram only notifies on new messages, not edits — so streaming mode
   * needs this to alert the user when a long task finishes.
   *
   * Suppressed when at least one backgrounded-task completion message was
   * already posted during this stream — that message is itself a new chat
   * message, which triggers a notification on its own.
   */
  async sendCompletionNotification(ctx: Context, elapsedMs: number): Promise<void> {
    if (!config.NOTIFICATION_ENABLED) return;
    if (elapsedMs < config.NOTIFICATION_THRESHOLD_SECONDS * 1000) return;

    const chatId = ctx.chat?.id;
    if (chatId !== undefined && !resolveVerbosityFlags(chatId).sendCompletionPing) return;

    const sessionKey = getSessionKeyFromCtx(ctx)?.sessionKey;
    if (sessionKey) {
      const intervening = this.interveningPostsThisStream.get(sessionKey) ?? 0;
      if (intervening > 0) return;
    }

    try {
      const seconds = Math.round(elapsedMs / 1000);
      const duration = seconds >= 60
        ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
        : `${seconds}s`;
      await ctx.reply(`✅ Done (${duration})`, { parse_mode: undefined });
    } catch (error) {
      console.error('[Notification] Failed to send completion notification:', error);
    }
  }

  // Send typing indicator for a specific chat (useful for long operations)
  async sendTyping(ctx: Context): Promise<void> {
    try {
      await ctx.api.sendChatAction(ctx.chat!.id, 'typing');
    } catch (error) {
      console.error('Error sending typing:', error);
    }
  }
}

export const messageSender = new MessageSender();
