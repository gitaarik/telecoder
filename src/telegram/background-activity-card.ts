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
 *
 * Nothing new may come in for a long while, though: a build in the background
 * says nothing until it ends. So the card is also brought down when a turn
 * closes or a command answers (bringCardDown), silently, as long as tasks run
 * — the user is in the chat then, and a card above what they just read would
 * leave them thinking nothing runs. A card that only listed running tasks is
 * deleted once its successor is up, so the chat keeps one of them; a card
 * with events on it stays where they happened.
 */

import { GrammyError, type Bot } from 'grammy';
import { EntityText, sliceMessage, type EntityMessage } from './entities.js';
import { sendFormatted, editFormatted } from './send.js';
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
  /** A bringCardDown that arrived mid-send, run once the send resolves. */
  bringDownPending: BringDownOptions | null;
  /** The last sealed card and what it showed, until the next card is posted. */
  sealedId: number | null;
  sealedEvents: CardEvent[];
  /** Cards to delete once the next one is up: the ones it replaces. */
  retired: number[];
  /** Post the next card without a notification: it moved, nothing happened. */
  silentNext: boolean;
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
  startedAt = Date.now(),
): void {
  const state = getOrCreate(sessionKey);
  if (!state) return;
  if (toolUseId) {
    state.running.set(toolUseId, { kind, description, startedAt });
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

/**
 * Record a monitor firing. What Claude says about it is not the card's: the
 * monitor relay sends that as a reply of its own, which a card could only
 * hold cut short.
 */
export function noteMonitorEvent(
  sessionKey: string,
  summary: string,
  detail: string,
  opts: NoteOptions = {},
): void {
  const state = getOrCreate(sessionKey);
  if (!state) return;
  pushEvent(state, {
    at: Date.now(),
    icon: '📡',
    title: summary ? `Monitor — ${summary}` : 'Monitor',
    detail: detail || undefined,
  }, opts);
}

export interface BringDownOptions {
  /**
   * Take the events of the last sealed card along, and delete it. For a user
   * asking to see the card here; a turn closing leaves them where they were,
   * next to the replies they led to.
   */
  withLog?: boolean;
}

/** Whether the session's card lists tasks still running. */
export function hasRunningTasks(sessionKey: string): boolean {
  return (cards.get(sessionKey)?.running.size ?? 0) > 0;
}

/**
 * Post the card again at the bottom of the chat, silently, if tasks still run.
 * Called after something was posted below it: a turn's reply, a command's.
 * Returns whether there was a card to bring down.
 */
export function bringCardDown(sessionKey: string, opts: BringDownOptions = {}): boolean {
  const state = cards.get(sessionKey);
  if (!state || state.running.size === 0) return false;
  if (state.inFlight) {
    state.bringDownPending = { withLog: opts.withLog || state.bringDownPending?.withLog };
    return true;
  }
  if (state.flushTimer) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }
  if (state.messageId !== null) {
    // The live card moves as a whole, events and all.
    state.retired.push(state.messageId);
    state.messageId = null;
    state.anchoredAt = 0;
  } else if (opts.withLog && state.sealedId !== null) {
    state.events = [...state.sealedEvents, ...state.events].slice(-MAX_EVENTS);
    state.retired.push(state.sealedId);
    state.sealedId = null;
    state.sealedEvents = [];
  }
  state.lastRendered = '';
  state.silentNext = true;
  markDirty(state);
  return true;
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
  // state. Bypasses the throttle — turn boundaries are rare enough. A card
  // with tasks still running gets it even when clean: its bottom line must
  // stop saying they run here, since their end lands on the next card.
  if (state.messageId !== null && (state.dirty || state.running.size > 0)) {
    void editCard(state, state.messageId, renderCard(state, true));
  }
  if (state.messageId !== null) {
    state.sealedId = state.messageId;
    state.sealedEvents = state.events;
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
    text: renderCard(state).text,
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
    bringDownPending: null,
    sealedId: null,
    sealedEvents: [],
    retired: [],
    silentNext: false,
  };
  cards.set(sessionKey, state);
  return state;
}

function pushEvent(state: CardState, event: CardEvent, opts: NoteOptions): void {
  // Re-anchor before appending so the new event lands on the fresh card
  // rather than on the one about to be sealed.
  if (opts.notify && shouldReanchor(state, opts.urgent === true)) sealCard(state.sessionKey);
  // Something did happen: whatever posts the card next should buzz.
  if (opts.notify) state.silentNext = false;
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

  const card = renderCard(state);
  const text = card.text;
  if (state.messageId !== null && text === state.lastRendered) {
    state.dirty = false;
    return;
  }

  const epoch = state.epoch;
  state.inFlight = true;
  state.dirty = false;
  try {
    if (state.messageId === null) {
      const messageId = await sendCard(state, card, state.silentNext);
      // Torn down while the send was in flight — the session is gone, so
      // there is nothing left to adopt this message id.
      if (epoch !== state.epoch) return;
      if (messageId !== null) {
        state.messageId = messageId;
        state.anchoredAt = Date.now();
        state.lastEditAt = Date.now();
        state.lastRendered = text;
        state.silentNext = false;
        retireReplaced(state);
      }
    } else {
      const ok = await editCard(state, state.messageId, card);
      if (epoch !== state.epoch) return;
      state.lastEditAt = Date.now();
      if (ok) state.lastRendered = text;
    }
  } finally {
    state.inFlight = false;
    const seal = state.sealPending;
    const bringDown = state.bringDownPending;
    state.sealPending = false;
    state.bringDownPending = null;
    if (seal) sealCard(state.sessionKey);
    if (bringDown && epoch === state.epoch) {
      bringCardDown(state.sessionKey, bringDown);
    } else if (!seal && state.dirty && epoch === state.epoch) {
      scheduleFlush(state);
    }
  }
}

/**
 * Delete what the card just posted replaces: a card it moved down from, and
 * the last sealed card if all that one held was the running list, which the
 * new card shows as well.
 */
function retireReplaced(state: CardState): void {
  const ids = [...state.retired];
  if (state.sealedId !== null && state.sealedEvents.length === 0) ids.push(state.sealedId);
  state.retired = [];
  state.sealedId = null;
  state.sealedEvents = [];
  const bot = botRef;
  if (!bot) return;
  for (const id of ids) {
    // Past 48h Telegram refuses, and the user may have deleted it already;
    // either way it stays as it is, sealed.
    Promise.resolve()
      .then(() => bot.api.deleteMessage(state.chatId, id))
      .catch((err: unknown) => console.debug('[BackgroundCard] delete failed:', describe(err)));
  }
}

/**
 * Post the card. A card whose formatting Telegram refuses goes out again as
 * plain text (see ./send.ts).
 */
async function sendCard(state: CardState, card: EntityMessage, silent: boolean): Promise<number | null> {
  if (!botRef) return null;
  const opts = {
    ...(state.threadId !== undefined ? { message_thread_id: state.threadId } : {}),
    ...(silent ? { disable_notification: true } : {}),
  };
  try {
    const msg = await sendFormatted(botRef.api, state.chatId, card, opts);
    return msg.message_id;
  } catch (err) {
    if (noteRateLimit(state, err)) return null;
    console.error('[BackgroundCard] send failed:', describe(err));
    return null;
  }
}

async function editCard(state: CardState, messageId: number, card: EntityMessage): Promise<boolean> {
  if (!botRef) return false;
  try {
    await editFormatted(botRef.api, state.chatId, messageId, card);
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
    console.error('[BackgroundCard] edit failed:', describe(err));
    return false;
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

/**
 * The card's bottom line, saying whether anything is still running. The card
 * grows downward and the running list sits at its top, so on a long card the
 * bottom is the only part on screen, and without this line a finished card
 * looked the same as a busy one.
 */
function statusLine(running: number, sealed: boolean, empty: boolean): string {
  if (running === 0) return empty ? '✅ Nothing running' : '✅ All done';
  const tasks = `${running} task${running === 1 ? '' : 's'}`;
  return sealed ? `⏳ ${tasks} still running · updates continue below` : `⏳ ${tasks} running`;
}

function renderCard(state: CardState, sealed = false): EntityMessage {
  for (let limit = state.events.length; limit >= 0; limit--) {
    const card = renderCardAt(state, limit, sealed);
    if (card.text.length <= MAX_CARD_CHARS) return card;
  }
  return sliceMessage(renderCardAt(state, 0, sealed), 0, MAX_CARD_CHARS);
}

function renderCardAt(state: CardState, eventLimit: number, sealed: boolean): EntityMessage {
  const b = new EntityText().add('📡 ').bold('Background activity');

  const running = [...state.running.values()].sort((a, b) => a.startedAt - b.startedAt);
  if (running.length > 0) {
    b.newline();
    const now = Date.now();
    for (const task of running) {
      const label = `${kindLabel(task.kind)}: ${truncate(task.description, MAX_TITLE_CHARS)}`;
      b.newline().add(`${kindIcon(task.kind)} ${label} · `).italic(`running ${formatDuration(now - task.startedAt)}`);
    }
  }

  const shown = eventLimit > 0 ? state.events.slice(-eventLimit) : [];
  const dropped = state.events.length - shown.length;
  if (dropped > 0) {
    b.newline(2).italic(`… ${dropped} earlier event${dropped === 1 ? '' : 's'}`);
  }

  for (const event of shown) {
    b.newline(2).add(`${event.icon} `).italic(clockTime(event.at)).add(` ${truncate(event.title, MAX_TITLE_CHARS)}`);
    if (event.detail) {
      b.newline().pre(truncate(event.detail, MAX_DETAIL_CHARS));
    }
  }

  const empty = running.length === 0 && shown.length === 0 && dropped === 0;
  b.newline(2).italic(statusLine(running.length, sealed, empty));

  return b.build();
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
