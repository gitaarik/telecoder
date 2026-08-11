/**
 * One live "background activity" card per session.
 *
 * PTY-mode async work (monitors, backgrounded Bash, subagents, workflows)
 * reports in from outside any user turn, so every arm, event and completion
 * used to arrive as its own Telegram message — a monitor that fires ten times
 * produced ten messages. This module folds all of it into a single message
 * that is edited in place, the shape `ActionLogger` already gives a turn's
 * tool output.
 *
 * Two things stop it from being a plain edit-forever accumulator:
 *
 *  - Telegram raises no push notification for an edited message. A monitor
 *    exists to tell the user something happened, so a card that only ever
 *    edits goes silent on their phone.
 *  - Once anything else is posted the card is buried up-chat, and edits to a
 *    buried message are invisible.
 *
 * So the card *re-anchors*: it is sealed and re-posted fresh at the bottom
 * when it goes stale (a turn ran) or when something notify-worthy lands and
 * the current card has been on screen a while. Bursts collapse into one
 * message; a genuinely new event still buzzes the phone. REANCHOR_FLOOR_MS is
 * the knob trading notifications against message count.
 */

import { GrammyError, type Bot } from 'grammy';
import { escapeMarkdownV2, convertToTelegramMarkdown } from './markdown.js';
import { parseSessionKey } from '../utils/session-key.js';

export type BackgroundTaskKind = 'monitor' | 'bash_background' | 'subagent' | 'workflow';

/**
 * Minimum gap between edits of one card. Telegram tolerates roughly 20
 * edits/minute per chat; 5s stays well clear while still reading as live.
 */
const MIN_EDIT_INTERVAL_MS = 5_000;

/**
 * How long a card must have been on screen before a notify-worthy event is
 * allowed to re-anchor it. Under this, the event folds into the existing card
 * — the user was pinged recently enough. Raise for a quieter chat, lower for
 * more responsive notifications.
 */
const REANCHOR_FLOOR_MS = 120_000;

/** Telegram refuses to edit messages older than 48h. Re-anchor well before. */
const MAX_CARD_AGE_MS = 24 * 60 * 60 * 1000;

/** Events kept on one card before the oldest scroll off. */
const MAX_EVENTS = 8;

const MAX_CARD_CHARS = 3800;
const MAX_BODY_CHARS = 1200;
const MAX_DETAIL_CHARS = 400;
const MAX_TITLE_CHARS = 140;

interface RunningTask {
  kind: BackgroundTaskKind;
  description: string;
  startedAt: number;
}

interface CardEvent {
  at: number;
  icon: string;
  title: string;
  /** Machine payload from the task notification; rendered as a code block. */
  detail?: string;
  /** Claude's prose response to the event. */
  body?: string;
}

interface CardState {
  sessionKey: string;
  chatId: number;
  threadId?: number;
  /** null when no card is currently anchored; the next flush posts a fresh one. */
  messageId: number | null;
  /** When the current card message was posted. Drives the re-anchor floor and the 48h ceiling. */
  anchoredAt: number;
  running: Map<string, RunningTask>;
  events: CardEvent[];
  lastEditAt: number;
  rateLimitedUntil: number;
  flushTimer: NodeJS.Timeout | null;
  dirty: boolean;
  inFlight: boolean;
  /** Last text successfully placed on the card; skips no-op edits. */
  lastRendered: string;
  /**
   * Bumped whenever the card is cleared. A flush that started before the
   * bump discards its result instead of writing back onto state belonging
   * to a session that has since been torn down.
   */
  epoch: number;
  /**
   * A seal that arrived mid-send, deferred until the send resolves. Sealing
   * immediately would throw away the message id still in flight, orphaning
   * a card in the chat that nothing can ever edit again — it would sit on
   * "running" forever.
   */
  sealPending: boolean;
}

const cards = new Map<string, CardState>();
let botRef: Bot | null = null;

export function setBackgroundCardBot(bot: Bot | null): void {
  botRef = bot;
}

export interface NoteOptions {
  /** This entry is something the user would want a phone notification for. */
  notify?: boolean;
  /** Notify-worthy enough to ignore REANCHOR_FLOOR_MS (failures). */
  urgent?: boolean;
}

/** Register a newly armed background task so it shows as running on the card. */
export function noteTaskArmed(
  sessionKey: string,
  kind: BackgroundTaskKind,
  description: string,
  toolUseId?: string,
): void {
  const state = getOrCreate(sessionKey);
  if (!state) return;
  if (toolUseId) {
    state.running.set(toolUseId, { kind, description, startedAt: Date.now() });
  } else {
    // No tool_use_id means no terminal notification can ever be matched to
    // it, so a running row would never clear. Record it as a one-off event
    // instead of leaving a permanent ghost in the running list.
    state.events.push({ at: Date.now(), icon: kindIcon(kind), title: `${kindLabel(kind)} started: ${description}` });
  }
  markDirty(state);
}

