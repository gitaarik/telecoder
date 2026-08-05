/**
 * ActionLogger consolidates verbose mode action messages into a single editable
 * message instead of posting many separate messages. This provides a more
 * UI-like experience where actions are accumulated and displayed together.
 */

import { Context, GrammyError } from 'grammy';
import { escapeMarkdownV2 } from './markdown.js';
import { getToolIcon, extractToolDetail, elideToolOutput } from './terminal-renderer.js';
import { createTelegraphPage } from './telegraph.js';
import { isTelegraphEnabled } from './telegraph-settings.js';
import type { ToolResultEvent, EditDiffEvent } from '../providers/types.js';
import type { TaskState } from './task-tracker.js';
import { getSessionKeyFromCtx } from '../utils/session-key.js';

// Constants
const MIN_EDIT_INTERVAL_MS = 10000; // Minimum time between message edits (~5 edits/min safe zone)

// `mcp__claudegram-tools__claudegram_send_file` → `claudegram_send_file`
function stripMcpServerPrefix(toolName: string): string {
  if (!toolName.startsWith('mcp__')) return toolName;
  const lastSep = toolName.lastIndexOf('__');
  return lastSep > 0 ? toolName.slice(lastSep + 2) : toolName;
}

export interface ActionEntry {
  id: string;
  timestamp: number;
  type: 'tool_result' | 'edit_diff' | 'monitor_event' | 'task_completion';
  icon: string;
  title: string;
  /** Optional subtitle line rendered between title and content (e.g. `$ ls -la`). Not truncated by the per-entry content cap. */
  subtitle?: string;
  content?: string;
  status: 'running' | 'completed' | 'error';
}

interface ActionLogState {
  chatId: number;
  threadId?: number;
  messageId: number | null;
  entries: ActionEntry[];
  lastUpdate: number;
  rateLimitedUntil: number;
  /** Once finalized, addX still records entries but skips message edits so the collapsed summary stays put. */
  finalized: boolean;
}

/**
 * Manages consolidated action logging for verbose mode. Instead of sending
 * multiple separate messages for tool results, diffs, etc., maintains a single
 * message that gets edited with accumulated actions.
 */
export class ActionLogger {
  private logStates: Map<string, ActionLogState> = new Map();

  /**
   * Initialize action logging for a session. Creates the state but doesn't send a message yet.
   */
  async initialize(ctx: Context, sessionKey: string): Promise<void> {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;

    // Resolve the thread the same way the streaming bubble does. A turn can
    // start from a callback query (a tapped suggestion button), where
    // `ctx.message` is undefined and the originating message hangs off
    // `ctx.callbackQuery` instead — reading `ctx.message` directly threw and
    // took the whole turn down with it.
    const threadId = getSessionKeyFromCtx(ctx)?.threadId;

    // Just create the state, don't send a message yet
    this.logStates.set(sessionKey, {
      chatId,
      threadId,
      messageId: null, // Will be created when first action is added
      entries: [],
      lastUpdate: Date.now(),
      rateLimitedUntil: 0,
      finalized: false,
    });
  }

  /**
   * Add a tool result to the action log
   */
  async addToolResult(
    ctx: Context,
    sessionKey: string,
    event: ToolResultEvent,
    maxLines: number,
    maxChars: number
  ): Promise<void> {
    const state = this.logStates.get(sessionKey);
    if (!state) return;

    const cleaned = event.content.replace(/\s+$/u, '');
    if (!cleaned && !event.isError) return;

    const icon = event.toolName ? getToolIcon(event.toolName) : '🔹';
    const label = event.toolName ? stripMcpServerPrefix(event.toolName) : 'tool';
    const status = event.isError ? 'error' : 'completed';

    // Tail-biased for errors (failures land at the end), head-biased for
    // success — middle elided either way (see elideToolOutput).
    const content = elideToolOutput(cleaned || '(no output)', maxLines, maxChars, { isError: event.isError });

    const detail = event.toolName && event.input
      ? extractToolDetail(event.toolName, event.input, true)
      : undefined;
    const subtitle = detail
      ? `${event.toolName === 'Bash' ? '$ ' : ''}${detail}`
      : undefined;

    const entry: ActionEntry = {
      id: `tool-${Date.now()}-${Math.random()}`,
      timestamp: Date.now(),
      type: 'tool_result',
      icon,
      title: `${label} ${event.isError ? 'error' : 'result'}`,
      subtitle,
      content,
      status
    };

    state.entries.push(entry);
    await this.updateLogMessage(ctx, state);
  }

