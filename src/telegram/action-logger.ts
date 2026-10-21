/**
 * ActionLogger consolidates verbose mode action messages into a single editable
 * message instead of posting many separate messages. This provides a more
 * UI-like experience where actions are accumulated and displayed together.
 *
 * While its turn runs, the log also carries the turn's live status line at its
 * bottom, and under that the prompt the turn is running. The log is posted
 * below the prompt and the status bubble, and is usually tall enough to push
 * both off screen, so the bottom of the log is where the user is looking.
 */

import { GrammyError, type Api, type Context } from 'grammy';
import { escapeMarkdownV2 } from './markdown.js';
import { EntityText, type EntityMessage } from './entities.js';
import { promptLabel, cutLabel } from './prompt-label.js';
import { getToolIcon, extractToolDetail, elideToolOutput, stripAnsi } from './terminal-renderer.js';
import { createTelegraphPage, fitsTelegraphPage } from './telegraph.js';
import { isTelegraphEnabled } from './telegraph-settings.js';
import type { ToolResultEvent, EditDiffEvent } from '../providers/types.js';
import type { TaskState } from './task-tracker.js';
import { getSessionKeyFromCtx } from '../utils/session-key.js';

// Constants
const MIN_EDIT_INTERVAL_MS = 10000; // Minimum time between message edits (~5 edits/min safe zone)
// Telegram's cap on a message's text.
const MAX_MESSAGE_CHARS = 4096;
// The most actions the live log shows at once.
const LIVE_LOG_ENTRIES = 10;
// How much of an action's command and output the live log shows.
const LIVE_ENTRY_CHARS = 200;
// How much of the turn's prompt the live log shows: enough to recognise what
// the turn is for, about two and a half lines on a phone.
const LIVE_PROMPT_CHARS = 100;
// How long a log stays open once its turn has ended, so tool results still in
// flight land in it before it collapses.
const COLLAPSE_DELAY_MS = 5000;

// `mcp__claudegram-tools__claudegram_send_file` → `claudegram_send_file`
function stripMcpServerPrefix(toolName: string): string {
  if (!toolName.startsWith('mcp__')) return toolName;
  const lastSep = toolName.lastIndexOf('__');
  return lastSep > 0 ? toolName.slice(lastSep + 2) : toolName;
}

function cutForLiveLog(text: string): string {
  return text.length > LIVE_ENTRY_CHARS ? text.substring(0, LIVE_ENTRY_CHARS - 3) + '...' : text;
}

/**
 * The turn's prompt as the live log shows it. promptLabel leaves a slash
 * command out, not being a turn of the conversation, but here a skill like
 * /code-review is what the turn is running, so it shows as typed.
 */
