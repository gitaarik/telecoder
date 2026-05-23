import * as fs from 'fs';
import type { Bot } from 'grammy';
import { sessionJsonlPath } from './session-jsonl.js';
import { parseSessionKey } from '../utils/session-key.js';

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
}

const states = new Map<string, MonitorState>();
let botRef: Bot | null = null;

const MAX_EVENT_CHARS = 2000;
const COALESCE_MS = 200;

export function setMonitorRelayBot(bot: Bot): void {
  botRef = bot;
}

/**
 * Register that Monitor was invoked in this session. Idempotent — multiple
 * Monitor calls in the same session share one watcher; we just append the
 * descriptions for the "armed" announcement.
 */
export function onMonitorArmed(
  sessionKey: string,
  cwd: string,
  claudeSessionId: string,
  description: string,
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
  postArmed(sessionKey, description);
}

export function markTurnStart(sessionKey: string): void {
  const state = states.get(sessionKey);
  if (state) state.inTurn = true;
}

export function markTurnEnd(sessionKey: string): void {
  const state = states.get(sessionKey);
  if (!state) return;
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

  // During an active user-turn, the normal pipeline handles assistant text.
  // We've already advanced the position so post-turn events won't re-process
  // this content.
  if (state.inTurn) return;

  for (const line of chunk.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: unknown;
    try { rec = JSON.parse(trimmed); } catch { continue; }
    if (!rec || typeof rec !== 'object') continue;
    const typed = rec as { type?: string; message?: { content?: unknown } };
    if (typed.type !== 'assistant') continue;
    const text = extractAssistantText(typed.message?.content);
    if (text) postEvent(state.sessionKey, text);
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

function postArmed(sessionKey: string, description: string): void {
  if (!botRef) return;
  const { chatId, threadId } = parseSessionKey(sessionKey);
  const threadOpts = threadId !== undefined ? { message_thread_id: threadId } : {};
  const preview = description.length > 200 ? description.slice(0, 197) + '...' : description;
  botRef.api
    .sendMessage(chatId, `📡 Monitor armed: ${preview}`, threadOpts)
    .catch((err) => {
      console.error('[Monitor] failed to post armed message:', err instanceof Error ? err.message : err);
    });
}

function postEvent(sessionKey: string, text: string): void {
  if (!botRef) return;
  const { chatId, threadId } = parseSessionKey(sessionKey);
  const threadOpts = threadId !== undefined ? { message_thread_id: threadId } : {};
  const preview = text.length > MAX_EVENT_CHARS ? text.slice(0, MAX_EVENT_CHARS - 3) + '...' : text;
  botRef.api
    .sendMessage(chatId, `📡 Monitor event\n\n${preview}`, threadOpts)
    .catch((err) => {
      console.error('[Monitor] failed to post event:', err instanceof Error ? err.message : err);
    });
}