  /**
   * Add an edit diff to the action log
   */
  async addEditDiff(
    ctx: Context,
    sessionKey: string,
    event: EditDiffEvent,
    maxLines: number
  ): Promise<void> {
    const state = this.logStates.get(sessionKey);
    if (!state) return;

    const fileLabel = this.stripWorkingDir(event.filePath);
    const headerIcon = event.toolName === 'Write' ? '✏️' : '🔧';

    const lines: string[] = [];

    // Add old content (if any)
    if (typeof event.oldString === 'string' && event.oldString.length > 0) {
      const oldLines = event.oldString.split('\n');
      const oldShown = oldLines.slice(0, maxLines).map((l) => `- ${l}`);
      if (oldLines.length > maxLines) {
        oldShown.push(`- [+${oldLines.length - maxLines} more lines]`);
      }
      lines.push(...oldShown);
    }

    // Add new content
    const newLines = event.newString.split('\n');
    const newShown = newLines.slice(0, maxLines).map((l) => `+ ${l}`);
    if (newLines.length > maxLines) {
      newShown.push(`+ [+${newLines.length - maxLines} more lines]`);
    }
    lines.push(...newShown);

    const entry: ActionEntry = {
      id: `edit-${Date.now()}-${Math.random()}`,
      timestamp: Date.now(),
      type: 'edit_diff',
      icon: headerIcon,
      title: `${event.toolName} ${fileLabel}`,
      content: lines.join('\n'),
      status: 'completed'
    };

    state.entries.push(entry);
    await this.updateLogMessage(ctx, state);
  }

  /**
   * Add a monitor event to the action log
   */
  async addMonitorEvent(
    ctx: Context,
    sessionKey: string,
    task: TaskState,
    eventText: string
  ): Promise<void> {
    const state = this.logStates.get(sessionKey);
    if (!state || task.skipTranscript) return;

    const truncated = eventText.length > 500
      ? eventText.substring(0, 497) + '...'
      : eventText;

    const entry: ActionEntry = {
      id: `monitor-${Date.now()}-${Math.random()}`,
      timestamp: Date.now(),
      type: 'monitor_event',
      icon: '📡',
      title: 'Monitor event',
      content: truncated,
      status: 'completed'
    };

    state.entries.push(entry);
    await this.updateLogMessage(ctx, state);
  }

  /**
   * Add a task completion to the action log
   */
  async addTaskCompletion(
    ctx: Context,
    sessionKey: string,
    task: TaskState
  ): Promise<void> {
    const state = this.logStates.get(sessionKey);
    if (!state || task.skipTranscript || !task.isBackgrounded) return;

    const isMonitor = task.taskType === 'monitor_mcp';
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

    const title = isMonitor
      ? `Monitor "${description}" ${verb} after ${duration}`
      : `Background task "${description}" ${verb} in ${duration}`;

    const entry: ActionEntry = {
      id: `task-${Date.now()}-${Math.random()}`,
      timestamp: Date.now(),
      type: 'task_completion',
      icon: statusIcon,
      title,
      content: task.error,
      status: task.status === 'completed' ? 'completed' : 'error'
    };

    state.entries.push(entry);
    await this.updateLogMessage(ctx, state);
  }

