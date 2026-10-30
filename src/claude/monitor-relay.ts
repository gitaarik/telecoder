import * as fs from 'fs';
import type { Bot } from 'grammy';
import { sessionJsonlPath } from './session-jsonl.js';
import { isSubagentTool } from './subagent-tools.js';
import { buildSyntheticCtx } from './synthetic-ctx.js';
import { parseSessionKey } from '../utils/session-key.js';
import { convertToTelegramMarkdown } from '../telegram/markdown.js';
import { taskTracker } from '../telegram/task-tracker.js';
import {
  setBackgroundCardBot,
  noteTaskArmed,
  noteTaskFinished,
  noteMonitorEvent,
  sealCard,
  clearCard,
} from '../telegram/background-activity-card.js';
import { config } from '../config.js';

/**
 * PTY-mode Monitor relay. When claude calls its built-in Monitor tool, events
 * that fire later (after our user-turn has ended) show up as new assistant
 * records appended to the session JSONL. Without this module those records
 * would never reach Telegram — the turn pipeline only forwards content
 * while a turn is active.
 *
 * Mechanism: per-session JSONL watcher armed on the first Monitor PreToolUse.
 * Tracks byte position; on file change, reads new bytes and parses them.
 * Suppresses relay while a user turn is active so the turn's own response
 * doesn't double-post — the turn pipeline delivers that directly.
 *
 * Between those turns, claude answers a task that reports back by starting a
 * turn of its own. Nothing streams that turn, so the relay collects its prose
 * and, when claude closes the turn, sends it as the turn pipeline sends a
 * reply: whole, in one go. That is usually the answer the background work was
 * for, and often longer than a card can hold.
 *
 * State is per-sessionKey and torn down with the session. No persistence:
 * if the bot restarts, the user has to re-arm any monitors they want.
 *
 * This module is also the PTY-mode feed for `taskTracker`. The SDK path gets
 * task lifecycle from `onTaskEvent` (src/claude/agent.ts), which the PTY
 * provider never emits — so without this, /tasks and the streaming footer's
 * 🔄/📡 counters would read "nothing running" while monitors and subagents
 * were live. The arm/terminal-notification pair already tracked here for
 * message editing is exactly that lifecycle, so it drives both.
 *
 * Chat output is not one message per event. Arms, monitor firings and
 * completions are all folded into a single re-anchoring card per session
 * (src/telegram/background-activity-card.ts); this module supplies the
 * entries, and the turn boundaries that tell the card when to re-post.
 */

interface MonitorState {
  sessionKey: string;
  cwd: string;
  claudeSessionId: string;
  jsonlPosition: number;
  watcher: fs.FSWatcher | null;
  inTurn: boolean;
  /**
   * A turn claude started itself is underway: something arrived between our
   * turns and claude hasn't closed the turn it started on it yet.
   */
  selfTurnOpen: boolean;
  /** Coalesce rapid-fire change events into one read. */
  pendingRead: NodeJS.Timeout | null;
  /**
   * The prose of a turn claude started itself, one entry per assistant text
   * record, held until the turn closes. Lives across handleChange calls
   * because a turn that runs tools spans many of them.
   */
  reply: string[];
  /**
   * The replies on their way to the chat, chained so one with a Telegraph
   * page to publish first can't be overtaken by the next.
   */
  replySent: Promise<void>;
  /**
   * Armed-task bookkeeping keyed by tool_use_id. Populated by
   * onAsyncToolArmed when an async tool fires; consumed by handleChange
   * when the matching terminal task-notification arrives — the only place
   * the task's kind, description and start time are still available to
   * render its completion.
   */
  armedTasks: Map<string, ArmedTask>;
}

interface ArmedTask {
  kind: AsyncToolKind;
  description: string;
  startedAt: number;
}

interface TaskNotification {
  taskId: string;
  toolUseId: string;
  status: string;
  summary: string;
  event: string;
}

