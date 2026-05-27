import * as fs from 'fs';
import type { Bot } from 'grammy';
import { sessionJsonlPath } from './session-jsonl.js';
import { parseSessionKey } from '../utils/session-key.js';
import { convertToTelegramMarkdown } from '../telegram/markdown.js';
import { config } from '../config.js';

/**
 * PTY-mode Monitor relay. When claude calls its built-in Monitor tool, events
 * that fire later (after our user-turn has ended) show up as new assistant
 * records appended to the session JSONL. Without this module those records
 * would never reach Telegram — the turn pipeline only forwards content
 * while a turn is active.
 *
 * Mechanism: per-session JSONL watcher armed on the first Monitor PreToolUse.
 * Tracks byte position; on file change, reads new bytes, parses assistant text
 * blocks, posts each to Telegram. Suppresses relay while a user turn is
 * active so the turn's own response doesn't double-post — the turn pipeline
 * delivers that directly.
 *
 * State is per-sessionKey and torn down with the session. No persistence:
 * if the bot restarts, the user has to re-arm any monitors they want.
 */

interface MonitorState {
  sessionKey: string;
  cwd: string;
  claudeSessionId: string;
  jsonlPosition: number;
  watcher: fs.FSWatcher | null;
  descriptions: string[];
  inTurn: boolean;
  /** Coalesce rapid-fire change events into one read. */
  pendingRead: NodeJS.Timeout | null;
  /**
   * The most recently seen task-notification user record that hasn't yet
   * been paired with an assistant response. Lives across handleChange calls
   * because the assistant response often appears in a later chunk than the
   * notification that triggered it.
   */
  pendingNotification: TaskNotification | null;
  /**
   * Armed-message bookkeeping keyed by tool_use_id. Populated by
   * onAsyncToolArmed → postArmed when an async tool fires; consumed by
   * handleChange when its terminal task-notification arrives so the original
   * "armed" Telegram message gets edited in place instead of going stale.
   */
  armedTasks: Map<string, ArmedTask>;
}