/** Retire a running task and record how it ended. */
export function noteTaskFinished(
  sessionKey: string,
  toolUseId: string,
  info: { kind: BackgroundTaskKind; description: string; status: string; elapsedMs: number },
  opts: NoteOptions = {},
): void {
  const state = getOrCreate(sessionKey);
  if (!state) return;
  state.running.delete(toolUseId);
  const verb = info.status === 'failed' ? 'failed'
    : info.status === 'killed' || info.status === 'stopped' ? 'stopped'
    : info.kind === 'monitor' ? 'ended' : 'done';
  pushEvent(state, {
    at: Date.now(),
    icon: completionIcon(info.kind, info.status),
    title: `${kindLabel(info.kind)} ${verb}: ${info.description} (${formatDuration(info.elapsedMs)})`,
  }, opts);
}

/** Record a monitor firing, with whatever Claude said about it. */
export function noteMonitorEvent(
  sessionKey: string,
  summary: string,
  detail: string,
  body: string,
  opts: NoteOptions = {},
): void {
  const state = getOrCreate(sessionKey);
  if (!state) return;
  pushEvent(state, {
    at: Date.now(),
    icon: '📡',
    title: summary ? `Monitor — ${summary}` : 'Monitor',
    detail: detail || undefined,
    body: body || undefined,
  }, opts);
}

/**
 * Seal the current card and stop editing it. Called at turn boundaries: the
 * turn pipeline is about to post (or has just posted) its own messages, which
 * bury the card, so any later edit would land where nobody is looking.
 *
 * Running tasks survive into the next card; the event list does not — a fresh
 * card is a fresh digest, not a replay of what is already in the scrollback.
 */
export function sealCard(sessionKey: string): void {
  const state = cards.get(sessionKey);
  if (!state) return;
  // Let the in-flight call finish and adopt its message id first; flush()
  // re-enters here from its finally block.
  if (state.inFlight) {
    state.sealPending = true;
    return;
  }
  if (state.flushTimer) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }
  // Final edit so the sealed card is not left showing a stale intermediate
  // state. Bypasses the throttle — turn boundaries are rare enough.
  if (state.messageId !== null && state.dirty) {
    void editCard(state, state.messageId, renderCard(state), renderCardPlain(state));
  }
  state.messageId = null;
  state.anchoredAt = 0;
  state.events = [];
  state.lastRendered = '';
  state.dirty = false;
}

/** Drop all card state for a session (teardown, /reset). */
export function clearCard(sessionKey: string): void {
  const state = cards.get(sessionKey);
  if (!state) return;
  if (state.flushTimer) clearTimeout(state.flushTimer);
  state.epoch++;
  cards.delete(sessionKey);
}

/** Test seam: read the live card state without exporting the map. */
export function _inspectCard(sessionKey: string): {
  messageId: number | null;
  running: number;
  events: number;
  text: string;
} | null {
  const state = cards.get(sessionKey);
  if (!state) return null;
  return {
    messageId: state.messageId,
    running: state.running.size,
    events: state.events.length,
    text: renderCardPlain(state),
  };
}

function getOrCreate(sessionKey: string): CardState | null {
  const existing = cards.get(sessionKey);
  if (existing) return existing;
  const { chatId, threadId } = parseSessionKey(sessionKey);
  if (!Number.isFinite(chatId)) return null;
  const state: CardState = {
    sessionKey,
    chatId,
    threadId,
    messageId: null,
    anchoredAt: 0,
    running: new Map(),
    events: [],
    lastEditAt: 0,
    rateLimitedUntil: 0,
    flushTimer: null,
    dirty: false,
    inFlight: false,
    lastRendered: '',
    epoch: 0,
    sealPending: false,
  };
  cards.set(sessionKey, state);
  return state;
}

function pushEvent(state: CardState, event: CardEvent, opts: NoteOptions): void {
  // Re-anchor before appending so the new event lands on the fresh card
  // rather than on the one about to be sealed.
  if (opts.notify && shouldReanchor(state, opts.urgent === true)) sealCard(state.sessionKey);
  state.events.push(event);
  if (state.events.length > MAX_EVENTS) state.events = state.events.slice(-MAX_EVENTS);
  markDirty(state);
}