function parseTaskNotification(rec: { origin?: { kind?: string }; message?: { content?: unknown } }): TaskNotification | null {
  // origin.kind is the cleanest discriminator when the field is present;
  // fall back to scanning for the wrapper tag in older records that don't
  // carry it.
  const isNotif = rec.origin?.kind === 'task-notification';
  const content = rec.message?.content;
  let text: string;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    const textBlock = content.find((b: unknown) =>
      !!b && typeof b === 'object'
      && (b as { type?: string }).type === 'text'
      && typeof (b as { text?: unknown }).text === 'string',
    ) as { text: string } | undefined;
    if (!textBlock) return null;
    text = textBlock.text;
  } else {
    return null;
  }

  if (!isNotif && !text.includes('<task-notification>')) return null;

  const taskIdMatch = text.match(/<task-id>([^<]*)<\/task-id>/);
  const toolUseIdMatch = text.match(/<tool-use-id>([^<]*)<\/tool-use-id>/);
  const statusMatch = text.match(/<status>([^<]*)<\/status>/);
  const summaryMatch = text.match(/<summary>([\s\S]*?)<\/summary>/);
  const eventMatch = text.match(/<event>([\s\S]*?)<\/event>/);

  return {
    taskId: taskIdMatch?.[1].trim() ?? '',
    toolUseId: toolUseIdMatch?.[1].trim() ?? '',
    status: statusMatch?.[1].trim() ?? '',
    summary: summaryMatch?.[1].trim() ?? '',
    event: eventMatch?.[1].trim() ?? '',
  };
}

interface QueuedCommandAttachment {
  type?: string;
  prompt?: unknown;
  origin?: { kind?: string };
}

/**
 * A task-notification claude delivered into a turn that was already running.
 * It gets no user record of its own: the queue logs it as removed with reason
 * `absorbed_mid_turn`, and the turn carries it as a `queued_command`
 * attachment.
 */
function parseAbsorbedNotification(attachment: QueuedCommandAttachment | undefined): TaskNotification | null {
  if (attachment?.type !== 'queued_command') return null;
  return parseTaskNotification({ origin: attachment.origin, message: { content: attachment.prompt } });
}

const states = new Map<string, MonitorState>();
let botRef: Bot | null = null;

/**
 * Send a relay message with MarkdownV2 formatting, falling back to plain text
 * if the converted output is rejected by Telegram. Mirrors the turn pipeline
 * in messageSender.sendMessage so monitor/push messages render bold, code,
 * links, etc. instead of arriving as a wall of escaped text.
 */
async function sendFormatted(
  chatId: number,
  threadOpts: { message_thread_id?: number },
  text: string,
  context: string,
): Promise<void> {
  if (!botRef) return;
  const converted = convertToTelegramMarkdown(text);
  try {
    await botRef.api.sendMessage(chatId, converted, { ...threadOpts, parse_mode: 'MarkdownV2' });
  } catch (mdErr) {
    console.error(`[Monitor] MarkdownV2 send failed (${context}), falling back to plain text:`, mdErr instanceof Error ? mdErr.message : mdErr);
    try {
      await botRef.api.sendMessage(chatId, text, threadOpts);
    } catch (plainErr) {
      console.error(`[Monitor] plain text send also failed (${context}):`, plainErr instanceof Error ? plainErr.message : plainErr);
    }
  }
}

const COALESCE_MS = 200;

export function setMonitorRelayBot(bot: Bot): void {
  botRef = bot;
  setBackgroundCardBot(bot);
}

export type AsyncToolKind = 'monitor' | 'bash_background' | 'subagent' | 'workflow';

/**
 * Kind → the `taskType` string /tasks groups on. Keeps the PTY-mode buckets
 * identical to the SDK-mode ones so the command renders the same either way.
 */
const TASK_TYPE_BY_KIND: Record<AsyncToolKind, string> = {
  monitor: 'monitor_mcp',
  bash_background: 'local_bash',
  subagent: 'local_agent',
  workflow: 'local_workflow',
};