function liveLogPrompt(prompt: string): string | undefined {
  const label = promptLabel(prompt) ?? prompt.replace(/\s+/g, ' ').trim();
  return label ? cutLabel(label, LIVE_PROMPT_CHARS) : undefined;
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

/**
 * The turn's live status line, rendered afresh each time the log is drawn.
 * Supplied by MessageSender, which tracks what the turn is doing.
 */
export type StatusSource = () => EntityMessage;

/** How the log is drawn: still running, and with which status line and prompt under it. */
interface LogView {
  live: boolean;
  status?: EntityMessage;
  prompt?: string;
}

interface ActionLogState {
  sessionKey: string;
  api: Api;
  chatId: number;
  threadId?: number;
  messageId: number | null;
  entries: ActionEntry[];
  lastUpdate: number;
  rateLimitedUntil: number;
  /** Drawn under the newest entry until the turn ends. Absent when the turn has no status line. */
  statusSource?: StatusSource;
  /** The prompt the turn is running, drawn at the very bottom until the turn ends. */
  prompt?: string;
  /** The turn is over: the log drops its live marker, status line and prompt. */
  ended: boolean;
  /** Once finalized, addX still records entries but skips message edits so the collapsed summary stays put. */
  finalized: boolean;
  /** Something has changed since the last draw that reached the chat. */
  dirty: boolean;
  /** A draw waiting out the edit throttle. */
  drawTimer: ReturnType<typeof setTimeout> | null;
  /** A send or edit is on its way to Telegram. */
  inFlight: boolean;
  /** What the message reads now, so a draw that changes nothing is skipped rather than refused as "not modified". */
  lastDrawn: string;
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
   * `statusSource` is the turn's live status line, drawn at the bottom of the log while the turn runs,
   * and `prompt` what the turn was sent, drawn under it.
   */
  async initialize(ctx: Context, sessionKey: string, statusSource?: StatusSource, prompt?: string): Promise<void> {
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
      sessionKey,
      api: ctx.api,
      chatId,
      threadId,
      messageId: null, // Will be created when first action is added
      entries: [],
      lastUpdate: Date.now(),
      rateLimitedUntil: 0,
      statusSource,
      prompt: prompt === undefined ? undefined : liveLogPrompt(prompt),
      ended: false,
      finalized: false,
      dirty: false,
      drawTimer: null,
      inFlight: false,
      lastDrawn: '',
    });
  }

  /**
   * Add a tool result to the action log
   */
  async addToolResult(
    sessionKey: string,
    event: ToolResultEvent,
    maxLines: number,
    maxChars: number
  ): Promise<void> {
    const state = this.logStates.get(sessionKey);
    if (!state) return;

    const cleaned = stripAnsi(event.content).replace(/\s+$/u, '');
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
    await this.requestDraw(state);
  }

  /**
   * Add an edit diff to the action log
   */
  async addEditDiff(
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
    await this.requestDraw(state);
  }

  /**
   * Add a monitor event to the action log
   */
  async addMonitorEvent(
    sessionKey: string,
    task: TaskState,
    eventText: string
  ): Promise<void> {
    const state = this.logStates.get(sessionKey);
    if (!state || task.skipTranscript) return;

    const cleaned = stripAnsi(eventText);
    const truncated = cleaned.length > 500
      ? cleaned.substring(0, 497) + '...'
      : cleaned;

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
    await this.requestDraw(state);
  }

  /**
   * Add a task completion to the action log
   */
  async addTaskCompletion(
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
    await this.requestDraw(state);
  }

  /**
   * Whether the turn's status line is showing at the bottom of the log: from
   * the log's first post until its turn ends. MessageSender stops updating the
   * status bubble meanwhile and points it at the log instead.
   */
  showsStatus(sessionKey: string): boolean {
    const state = this.logStates.get(sessionKey);
    return state !== undefined && this.isShowingStatus(state);
  }

  /**
   * Redraw the log for a new status line. Waits behind the edit throttle like
   * any other change, unless `immediate` — a question waiting on the user
   * shouldn't go unannounced until the next slot.
   */
  async refreshStatus(sessionKey: string, immediate = false): Promise<void> {
    const state = this.logStates.get(sessionKey);
    if (!state || !this.isShowingStatus(state)) return;
    await this.requestDraw(state, immediate);
  }

  private isShowingStatus(state: ActionLogState): boolean {
    return state.statusSource !== undefined && state.messageId !== null && !state.ended;
  }

  /**
   * Draw the log now if the edit throttle allows, or as soon as it does.
   *
   * The first draw posts the message straight away; the edits after it are at
   * least MIN_EDIT_INTERVAL_MS apart, and `immediate` skips that wait. A change
   * that comes too soon waits for its slot instead of being dropped. Dropped,
   * the newest actions stayed off the log until another one came in, which
   * during a long build after a burst of quick reads was minutes.
   */
  private async requestDraw(state: ActionLogState, immediate = false): Promise<void> {
    if (state.finalized) return;
    state.dirty = true;
    // The draw in flight goes again when it lands, and picks this change up.
    if (state.inFlight) return;

    const now = Date.now();
    const due = Math.max(
      state.messageId === null || immediate ? now : state.lastUpdate + MIN_EDIT_INTERVAL_MS,
      // Respect Telegram's retry_after backoff on 429
      state.rateLimitedUntil,
    );
    if (due <= now) {
      this.cancelDraw(state);
      await this.draw(state);
    } else if (!state.drawTimer) {
      state.drawTimer = setTimeout(() => {
        state.drawTimer = null;
        void this.requestDraw(state);
      }, due - now);
      // Never hold the process open for a cosmetic edit.
      state.drawTimer.unref?.();
    }
  }

  private cancelDraw(state: ActionLogState): void {
    if (state.drawTimer) {
      clearTimeout(state.drawTimer);
      state.drawTimer = null;
    }
  }

  private async draw(state: ActionLogState): Promise<void> {
    if (state.finalized || state.inFlight || !state.dirty || state.entries.length === 0) return;
    state.inFlight = true;
    state.dirty = false;

    let drawn = '';
    try {
      const { text, entities } = this.renderLive(state);
      drawn = JSON.stringify({ text, entities });
      if (state.messageId === null) {
        const sendOpts = state.threadId !== undefined ? { message_thread_id: state.threadId } : {};
        const message = await state.api.sendMessage(state.chatId, text, { entities, ...sendOpts });
        state.messageId = message.message_id;
      } else if (drawn !== state.lastDrawn) {
        await state.api.editMessageText(state.chatId, state.messageId, text, { entities });
      } else {
        return;
      }
      state.lastUpdate = Date.now();
      state.lastDrawn = drawn;
    } catch (error: unknown) {
      this.handleDrawError(state, error, drawn);
    } finally {
      state.inFlight = false;
      if (state.dirty) void this.requestDraw(state);
    }
  }

  private handleDrawError(state: ActionLogState, error: unknown, drawn: string): void {
    if (error instanceof GrammyError) {
      if (error.error_code === 429) {
        const retryAfter = error.parameters.retry_after ?? 60;
        state.rateLimitedUntil = Date.now() + retryAfter * 1000;
        // Draw it again once the backoff is over.
        state.dirty = true;
        console.warn(`[ActionLogger] Rate limited, backing off for ${retryAfter}s`);
        return;
      }

      const msg = error.message.toLowerCase();
      if (msg.includes('message is not modified')) {
        state.lastDrawn = drawn;
        return;
      }
      if (msg.includes('message_id_invalid') || msg.includes('message to edit not found')) {
        // Message was deleted: let the log go, so the next action opens a new one.
        state.finalized = true;
        this.cancelDraw(state);
        if (this.logStates.get(state.sessionKey) === state) this.logStates.delete(state.sessionKey);
        return;
      }
    }

    console.error('[ActionLogger] Failed to draw the log:', error);
  }

  /** The log as it reads now: the newest entries that fit, under them the status line and prompt while the turn runs. */
  private renderLive(state: ActionLogState): EntityMessage {
    const view: LogView = {
      live: !state.ended,
      // Rendered once per draw. The thinking verb in it is picked at random,
      // so a second call could come out longer than the fit was measured on.
      status: state.ended ? undefined : state.statusSource?.(),
      prompt: state.ended ? undefined : state.prompt,
    };
    return this.renderActionLog(state.entries, this.entriesThatFit(state.entries, view), view);
  }

  /**
   * How many of the newest entries the live log can show: ten, or fewer when
   * ten would overflow a message.
   *
   * Ten entries with a command and a couple of hundred characters of output
   * each come to more than a Telegram message holds. An edit that long fails
   * with MESSAGE_TOO_LONG — so a busy turn's live log froze partway through.
   * Measured on the text as sent: the formatting goes out as entities rather
   * than markup, so its length is what Telegram counts.
   */
  private entriesThatFit(entries: ActionEntry[], view: LogView): number {
    let shown = Math.min(entries.length, LIVE_LOG_ENTRIES);
    while (shown > 1 && this.renderActionLog(entries, shown, view).text.length > MAX_MESSAGE_CHARS) shown--;
    return shown;
  }

  /**
   * Render the newest `shown` action log entries.
   *
   * Entities rather than MarkdownV2: commands and their output are the model's
   * and the shell's own text, so they go out verbatim with nothing to escape.
   *
   * The header starts with ⏳ while the turn runs. The chat list previews a
   * chat by the start of its newest message, which mid-turn is usually this
   * one — so that's where the list shows the agent is still at it.
   *
   * The prompt goes last, under the status line, so what the turn is for sits
   * where the user is looking: by the time the log is this long, the message
   * that started the turn is far above it.
   */
  private renderActionLog(entries: ActionEntry[], shown: number, view: LogView): EntityMessage {
    const b = new EntityText();
    b.add(view.live ? '⏳ ' : '📋 ').bold('Action Log');

    if (entries.length > shown) {
      b.newline(2).italic(`Showing last ${shown} of ${entries.length} actions`);
    }

    for (const entry of entries.slice(-shown)) {
      const statusEmoji = entry.status === 'completed' ? '✅' :
                         entry.status === 'error' ? '❌' : '⏳';

      const time = new Date(entry.timestamp).toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit'
      });

      b.newline(2).add(`${entry.icon} ${statusEmoji} [${time}] ${entry.title}`);
      if (entry.subtitle) b.newline().code(cutForLiveLog(entry.subtitle));
      if (entry.content) b.newline().pre(cutForLiveLog(entry.content));
    }

    if (view.status) b.newline(2).append(view.status);
    if (view.prompt) b.newline(2).italic(`▸ ${view.prompt}`);

    return b.build();
  }

  /**
   * Collapse the session's log once its turn is over, then let it go.
   *
   * Holds on to this turn's log rather than looking the session up again when
   * the delay runs out. A message queued behind the turn starts the next one
   * straight away, and that turn's initialize() replaces the session's log
   * well inside the delay — looked up by key, the timer collapsed the new
   * turn's log mid-turn, or threw it away while it was still empty, and never
   * collapsed this one.
   *
   * The live marker and status line go at once, so a draw in the meantime —
   * for a result still landing — doesn't show the finished turn as running.
   */
  endTurn(sessionKey: string): void {
    const state = this.logStates.get(sessionKey);
    if (!state) return;
    state.ended = true;
    setTimeout(async () => {
      try {
        await this.finalize(state);
      } finally {
        // Unless a newer turn's log has taken the session over since.
        if (this.logStates.get(sessionKey) === state) this.logStates.delete(sessionKey);
      }
    }, COLLAPSE_DELAY_MS);
  }

  /**
   * Collapse the in-chat action log into a Telegraph link at the end of a turn.
   * Renders all entries (no 10-entry cap) onto a Telegraph page, then edits
   * the existing action-log message into a brief "📋 N actions · view full
   * log" summary. If Telegraph is disabled or fails, the log is drawn one last
   * time as it stands, without the live marker and status line.
   */
  private async finalize(state: ActionLogState): Promise<void> {
    if (state.finalized) return;
    // No more live draws: whatever is drawn from here on is final.
    state.finalized = true;
    this.cancelDraw(state);
    if (!state.messageId || state.entries.length === 0) return;

    // Telegraph creation can fail (rate limit, network); the full log then
    // stays in the chat instead.
    const pageUrl = isTelegraphEnabled(state.sessionKey)
      ? await createTelegraphPage('Action log', this.renderTelegraphPage(state.entries))
      : null;

    try {
      if (pageUrl) {
        const summary = this.renderCollapsedSummary(state.entries, pageUrl);
        await state.api.editMessageText(state.chatId, state.messageId, summary, {
          parse_mode: 'MarkdownV2',
          link_preview_options: { is_disabled: true },
        });
        return;
      }

      const view: LogView = { live: false };
      const { text, entities } = this.renderActionLog(state.entries, this.entriesThatFit(state.entries, view), view);
      if (JSON.stringify({ text, entities }) === state.lastDrawn) return;
      await state.api.editMessageText(state.chatId, state.messageId, text, { entities });
    } catch (error) {
      if (error instanceof GrammyError) {
        const msg = error.message.toLowerCase();
        if (msg.includes('message is not modified')) return;
      }
      console.error('[ActionLogger] Failed to collapse message:', error);
    }
  }

  /**
   * The full action log as markdown for a Telegraph page, cut down until it
   * fits on one.
   *
   * Telegraph refuses a page over 64 KB, and a long turn's log passes that
   * easily — 40 results at the verbose tier's 2,000 characters is 80 KB — which
   * left the live log standing uncollapsed. Output goes first: each pass
   * halves how much of an entry's input and output the page keeps, so every
   * action stays listed. Only once the title lines alone are too much do the
   * oldest actions drop off.
   */
  private renderTelegraphPage(entries: ActionEntry[]): string {
    const longest = entries.reduce(
      (max, e) => Math.max(max, e.subtitle?.length ?? 0, e.content?.length ?? 0),
      0,
    );
    for (let cap = longest; cap > 0; cap = Math.floor(cap / 2)) {
      const markdown = this.renderTelegraphMarkdown(entries, cap);
      if (fitsTelegraphPage(markdown)) return markdown;
    }

    let keep = entries.length;
    let markdown = this.renderTelegraphMarkdown(entries, 0);
    while (keep > 1 && !fitsTelegraphPage(markdown)) {
      keep = Math.ceil(keep / 2);
      markdown = this.renderTelegraphMarkdown(entries, 0, entries.length - keep);
    }
    return markdown;
  }

  /**
   * Render the action log as markdown for a Telegraph page, from the entries
   * as captured — no attempt to recover untruncated content. Each entry's
   * input and output are cut to `bodyCap` characters, and left off at 0; the
   * first `skip` entries are left off entirely.
   */
  private renderTelegraphMarkdown(entries: ActionEntry[], bodyCap: number, skip = 0): string {
    const sections: string[] = [];
    if (skip > 0) {
      sections.push(`_${skip} earlier action${skip === 1 ? '' : 's'} left off to fit the page._`);
    }
    entries.slice(skip).forEach((entry, index) => {
      const statusEmoji = entry.status === 'completed' ? '✅' :
                         entry.status === 'error' ? '❌' : '⏳';
      const time = new Date(entry.timestamp).toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      const cut = (text: string | undefined) => text && bodyCap > 0
        ? elideToolOutput(text, Infinity, bodyCap, { isError: entry.status === 'error' })
        : undefined;
      const subtitle = cut(entry.subtitle);
      const content = cut(entry.content);

      const headerLines: string[] = [];
      headerLines.push(`## ${skip + index + 1}. ${entry.icon} ${statusEmoji} ${entry.title}`);
      headerLines.push(`_${time}_`);
      if (subtitle) {
        headerLines.push('');
        headerLines.push('```');
        headerLines.push(subtitle);
        headerLines.push('```');
      }
      if (content) {
        headerLines.push('');
        headerLines.push('```');
        headerLines.push(content);
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
}

// Export singleton instance
export const actionLogger = new ActionLogger();
