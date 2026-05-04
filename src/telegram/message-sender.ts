import { Context, Api, InputFile, GrammyError } from 'grammy';
import { config } from '../config.js';
import { processMessageForTelegram, escapeMarkdownV2, splitMessage } from './markdown.js';
import { shouldUseTelegraph, createTelegraphPage, createTelegraphFromFile } from './telegraph.js';
import { isTerminalUIEnabled } from './terminal-settings.js';
import {
  getSpinnerFrame,
  getToolIcon,
  getToolAction,
  renderStatusLine,
  renderBackgroundFooter,
  extractToolDetail,
  TOOL_ICONS,
} from './terminal-renderer.js';
import { taskTracker, type TaskState } from './task-tracker.js';
import type { TaskEvent } from '../providers/types.js';
import { getSessionKeyFromCtx } from '../utils/session-key.js';
import * as fs from 'fs';
import * as path from 'path';

export interface ToolOperation {
  name: string;
  detail?: string;
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
  // TodoWrite live-checklist rendering: id of the per-turn message we
  // edit on every TodoWrite call. Reset to null at the start of each turn
  // so the next TodoWrite posts a fresh checklist below the prior one.
  todoMessageId: number | null;
  todoLastRendered: string;
}

interface TodoItem {
  content: string;
  activeForm?: string;
  status: 'pending' | 'in_progress' | 'completed' | string;
}