/**
 * Which tool calls are backgrounded — i.e. PostToolUse fires almost at once,
 * the user-turn returns, and the real outcome arrives later as a
 * task-notification. Returns null for everything synchronous.
 *
 * A tool missing from this list is invisible twice over: its completion never
 * reaches Telegram, and it never appears in /tasks. Add new backgrounded
 * tools here.
 */
export function classifyAsyncTool(
  toolName: string,
  toolInput: Record<string, unknown>,
): AsyncToolKind | null {
  if (toolName === 'Monitor') return 'monitor';
  // Bash is only async on the explicit opt-in; the common case is synchronous.
  if (toolName === 'Bash') return toolInput.run_in_background === true ? 'bash_background' : null;
  if (toolName === 'Workflow') return 'workflow';
  if (isSubagentTool(toolName)) return 'subagent';
  return null;
}

/**
 * A plain Bash call claude moved to the background partway through. A command
 * that runs into the 10-minute foreground cap isn't killed: the call returns
 * with a `backgroundTaskId`, and the command finishes later the way a
 * run_in_background one does, with a task-notification. classifyAsyncTool saw
 * an ordinary call at PreToolUse, so only the response tells.
 */
export function movedToBackground(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolResponse: unknown,
): boolean {
  if (toolName !== 'Bash' || classifyAsyncTool(toolName, toolInput) !== null) return false;
  return !!toolResponse && typeof toolResponse === 'object'
    && typeof (toolResponse as { backgroundTaskId?: unknown }).backgroundTaskId === 'string';
}

/**
 * Register that an async tool was invoked (see classifyAsyncTool). Arms the
 * JSONL watcher on first call per session so future task-notifications and
 * their assistant responses get relayed to Telegram, and records the task
 * with `taskTracker` so /tasks and the footer counters can see it.
 *
 * Idempotent — multiple async tool calls in one session share one watcher.
 *
 * `startedAt` is for a task that was already running when it was armed — see
 * movedToBackground.
 */
export function onAsyncToolArmed(
  kind: AsyncToolKind,
  sessionKey: string,
  cwd: string,
  claudeSessionId: string,
  description: string,
  toolUseId?: string,
  startedAt = Date.now(),
): void {
  let state = states.get(sessionKey);
  if (!state) {
    state = {
      sessionKey,
      cwd,
      claudeSessionId,
      jsonlPosition: 0,
      watcher: null,
      inTurn: true,
      selfTurnOpen: false,
      pendingRead: null,
      reply: [],
      replySent: Promise.resolve(),
      armedTasks: new Map(),
    };
    states.set(sessionKey, state);
    startWatching(state);
  }
  // claudeSessionId can change if the session was reset between turns;
  // refresh so the watcher tracks the correct log on the next arm.
  if (state.claudeSessionId !== claudeSessionId) {
    state.claudeSessionId = claudeSessionId;
    stopWatcher(state);
    startWatching(state);
  }
  // Register before the Telegram round-trip, not after it. These entries are
  // what /tasks and the footer counters read, so a failed sendMessage must
  // not render a live background task invisible.
  //
  // A task without a tool_use_id is untrackable rather than merely unposted:
  // the terminal task-notification identifies itself by that id, so there'd
  // be nothing to match the completion against and the entry would leak as a
  // permanently-"running" ghost. Relay it to chat, but don't track it.
  if (toolUseId) {
    state.armedTasks.set(toolUseId, {
      kind,
      description,
      startedAt,
    });
    taskTracker.handleEvent(sessionKey, {
      type: 'started',
      taskId: toolUseId,
      toolUseId,
      description,
      taskType: TASK_TYPE_BY_KIND[kind],
      // Everything routed through this relay is backgrounded by definition —
      // that's the property that made it need a relay in the first place.
      isBackgrounded: true,
      startedAt,
    });
  }

  noteTaskArmed(sessionKey, kind, description, toolUseId, startedAt);
}