  /**
   * Update the action log message with current entries
   */
  private async updateLogMessage(ctx: Context, state: ActionLogState): Promise<void> {
    // Once the turn has been collapsed into a Telegraph summary, leave the
    // message alone. Stragglers (background-task completions arriving in the
    // post-turn drain window) are still recorded in state.entries but they
    // shouldn't blow away the user-visible summary.
    if (state.finalized) return;

    // If no message exists yet, create it now that we have content
    if (!state.messageId) {
      const sendOpts = state.threadId !== undefined ? { message_thread_id: state.threadId } : {};

      try {
        const content = this.renderActionLog(state.entries);
        const message = await ctx.api.sendMessage(state.chatId, content, {
          parse_mode: 'MarkdownV2',
          ...sendOpts
        });

        state.messageId = message.message_id;
        state.lastUpdate = Date.now();
        return;
      } catch (error) {
        console.error('[ActionLogger] Failed to create initial message:', error);
        // Try plain text fallback
        try {
          const plainContent = this.renderActionLogPlain(state.entries);
          const message = await ctx.api.sendMessage(state.chatId, plainContent, {
            parse_mode: undefined,
            ...sendOpts
          });
          state.messageId = message.message_id;
          state.lastUpdate = Date.now();
          return;
        } catch (plainError) {
          console.error('[ActionLogger] Plain text fallback also failed:', plainError);
          return;
        }
      }
    }

    // Respect Telegram's retry_after backoff on 429
    const now = Date.now();
    if (now < state.rateLimitedUntil) return;

    // Throttle edits to avoid rate limits
    const timeSinceLastUpdate = now - state.lastUpdate;
    if (timeSinceLastUpdate < MIN_EDIT_INTERVAL_MS) return;

    const content = this.renderActionLog(state.entries);

    try {
      await ctx.api.editMessageText(
        state.chatId,
        state.messageId,
        content,
        { parse_mode: 'MarkdownV2' }
      );
      state.lastUpdate = Date.now();
    } catch (error: unknown) {
      if (error instanceof GrammyError) {
        if (error.error_code === 429) {
          const retryAfter = error.parameters.retry_after ?? 60;
          state.rateLimitedUntil = Date.now() + retryAfter * 1000;
          console.warn(`[ActionLogger] Rate limited, backing off for ${retryAfter}s`);
          return;
        }

        const msg = error.message.toLowerCase();
        if (msg.includes('message is not modified')) {
          return; // Content unchanged, ignore
        }
        if (msg.includes('message_id_invalid')) {
          // Message was deleted, cleanup state
          this.logStates.delete(this.getSessionKeyFromState(state));
          return;
        }
      }

      console.error('[ActionLogger] Failed to update message:', error);

      // Fallback to plain text if MarkdownV2 parsing fails
      try {
        const plainContent = this.renderActionLogPlain(state.entries);
        await ctx.api.editMessageText(
          state.chatId,
          state.messageId,
          plainContent,
          { parse_mode: undefined }
        );
        state.lastUpdate = Date.now();
      } catch (plainError) {
        console.error('[ActionLogger] Plain text fallback failed:', plainError);
      }
    }
  }