const TYPING_INTERVAL_MS = 4000; // Send typing every 4 seconds
const MIN_EDIT_INTERVAL_MS = 10000; // Minimum time between message edits (~5 edits/min safe zone)
const MONITOR_TASK_TYPE = 'monitor_mcp';

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
  // Per-stream counter of task-completion messages posted. When > 0, the
  // generic long-task `✅ Done` notification is suppressed to avoid pinging
  // the user twice for the same long task. Reset on startStreaming.
  private taskCompletionsPostedThisStream: Map<string, number> = new Map();

  /**
   * Send a message with hybrid approach:
   * - Short content: MarkdownV2 inline
   * - Long content or tables: Telegraph page link
   */
  async sendMessage(ctx: Context, text: string): Promise<void> {
    const keyInfo = getSessionKeyFromCtx(ctx);
    // Check if we should use Telegraph for this content
    if (shouldUseTelegraph(text, keyInfo?.sessionKey)) {
      const pageUrl = await createTelegraphPage('Claude Response', text);

      if (pageUrl) {
        // Send Telegraph link with a brief summary
        const summary = text.substring(0, 200).replace(/[#*_`\[\]]/g, '') + '...';
        const message = `📄 *Full response available:*\n\n${escapeMarkdownV2(summary)}\n\n[Open in Instant View](${escapeMarkdownV2(pageUrl)})`;

        try {
          await ctx.reply(message, { parse_mode: 'MarkdownV2' });
          return;
        } catch (error) {
          console.error('[Telegraph] Failed to send link, falling back to chunks:', error);
        }
      }
    }

    // Default: MarkdownV2 with chunking
    const parts = processMessageForTelegram(text, config.MAX_MESSAGE_LENGTH);

    for (const part of parts) {
      try {
        await ctx.reply(part, { parse_mode: 'MarkdownV2' });
      } catch (error) {
        // MarkdownV2 failed — send as plain text chunks (raw text may exceed 4096 chars)
        console.error('MarkdownV2 send failed, falling back to plain text:', error);
        const plainChunks = splitMessage(text);
        for (const chunk of plainChunks) {
          await ctx.reply(chunk, { parse_mode: undefined });
        }
        // Already sent full text as plain — skip remaining MarkdownV2 parts
        return;
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
    const initialText = `${getSpinnerFrame(0)} ${TOOL_ICONS.thinking} Processing...`;
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
      todoMessageId: null,
      todoLastRendered: '',
    };

    // Periodic refresh so the elapsed timer and spinner update even during long tool runs
    if (terminalMode) {
      state.spinnerInterval = setInterval(() => {
        state.spinnerIndex += 1;
        if (ctx) {
          this.flushTerminalUpdate(ctx, state).catch(() => {});
        }
      }, MIN_EDIT_INTERVAL_MS);
    }

    this.streamStates.set(sessionKey, state);
    this.taskCompletionsPostedThisStream.set(sessionKey, 0);
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

    const detail = input ? extractToolDetail(toolName, input) : undefined;
    state.currentOperation = { name: toolName, detail };
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
    try {
      await ctx.reply(text, { parse_mode: 'MarkdownV2' });
    } catch (error) {
      console.error('[Task] Failed to post monitor armed:', error instanceof Error ? error.message : error);
      try {
        await ctx.reply(`📡 Monitor "${task.description}" armed`);
      } catch { /* ignore */ }
    }
  }

  private async postMonitorEvent(ctx: Context, task: TaskState, eventText: string): Promise<void> {
    if (task.skipTranscript) return;
    const truncated = eventText.length > 1000
      ? eventText.substring(0, 997) + '...'
      : eventText;
    const text = `📡 Monitor event: ${escapeMarkdownV2(truncated)}`;
    try {
      await ctx.reply(text, { parse_mode: 'MarkdownV2' });
    } catch (error) {
      console.error('[Task] Failed to post monitor event:', error instanceof Error ? error.message : error);
      try {
        await ctx.reply(`📡 Monitor event: ${eventText.substring(0, 1000)}`);
      } catch { /* ignore */ }
    }
  }

  /**
   * Post the model's text response from an SDK-driven sub-turn (monitor
   * event echoes, post-task_notification commentary) as its own Telegram
   * message. Sent as plain text (no MarkdownV2 parsing — log lines often
   * contain unescaped `_*[]`).
   */
  async postSubTurnResponse(ctx: Context, text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    const truncated = trimmed.length > 3500 ? trimmed.substring(0, 3497) + '...' : trimmed;
    try {
      await ctx.reply(truncated, { parse_mode: undefined });
    } catch (error) {
      console.error('[Task] Failed to post sub-turn response:', error instanceof Error ? error.message : error);
    }
  }

  private async postTaskCompletion(ctx: Context, task: TaskState): Promise<void> {
    // Skip ambient/housekeeping tasks and foreground subagents — only
    // backgrounded tasks deserve a separate notification message.
    if (task.skipTranscript) return;
    if (!task.isBackgrounded) return;

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

    let posted = false;
    try {
      await ctx.reply(lines.join('\n'), { parse_mode: 'MarkdownV2' });
      posted = true;
    } catch (error) {
      console.error('[Task] Failed to post completion message:', error instanceof Error ? error.message : error);
      try {
        const fallback = isMonitor
          ? `${statusIcon} Monitor "${task.description}" ${verb} after ${duration}`
          : `${statusIcon} Background task "${task.description}" ${verb} in ${duration}`;
        await ctx.reply(fallback);
        posted = true;
      } catch { /* ignore */ }
    }
    if (posted) {
      const sessionKey = getSessionKeyFromCtx(ctx)?.sessionKey;
      if (sessionKey) {
        const prev = this.taskCompletionsPostedThisStream.get(sessionKey) ?? 0;
        this.taskCompletionsPostedThisStream.set(sessionKey, prev + 1);
      }
    }
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

    // Add status line if there's a current operation
    if (state.currentOperation) {
      const icon = getToolIcon(state.currentOperation.name);
      const action = getToolAction(state.currentOperation.name);
      const detail = state.currentOperation.detail ? ` ${state.currentOperation.detail}` : '';
      const elapsedMs = now - state.operationStartTime;
      const pausedMs = state.lastRateLimitDurationMs > 0 ? state.lastRateLimitDurationMs : undefined;
      parts.push(renderStatusLine(state.spinnerIndex, icon, action, detail ? detail.trim() : undefined, elapsedMs, pausedMs));
    }

    // If nothing to show, show thinking indicator
    if (parts.length === 0) {
      parts.push(`${getSpinnerFrame(state.spinnerIndex)} ${TOOL_ICONS.thinking} Thinking...`);
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

  async finishStreaming(ctx: Context, finalContent: string): Promise<void> {
    const keyInfo = getSessionKeyFromCtx(ctx);
    if (!keyInfo) return;
    const { chatId, sessionKey } = keyInfo;

    const state = this.streamStates.get(sessionKey);

    if (state) {
      // Stop typing indicator and spinner
      this.stopTypingIndicator(state);
      this.stopSpinnerAnimation(state);
      state.currentOperation = null;

      if (state.messageId) {
        // Check if we should use Telegraph for final content
        if (shouldUseTelegraph(finalContent, sessionKey)) {
          const pageUrl = await createTelegraphPage('Claude Response', finalContent);

          if (pageUrl) {
            try {
              const summary = finalContent.substring(0, 200).replace(/[#*_`\[\]]/g, '') + '...';
              const message = `📄 *Response ready:*\n\n${escapeMarkdownV2(summary)}\n\n[Open in Instant View](${escapeMarkdownV2(pageUrl)})`;

              await ctx.api.editMessageText(
                chatId,
                state.messageId,
                message,
                { parse_mode: 'MarkdownV2' }
              );

              this.streamStates.delete(sessionKey);
              return;
            } catch (error) {
              console.error('[Telegraph] Failed, falling back to chunks:', error);
            }
          }
        }

        // Default: MarkdownV2 with chunking
        const parts = processMessageForTelegram(finalContent, config.MAX_MESSAGE_LENGTH);

        try {
          // Update the first message with first part (use MarkdownV2)
          const firstPart = parts[0] || 'Done\\.';

          try {
            await ctx.api.editMessageText(
              chatId,
              state.messageId,
              firstPart,
              { parse_mode: 'MarkdownV2' }
            );

            // Send additional messages for remaining parts
            for (let i = 1; i < parts.length; i++) {
              try {
                await ctx.reply(parts[i], { parse_mode: 'MarkdownV2' });
              } catch (partError) {
                console.error(`MarkdownV2 failed for part ${i + 1}:`, partError);
                await ctx.reply(parts[i], { parse_mode: undefined });
              }
              await new Promise(resolve => setTimeout(resolve, 100));
            }
          } catch (mdError) {
            // "message is not modified" means the content already matches — treat as success
            const errMsg = mdError instanceof Error ? mdError.message : '';
            if (errMsg.includes('message is not modified')) {
              console.debug('[Stream] Edit skipped — content unchanged');
            } else {
              // MarkdownV2 failed — delete streaming placeholder and
              // re-send via sendMessage which handles Telegraph + chunking
              console.error('MarkdownV2 edit failed, falling back to sendMessage:', mdError);
              try {
                await ctx.api.deleteMessage(chatId, state.messageId);
              } catch { /* ignore */ }

              this.streamStates.delete(sessionKey);
              await this.sendMessage(ctx, finalContent);
              return;
            }
          }
        } catch (error) {
          console.error('Error finishing stream:', error);
        }
      }
    }

    this.streamStates.delete(sessionKey);
  }

  async cancelStreaming(ctx: Context): Promise<void> {
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
            '⚠️ Request cancelled',
            { parse_mode: undefined }
          );
        } catch (error) {
          console.error('Error cancelling stream:', error);
        }
      }
    }

    this.streamStates.delete(sessionKey);
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

    const sessionKey = getSessionKeyFromCtx(ctx)?.sessionKey;
    if (sessionKey) {
      const taskCompletions = this.taskCompletionsPostedThisStream.get(sessionKey) ?? 0;
      if (taskCompletions > 0) return;
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