export function markTurnStart(sessionKey: string): void {
  const state = states.get(sessionKey);
  if (state) {
    // A turn claude started itself may not be read to the end yet, or not
    // closed. What it wrote goes out now, ahead of this turn, instead of
    // being skipped as this turn's.
    drain(state);
    void sendReply(state);
    state.inTurn = true;
    state.selfTurnOpen = false;
  }
  // The user's own message has just buried any card left over from the
  // previous quiet window; start a fresh one rather than going on editing
  // where nobody is looking.
  sealCard(sessionKey);
}

export function markTurnEnd(sessionKey: string): void {
  const state = states.get(sessionKey);
  if (!state) return;
  // Drain any pending JSONL writes while inTurn is still true so terminal
  // task-notifications that landed during the turn get edit-in-place
  // treatment before the cursor jumps forward.
  drain(state);
  state.inTurn = false;
  // Snap to current end so the user-turn's own assistant text doesn't get
  // sent again as a reply — the turn pipeline already delivered it.
  const filePath = sessionJsonlPath(state.cwd, state.claudeSessionId);
  try {
    state.jsonlPosition = fs.statSync(filePath).size;
  } catch { /* file gone or unreadable; next change event will rediscover */ }
  // The turn pipeline posts its reply as soon as this returns, so whatever
  // is on the card is about to be buried. Seal it — with the completions
  // drained above already on it.
  sealCard(sessionKey);
}

/**
 * Bring the chat up to date ahead of something a tool posts in a turn claude
 * started itself — a question, a file. Nothing streams such a turn, so what
 * it has written so far goes out first, and the card is sealed: both stay
 * above the post, and what the turn writes after it lands below rather than
 * on a card the post has buried.
 */
export async function settleBeforePost(sessionKey: string): Promise<void> {
  const state = states.get(sessionKey);
  if (state && !state.inTurn) {
    drain(state);
    await sendReply(state);
  }
  sealCard(sessionKey);
}

/**
 * Whether a turn claude started itself is still going, or its reply hasn't
 * been handed on yet. Nothing in the request queue knows about such a turn.
 */
export function hasSelfStartedTurn(): boolean {
  for (const state of states.values()) {
    if (state.selfTurnOpen || state.reply.length > 0) return true;
  }
  return false;
}

/** Resolves once every reply already handed on is in its chat. */
export async function whenRepliesSent(): Promise<void> {
  await Promise.all([...states.values()].map((state) => state.replySent));
}

export function teardown(sessionKey: string): void {
  const state = states.get(sessionKey);
  if (!state) return;
  stopWatcher(state);
  // A turn claude started itself and never got to close — it crashed, or was
  // cleared or restarted mid-turn. What it wrote is still the user's to read.
  drain(state);
  void sendReply(state);
  states.delete(sessionKey);
  clearCard(sessionKey);
  // This relay owns the PTY-side tracker entries, and teardown is PTY-only
  // (_cleanupSession is its sole caller). Drop them with the session so a
  // respawned one doesn't inherit tasks that died with the old process.
  taskTracker.clear(sessionKey);
}

function startWatching(state: MonitorState): void {
  const filePath = sessionJsonlPath(state.cwd, state.claudeSessionId);
  try {
    state.jsonlPosition = fs.statSync(filePath).size;
  } catch {
    state.jsonlPosition = 0;
  }
  try {
    state.watcher = fs.watch(filePath, { persistent: false }, () => {
      // fs.watch can fire repeatedly for a single append (rename + change
      // on some platforms). Coalesce so we don't read partial JSON lines.
      if (state.pendingRead) return;
      state.pendingRead = setTimeout(() => {
        state.pendingRead = null;
        handleChange(state);
      }, COALESCE_MS);
    });
  } catch (err) {
    console.error(`[Monitor] failed to watch JSONL for ${state.sessionKey}:`, err);
  }
}

function stopWatcher(state: MonitorState): void {
  if (state.watcher) {
    try { state.watcher.close(); } catch { /* already gone */ }
    state.watcher = null;
  }
}

/**
 * Read now whatever the watcher has been told about but not read yet.
 * Cancels the coalesce timer so it doesn't fire later with the position
 * already past the data.
 */