  /**
   * Render action log entries as MarkdownV2
   */
  private renderActionLog(entries: ActionEntry[]): string {
    if (entries.length === 0) {
      return '📋 **Action Log**\n\n_No actions yet\\.\\.\\._';
    }

    const lines = ['📋 **Action Log**', ''];

    // Show only last 10 entries to keep message reasonable
    const recentEntries = entries.slice(-10);

    recentEntries.forEach((entry, index) => {
      const statusEmoji = entry.status === 'completed' ? '✅' :
                         entry.status === 'error' ? '❌' : '⏳';

      const time = new Date(entry.timestamp).toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit'
      });

      lines.push(`${entry.icon} ${statusEmoji} \\[${escapeMarkdownV2(time)}\\] ${escapeMarkdownV2(entry.title)}`);

      if (entry.subtitle) {
        const trimmedSubtitle = entry.subtitle.length > 200
          ? entry.subtitle.substring(0, 197) + '...'
          : entry.subtitle;
        lines.push(`\`${escapeMarkdownV2(trimmedSubtitle)}\``);
      }

      if (entry.content) {
        const truncatedContent = entry.content.length > 200
          ? entry.content.substring(0, 197) + '...'
          : entry.content;

        lines.push(`\`\`\`\n${escapeMarkdownV2(truncatedContent)}\n\`\`\``);
      }

      if (index < recentEntries.length - 1) {
        lines.push('');
      }
    });

    if (entries.length > 10) {
      lines.unshift(`_Showing last 10 of ${entries.length} actions_`, '');
    }

    return lines.join('\n');
  }

  /**
   * Render action log entries as plain text (fallback)
   */
  private renderActionLogPlain(entries: ActionEntry[]): string {
    if (entries.length === 0) {
      return '📋 Action Log\n\nNo actions yet...';
    }

    const lines = ['📋 Action Log', ''];

    const recentEntries = entries.slice(-10);

    recentEntries.forEach((entry, index) => {
      const statusEmoji = entry.status === 'completed' ? '✅' :
                         entry.status === 'error' ? '❌' : '⏳';

      const time = new Date(entry.timestamp).toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit'
      });

      lines.push(`${entry.icon} ${statusEmoji} [${time}] ${entry.title}`);

      if (entry.subtitle) {
        const trimmedSubtitle = entry.subtitle.length > 200
          ? entry.subtitle.substring(0, 197) + '...'
          : entry.subtitle;
        lines.push(`  ${trimmedSubtitle}`);
      }

      if (entry.content) {
        const truncatedContent = entry.content.length > 200
          ? entry.content.substring(0, 197) + '...'
          : entry.content;

        lines.push(`  ${truncatedContent}`);
      }

      if (index < recentEntries.length - 1) {
        lines.push('');
      }
    });

    if (entries.length > 10) {
      lines.unshift(`Showing last 10 of ${entries.length} actions`, '');
    }

    return lines.join('\n');
  }

  /**
   * Collapse the in-chat action log into a Telegraph link at the end of a turn.
   * Renders all entries (no 10-entry cap) onto a Telegraph page, then edits
   * the existing action-log message into a brief "📋 N actions · view full
   * log" summary. If Telegraph is disabled or fails, the message is left as-is
   * (callers still get the live-streamed view).
   */
  async finalize(ctx: Context, sessionKey: string): Promise<void> {
    const state = this.logStates.get(sessionKey);
    if (!state || state.finalized) return;
    if (!state.messageId || state.entries.length === 0) return;
    if (!isTelegraphEnabled(sessionKey)) return;

    state.finalized = true;

    const markdown = this.renderTelegraphMarkdown(state.entries);
    const pageUrl = await createTelegraphPage('Action log', markdown);
    if (!pageUrl) {
      // Telegraph creation failed (rate limit, network); leave the live log
      // visible so the user still has something to inspect.
      state.finalized = false;
      return;
    }

    const summary = this.renderCollapsedSummary(state.entries, pageUrl);
    try {
      await ctx.api.editMessageText(state.chatId, state.messageId, summary, {
        parse_mode: 'MarkdownV2',
        link_preview_options: { is_disabled: true },
      });
    } catch (error) {
      if (error instanceof GrammyError) {
        const msg = error.message.toLowerCase();
        if (msg.includes('message is not modified')) return;
      }
      console.error('[ActionLogger] Failed to collapse message:', error);
    }
  }

  /**
   * Render the full action log as markdown for a Telegraph page. Uses the
   * same truncation that was applied when entries were captured — no attempt
   * to recover untruncated content.
   */
  private renderTelegraphMarkdown(entries: ActionEntry[]): string {
    const sections: string[] = [];
    entries.forEach((entry, index) => {
      const statusEmoji = entry.status === 'completed' ? '✅' :
                         entry.status === 'error' ? '❌' : '⏳';
      const time = new Date(entry.timestamp).toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });

      const headerLines: string[] = [];
      headerLines.push(`## ${index + 1}. ${entry.icon} ${statusEmoji} ${entry.title}`);
      headerLines.push(`_${time}_`);
      if (entry.subtitle) {
        headerLines.push('');
        headerLines.push('```');
        headerLines.push(entry.subtitle);
        headerLines.push('```');
      }
      if (entry.content) {
        headerLines.push('');
        headerLines.push('```');
        headerLines.push(entry.content);
        headerLines.push('```');
      }
      sections.push(headerLines.join('\n'));
    });
    return sections.join('\n\n---\n\n');
  }

  /**
   * Render the collapsed in-chat summary line that replaces the live log.
   */
  private renderCollapsedSummary(entries: ActionEntry[], pageUrl: string): string {
    const completed = entries.filter(e => e.status === 'completed').length;
    const errors = entries.filter(e => e.status === 'error').length;
    const counts = [`${entries.length} action${entries.length === 1 ? '' : 's'}`];
    if (errors > 0) counts.push(`${errors} error${errors === 1 ? '' : 's'}`);
    else if (completed < entries.length) counts.push(`${completed} completed`);
    const summary = counts.join(' · ');
    return `📋 _${escapeMarkdownV2(summary)}_ · [view full log](${escapeMarkdownV2(pageUrl)})`;
  }

  /**
   * Clean up action log for a session
   */
  cleanup(sessionKey: string): void {
    this.logStates.delete(sessionKey);
  }

  /**
   * Check if action logging is active for a session
   */
  isActive(sessionKey: string): boolean {
    return this.logStates.has(sessionKey);
  }

  /**
   * Trim long absolute paths for display
   */
  private stripWorkingDir(filePath: string): string {
    const cwd = process.cwd();
    if (filePath.startsWith(cwd + '/')) return filePath.slice(cwd.length + 1);
    const home = process.env.HOME;
    if (home && filePath.startsWith(home + '/')) return '~/' + filePath.slice(home.length + 1);
    return filePath;
  }

  /**
   * Helper to extract session key from state (for cleanup)
   */
  private getSessionKeyFromState(state: ActionLogState): string {
    // This is a hack since we don't store sessionKey in state
    // In real usage, caller handles cleanup by sessionKey
    for (const [key, value] of this.logStates) {
      if (value === state) return key;
    }
    return '';
  }
}

// Export singleton instance
export const actionLogger = new ActionLogger();