function shouldReanchor(state: CardState, urgent: boolean): boolean {
  // Nothing anchored yet — the next flush posts fresh (and notifies) anyway.
  if (state.messageId === null) return false;
  if (urgent) return true;
  return Date.now() - state.anchoredAt >= REANCHOR_FLOOR_MS;
}

function markDirty(state: CardState): void {
  state.dirty = true;
  scheduleFlush(state);
}

function scheduleFlush(state: CardState): void {
  if (state.flushTimer || state.inFlight) return;
  const now = Date.now();
  // The first post of a card lands immediately; only edits are throttled.
  const earliest = state.messageId === null
    ? Math.max(now, state.rateLimitedUntil)
    : Math.max(state.lastEditAt + MIN_EDIT_INTERVAL_MS, state.rateLimitedUntil);
  const delay = Math.max(0, earliest - now);
  if (delay === 0) {
    void flush(state);
    return;
  }
  state.flushTimer = setTimeout(() => {
    state.flushTimer = null;
    void flush(state);
  }, delay);
  // Never hold the process open for a pending cosmetic edit.
  state.flushTimer.unref?.();
}

async function flush(state: CardState): Promise<void> {
  if (!botRef || state.inFlight || !state.dirty) return;

  // Telegram rejects edits to messages past 48h outright; drop the anchor
  // early so this turns into a fresh post instead of a guaranteed failure.
  if (state.messageId !== null && Date.now() - state.anchoredAt > MAX_CARD_AGE_MS) {
    state.messageId = null;
    state.lastRendered = '';
  }

  const text = renderCard(state);
  if (state.messageId !== null && text === state.lastRendered) {
    state.dirty = false;
    return;
  }

  const epoch = state.epoch;
  state.inFlight = true;
  state.dirty = false;
  try {
    const plain = renderCardPlain(state);
    if (state.messageId === null) {
      const messageId = await sendCard(state, text, plain);
      // Torn down while the send was in flight — the session is gone, so
      // there is nothing left to adopt this message id.
      if (epoch !== state.epoch) return;
      if (messageId !== null) {
        state.messageId = messageId;
        state.anchoredAt = Date.now();
        state.lastEditAt = Date.now();
        state.lastRendered = text;
      }
    } else {
      const ok = await editCard(state, state.messageId, text, plain);
      if (epoch !== state.epoch) return;
      state.lastEditAt = Date.now();
      if (ok) state.lastRendered = text;
    }
  } finally {
    state.inFlight = false;
    if (state.sealPending) {
      state.sealPending = false;
      sealCard(state.sessionKey);
    } else if (state.dirty && epoch === state.epoch) {
      scheduleFlush(state);
    }
  }
}

async function sendCard(state: CardState, text: string, plain: string): Promise<number | null> {
  if (!botRef) return null;
  const opts = state.threadId !== undefined ? { message_thread_id: state.threadId } : {};
  try {
    const msg = await botRef.api.sendMessage(state.chatId, text, { ...opts, parse_mode: 'MarkdownV2' });
    return msg.message_id;
  } catch (err) {
    if (noteRateLimit(state, err)) return null;
    console.error('[BackgroundCard] MarkdownV2 send failed, falling back to plain text:', describe(err));
    try {
      const msg = await botRef.api.sendMessage(state.chatId, plain, opts);
      return msg.message_id;
    } catch (plainErr) {
      console.error('[BackgroundCard] plain text send also failed:', describe(plainErr));
      return null;
    }
  }
}

async function editCard(state: CardState, messageId: number, text: string, plain: string): Promise<boolean> {
  if (!botRef) return false;
  try {
    await botRef.api.editMessageText(state.chatId, messageId, text, { parse_mode: 'MarkdownV2' });
    return true;
  } catch (err) {
    if (noteRateLimit(state, err)) return false;
    const msg = describe(err).toLowerCase();
    // Already showing this content — the render matched what is on screen.
    if (msg.includes('not modified')) return true;
    // The card was deleted out from under us; drop the anchor so the next
    // flush posts a fresh one rather than retrying a dead message id.
    if (msg.includes('message to edit not found') || msg.includes('message_id_invalid')) {
      state.messageId = null;
      state.lastRendered = '';
      return false;
    }
    console.error('[BackgroundCard] MarkdownV2 edit failed, falling back to plain text:', describe(err));
    try {
      await botRef.api.editMessageText(state.chatId, messageId, plain);
      return true;
    } catch (plainErr) {
      console.error('[BackgroundCard] plain text edit also failed:', describe(plainErr));
      return false;
    }
  }
}