function drain(state: MonitorState): void {
  if (state.pendingRead) {
    clearTimeout(state.pendingRead);
    state.pendingRead = null;
  }
  handleChange(state);
}

function handleChange(state: MonitorState): void {
  const filePath = sessionJsonlPath(state.cwd, state.claudeSessionId);
  let size: number;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return;
  }
  if (size <= state.jsonlPosition) return;

  let chunk: string;
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(size - state.jsonlPosition);
    fs.readSync(fd, buf, 0, buf.length, state.jsonlPosition);
    fs.closeSync(fd);
    chunk = buf.toString('utf-8');
  } catch (err) {
    console.error('[Monitor] read failed:', err);
    return;
  }
  state.jsonlPosition = size;

  for (const line of chunk.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: unknown;
    try { rec = JSON.parse(trimmed); } catch { continue; }
    if (!rec || typeof rec !== 'object') continue;
    const typed = rec as {
      type?: string;
      subtype?: string;
      origin?: { kind?: string };
      message?: { content?: unknown; role?: string };
      attachment?: QueuedCommandAttachment;
    };

    if (typed.type === 'user') {
      if (!state.inTurn) state.selfTurnOpen = true;
      const notif = parseTaskNotification(typed);
      if (notif) {
        // Terminal notifications (status set + matching armed entry) always
        // get edit-in-place treatment, even during an active user-turn.
        // A backgrounded task can complete at any moment; without this, a
        // completion that lands mid-turn would leave the armed message stuck
        // on "in progress" forever — markTurnEnd would snap the JSONL cursor
        // past the notification and the watcher would never revisit it.
        if (notif.status && notif.toolUseId && state.armedTasks.has(notif.toolUseId)) {
          handleTerminalNotification(state, notif);
          continue;
        }
        // Non-terminal event notifications stay gated on !inTurn — during a
        // user-turn the turn pipeline owns the model's response, and the
        // watcher must not race it.
        if (state.inTurn) continue;
        postMonitorEvent(state.sessionKey, notif);
      }
    } else if (typed.type === 'attachment') {
      // A task that finishes while claude is mid-turn never gets the user
      // record above; its completion only arrives folded into that turn. Left
      // unread, the task stays "running" in the footer and /tasks for the rest
      // of the session. Only the completion is taken from here — the model's
      // reply to it belongs to the turn that absorbed it.
      const notif = parseAbsorbedNotification(typed.attachment);
      if (notif?.status && notif.toolUseId && state.armedTasks.has(notif.toolUseId)) {
        handleTerminalNotification(state, notif);
      }
    } else if (typed.type === 'assistant') {
      // Assistant text during an active turn belongs to the turn pipeline.
      if (state.inTurn) continue;
      const text = extractAssistantText(typed.message?.content);
      if (text) state.reply.push(text);
    } else if (typed.type === 'system' && typed.subtype === 'turn_duration') {
      // Claude Code closes every turn with this record — the ones it starts
      // itself too, and one cut short by an API error as well.
      if (!state.inTurn) {
        state.selfTurnOpen = false;
        void sendReply(state);
      }
    }
  }
}

/**
 * Send what claude has written in a turn it started itself, the way the turn
 * pipeline sends a reply: whole, split across messages only where Telegram
 * needs it, with an Instant View link when it runs long. Joined as
 * readLastAssistantTurnText joins a turn's text records.
 *
 * Resolves once the reply is in the chat, so a tool can post below it.
 */
function sendReply(state: MonitorState): Promise<void> {
  if (state.reply.length === 0) return state.replySent;
  const text = state.reply.join('\n\n');
  state.reply = [];
  // What the card shows happened before this reply. Sealed, the card stays
  // above it, and whatever happens next starts a fresh card below.
  sealCard(state.sessionKey);
  const { sessionKey } = state;
  state.replySent = state.replySent.then(() => postReply(sessionKey, text));
  return state.replySent;
}