interface ArmedTask {
  messageId: number;
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

const MAX_EVENT_CHARS = 2000;
const COALESCE_MS = 200;

export function setMonitorRelayBot(bot: Bot): void {
  botRef = bot;
}

export type AsyncToolKind = 'monitor' | 'bash_background' | 'subagent';

/**
 * Register that an async tool (Monitor, backgrounded Bash, or subagent Task)
 * was invoked. Arms the JSONL watcher on first call per session so future
 * task-notifications and their assistant responses get relayed to Telegram.
 *
 * Idempotent — multiple async tool calls in one session share one watcher.
 */
export function onAsyncToolArmed(
  kind: AsyncToolKind,
  sessionKey: string,
  cwd: string,
  claudeSessionId: string,
  description: string,
  toolUseId?: string,
): void {
  let state = states.get(sessionKey);
  if (!state) {
    state = {
      sessionKey,
      cwd,
      claudeSessionId,
      jsonlPosition: 0,
      watcher: null,
      descriptions: [],
      inTurn: true,
      pendingRead: null,
      pendingNotification: null,
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
  state.descriptions.push(description);
  postArmed(sessionKey, kind, description).then((messageId) => {
    if (messageId !== null && toolUseId) {
      state!.armedTasks.set(toolUseId, {
        messageId,
        kind,
        description,
        startedAt: Date.now(),
      });
    }
  }).catch(() => { /* postArmed already logs */ });
}

export function markTurnStart(sessionKey: string): void {
  const state = states.get(sessionKey);
  if (state) state.inTurn = true;
}

export function markTurnEnd(sessionKey: string): void {
  const state = states.get(sessionKey);
  if (!state) return;
  // Drain any pending JSONL writes while inTurn is still true so terminal
  // task-notifications that landed during the turn get edit-in-place
  // treatment before the cursor jumps forward. Cancel the coalesce timer so
  // it doesn't fire later with the position already past the data.
  if (state.pendingRead) {
    clearTimeout(state.pendingRead);
    state.pendingRead = null;
  }
  handleChange(state);
  state.inTurn = false;
  // Snap to current end so the user-turn's own assistant text doesn't get
  // re-emitted as a monitor event — the turn pipeline already delivered it.
  const filePath = sessionJsonlPath(state.cwd, state.claudeSessionId);
  try {
    state.jsonlPosition = fs.statSync(filePath).size;
  } catch { /* file gone or unreadable; next change event will rediscover */ }
}

export function teardown(sessionKey: string): void {
  const state = states.get(sessionKey);
  if (!state) return;
  stopWatcher(state);
  if (state.pendingRead) {
    clearTimeout(state.pendingRead);
    state.pendingRead = null;
  }
  states.delete(sessionKey);
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
      origin?: { kind?: string };
      message?: { content?: unknown; role?: string };
    };

    if (typed.type === 'user') {
      const notif = parseTaskNotification(typed);
      if (notif) {
        // Terminal notifications (status set + matching armed entry) always
        // get edit-in-place treatment, even during an active user-turn.
        // A backgrounded task can complete at any moment; without this, a
        // completion that lands mid-turn would leave the armed message stuck
        // on "in progress" forever — markTurnEnd would snap the JSONL cursor
        // past the notification and the watcher would never revisit it.
        if (notif.status && notif.toolUseId && state.armedTasks.has(notif.toolUseId)) {
          handleTerminalNotification(state, notif).catch((err) => {
            console.error('[Monitor] terminal notification handler failed:', err instanceof Error ? err.message : err);
          });
          continue;
        }
        // Non-terminal event notifications stay gated on !inTurn — during a
        // user-turn the turn pipeline owns the model's response, and the
        // watcher must not race it.
        if (state.inTurn) continue;
        // Two notifications in a row without a paired response = orphan;
        // flush the first one alone before tracking the new trigger.
        if (state.pendingNotification) {
          postMonitorMessage(state.sessionKey, state.pendingNotification, '');
        }
        state.pendingNotification = notif;
      }
    } else if (typed.type === 'assistant') {
      // Assistant text during an active turn belongs to the turn pipeline.
      if (state.inTurn) continue;
      const text = extractAssistantText(typed.message?.content);
      if (!text) continue;
      postMonitorMessage(state.sessionKey, state.pendingNotification, text);
      state.pendingNotification = null;
    }
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

async function postArmed(sessionKey: string, kind: AsyncToolKind, description: string): Promise<number | null> {
  if (!botRef) return null;
  const { chatId, threadId } = parseSessionKey(sessionKey);
  const threadOpts = threadId !== undefined ? { message_thread_id: threadId } : {};
  const preview = description.length > 200 ? description.slice(0, 197) + '...' : description;
  const header = armedHeader(kind);
  return await sendFormattedReturnId(chatId, threadOpts, `${header}: ${preview}`, 'armed');
}

function armedHeader(kind: AsyncToolKind): string {
  return kind === 'monitor' ? '📡 Monitor armed' :
    kind === 'bash_background' ? '⚙️ Backgrounded' :
    '🤖 Subagent started';
}

/**
 * Variant of sendFormatted that returns the resulting message_id (or null on
 * failure) so callers can edit the message in place later.
 */
async function sendFormattedReturnId(
  chatId: number,
  threadOpts: { message_thread_id?: number },
  text: string,
  context: string,
): Promise<number | null> {
  if (!botRef) return null;
  const converted = convertToTelegramMarkdown(text);
  try {
    const msg = await botRef.api.sendMessage(chatId, converted, { ...threadOpts, parse_mode: 'MarkdownV2' });
    return msg.message_id;
  } catch (mdErr) {
    console.error(`[Monitor] MarkdownV2 send failed (${context}), falling back to plain text:`, mdErr instanceof Error ? mdErr.message : mdErr);
    try {
      const msg = await botRef.api.sendMessage(chatId, text, threadOpts);
      return msg.message_id;
    } catch (plainErr) {
      console.error(`[Monitor] plain text send also failed (${context}):`, plainErr instanceof Error ? plainErr.message : plainErr);
      return null;
    }
  }
}

function formatDuration(elapsedMs: number): string {
  const seconds = Math.max(0, Math.round(elapsedMs / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}

function completionIcon(kind: AsyncToolKind, status: string): string {
  if (status === 'failed') return '❌';
  if (status === 'killed' || status === 'stopped') return '🛑';
  // completed (or unknown) — keep the kind's badge but flip Monitor's ⚡ feel
  // to the same 📡 it had while armed; backgrounded/subagent get ✅.
  return kind === 'monitor' ? '📡' : '✅';
}

function completionLabel(kind: AsyncToolKind): string {
  return kind === 'monitor' ? 'Monitor' :
    kind === 'bash_background' ? 'Backgrounded' :
    'Subagent';
}

/**
 * Called when a task-notification's status indicates the task is done.
 * Edits the original armed message in place ("⚙️ Backgrounded: foo" →
 * "✅ Backgrounded: foo (12s)") and, when the task ran long enough that
 * the user might've scrolled away — or when it errored — also posts a
 * fresh chat message so Telegram raises a notification.
 *
 * Returns true when the notification was consumed as a completion; the
 * caller then skips the event-payload pairing path so we don't double-post.
 */
async function handleTerminalNotification(
  state: MonitorState,
  notif: TaskNotification,
): Promise<boolean> {
  const armed = state.armedTasks.get(notif.toolUseId);
  if (!armed) return false;
  state.armedTasks.delete(notif.toolUseId);
  if (!botRef) return true;

  const elapsedMs = Date.now() - armed.startedAt;
  const duration = formatDuration(elapsedMs);
  const icon = completionIcon(armed.kind, notif.status);
  const label = completionLabel(armed.kind);
  const preview = armed.description.length > 200
    ? armed.description.slice(0, 197) + '...'
    : armed.description;
  const isError = notif.status === 'failed' || notif.status === 'killed';
  const longRunning = elapsedMs >= config.NOTIFICATION_THRESHOLD_SECONDS * 1000;

  const body = `${icon} ${label}: ${preview} (${duration})`;

  const { chatId, threadId } = parseSessionKey(state.sessionKey);
  const threadOpts = threadId !== undefined ? { message_thread_id: threadId } : {};

  try {
    await botRef.api.editMessageText(
      chatId,
      armed.messageId,
      convertToTelegramMarkdown(body),
      { parse_mode: 'MarkdownV2' },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/not modified/i.test(msg)) {
      console.error('[Monitor] failed to edit armed message:', msg);
    }
  }

  if (longRunning || isError) {
    await sendFormatted(chatId, threadOpts, body, 'completion');
  }
  return true;
}

function stripSummaryPrefix(summary: string): string {
  // Claude code formats summaries as `Monitor event: "<desc>"` — strip the
  // boilerplate so the header isn't redundant with the "📡 Monitor" prefix.
  return summary.replace(/^Monitor event:\s*/i, '').replace(/^"(.*)"$/, '$1').trim();
}

function postMonitorMessage(
  sessionKey: string,
  notif: TaskNotification | null,
  response: string,
): void {
  if (!botRef) return;
  if (!notif && !response) return;

  const { chatId, threadId } = parseSessionKey(sessionKey);
  const threadOpts = threadId !== undefined ? { message_thread_id: threadId } : {};

  const lines: string[] = [];
  let header = '📡 Monitor';
  if (notif?.summary) {
    const desc = stripSummaryPrefix(notif.summary);
    if (desc) header += ` — ${desc}`;
  }
  lines.push(header);

  if (notif?.event) {
    const ep = notif.event.length > 500 ? notif.event.slice(0, 497) + '...' : notif.event;
    lines.push(`▸ ${ep}`);
  }

  if (response) {
    const rp = response.length > MAX_EVENT_CHARS ? response.slice(0, MAX_EVENT_CHARS - 3) + '...' : response;
    if (lines.length > 1) lines.push('');
    lines.push(rp);
  }

  sendFormatted(chatId, threadOpts, lines.join('\n'), 'event').catch(() => {});
}