/** Record Telegram's retry_after so scheduleFlush backs off instead of hammering. */
function noteRateLimit(state: CardState, err: unknown): boolean {
  if (!(err instanceof GrammyError) || err.error_code !== 429) return false;
  const retryAfter = err.parameters.retry_after ?? 60;
  state.rateLimitedUntil = Date.now() + retryAfter * 1000;
  state.dirty = true;
  console.warn(`[BackgroundCard] rate limited, backing off for ${retryAfter}s`);
  return true;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function renderCard(state: CardState): string {
  for (let limit = state.events.length; limit >= 0; limit--) {
    const text = renderCardAt(state, limit);
    if (text.length <= MAX_CARD_CHARS) return text;
  }
  return renderCardAt(state, 0).slice(0, MAX_CARD_CHARS);
}

function renderCardAt(state: CardState, eventLimit: number): string {
  const lines: string[] = [`📡 *${escapeMarkdownV2('Background activity')}*`];

  const running = [...state.running.values()].sort((a, b) => a.startedAt - b.startedAt);
  if (running.length > 0) {
    lines.push('');
    const now = Date.now();
    for (const task of running) {
      const label = `${kindLabel(task.kind)}: ${truncate(task.description, MAX_TITLE_CHARS)}`;
      lines.push(`${kindIcon(task.kind)} ${escapeMarkdownV2(label)} · _${escapeMarkdownV2(`running ${formatDuration(now - task.startedAt)}`)}_`);
    }
  }

  const shown = eventLimit > 0 ? state.events.slice(-eventLimit) : [];
  const dropped = state.events.length - shown.length;
  if (dropped > 0) {
    lines.push('');
    lines.push(`_${escapeMarkdownV2(`… ${dropped} earlier event${dropped === 1 ? '' : 's'}`)}_`);
  }

  for (const event of shown) {
    lines.push('');
    lines.push(`${event.icon} _${escapeMarkdownV2(clockTime(event.at))}_ ${escapeMarkdownV2(truncate(event.title, MAX_TITLE_CHARS))}`);
    if (event.detail) {
      lines.push(`\`\`\`\n${escapeMarkdownV2(truncate(event.detail, MAX_DETAIL_CHARS))}\n\`\`\``);
    }
    if (event.body) {
      lines.push(convertToTelegramMarkdown(truncate(event.body, MAX_BODY_CHARS)));
    }
  }

  if (running.length === 0 && shown.length === 0 && dropped === 0) {
    lines.push('');
    lines.push(`_${escapeMarkdownV2('nothing running')}_`);
  }

  return lines.join('\n');
}

function renderCardPlain(state: CardState): string {
  const lines: string[] = ['📡 Background activity'];

  const running = [...state.running.values()].sort((a, b) => a.startedAt - b.startedAt);
  if (running.length > 0) {
    lines.push('');
    const now = Date.now();
    for (const task of running) {
      lines.push(`${kindIcon(task.kind)} ${kindLabel(task.kind)}: ${truncate(task.description, MAX_TITLE_CHARS)} · running ${formatDuration(now - task.startedAt)}`);
    }
  }

  for (const event of state.events.slice(-MAX_EVENTS)) {
    lines.push('');
    lines.push(`${event.icon} ${clockTime(event.at)} ${truncate(event.title, MAX_TITLE_CHARS)}`);
    if (event.detail) lines.push(truncate(event.detail, MAX_DETAIL_CHARS));
    if (event.body) lines.push(truncate(event.body, MAX_BODY_CHARS));
  }

  if (running.length === 0 && state.events.length === 0) {
    lines.push('');
    lines.push('nothing running');
  }

  const text = lines.join('\n');
  return text.length > MAX_CARD_CHARS ? text.slice(0, MAX_CARD_CHARS - 3) + '...' : text;
}

function kindIcon(kind: BackgroundTaskKind): string {
  return kind === 'monitor' ? '📡'
    : kind === 'bash_background' ? '⚙️'
    : kind === 'workflow' ? '📋'
    : '🤖';
}

function kindLabel(kind: BackgroundTaskKind): string {
  return kind === 'monitor' ? 'Monitor'
    : kind === 'bash_background' ? 'Backgrounded'
    : kind === 'workflow' ? 'Workflow'
    : 'Subagent';
}

function completionIcon(kind: BackgroundTaskKind, status: string): string {
  if (status === 'failed') return '❌';
  if (status === 'killed' || status === 'stopped') return '🛑';
  return kind === 'monitor' ? '📡' : '✅';
}

export function formatDuration(elapsedMs: number): string {
  const seconds = Math.max(0, Math.round(elapsedMs / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}

function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? trimmed.slice(0, max - 3) + '...' : trimmed;
}