async function postReply(sessionKey: string, text: string): Promise<void> {
  if (!botRef) return;
  const ctx = buildSyntheticCtx({ api: botRef.api, sessionKey, syntheticText: '' });
  try {
    // Imported lazily, as mcp-bridge does: this module is loaded from
    // pty-provider at module scope, where every eager edge is a chance to
    // close a cycle back through it.
    const { messageSender } = await import('../telegram/message-sender.js');
    await messageSender.sendMessage(ctx, text);
  } catch (err) {
    console.error('[Monitor] reply send failed:', err instanceof Error ? err.message : err);
  }
}

function extractAssistantText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type: string; text: string } =>
      !!b && typeof b === 'object' && (b as { type?: string }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
    .map((b) => b.text.trim())
    .filter((t) => t.length > 0)
    .join('\n\n');
}

/**
 * Relay claude's PushNotification tool to Telegram. The native tool fires
 * an OS-level notification on the bot host (no real user is sitting there)
 * so the only useful surface is Telegram. Called from PreToolUse and treated
 * independently of the JSONL watcher — push notifications are single-shot
 * and don't need turn-end pairing.
 */
export function relayPushNotification(sessionKey: string, message: string): void {
  if (!botRef) return;
  const trimmed = message.trim();
  if (!trimmed) return;
  const { chatId, threadId } = parseSessionKey(sessionKey);
  const threadOpts = threadId !== undefined ? { message_thread_id: threadId } : {};
  const preview = trimmed.length > 500 ? trimmed.slice(0, 497) + '...' : trimmed;
  sendFormatted(chatId, threadOpts, `🔔 ${preview}`, 'push').catch(() => {});
}

/**
 * Called when a task-notification's status indicates the task is done.
 * Retires the task from the card's running list and records how it ended.
 *
 * Whether that gets the user's attention is the card's call: a failure is
 * urgent enough to re-post immediately, a task that ran past the notification
 * threshold is worth a ping if the card has been sitting a while, and a quick
 * success just folds into the card silently.
 *
 * Returns true when the notification was consumed as a completion; the caller
 * then skips the monitor-event path so we don't double-report.
 */
function handleTerminalNotification(
  state: MonitorState,
  notif: TaskNotification,
): boolean {
  const armed = state.armedTasks.get(notif.toolUseId);
  if (!armed) return false;
  state.armedTasks.delete(notif.toolUseId);
  // Retire the tracker entry before any chat I/O, mirroring the SDK path's
  // remove-after-notification. /tasks filters to running/pending, so dropping
  // it outright is equivalent to recording a terminal status.
  taskTracker.remove(state.sessionKey, notif.toolUseId);

  const elapsedMs = Date.now() - armed.startedAt;
  const isError = notif.status === 'failed' || notif.status === 'killed';
  const longRunning = elapsedMs >= config.NOTIFICATION_THRESHOLD_SECONDS * 1000;

  noteTaskFinished(
    state.sessionKey,
    notif.toolUseId,
    { kind: armed.kind, description: armed.description, status: notif.status, elapsedMs },
    { notify: isError || longRunning, urgent: isError },
  );
  return true;
}

function stripSummaryPrefix(summary: string): string {
  // Claude code formats summaries as `Monitor event: "<desc>"` — strip the
  // boilerplate so the header isn't redundant with the "📡 Monitor" prefix.
  return summary.replace(/^Monitor event:\s*/i, '').replace(/^"(.*)"$/, '$1').trim();
}

/**
 * Put a monitor firing on the card as it lands. What claude says about it is
 * its turn's reply, sent when the turn closes.
 */
function postMonitorEvent(sessionKey: string, notif: TaskNotification): void {
  // A monitor firing is the whole reason the user armed it, so it always
  // wants the user's attention — the card decides whether that means a fresh
  // message or a silent edit onto one it posted moments ago.
  noteMonitorEvent(
    sessionKey,
    notif.summary ? stripSummaryPrefix(notif.summary) : '',
    notif.event,
    { notify: true },
  );
}
