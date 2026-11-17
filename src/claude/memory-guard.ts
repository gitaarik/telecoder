/**
 * Not starting a claude the machine has no room for.
 *
 * Every chat keeps its own `claude`, a few hundred MB each, and nothing
 * about a typed message says whether it will reuse one or start one. On a box
 * that is already in swap, the one that starts is the one that takes the
 * machine down — bot, every other claude and all.
 *
 * So before a message starts a new claude, the kernel's MemAvailable is read.
 * Under MEMORY_GUARD_MIN_AVAILABLE_MB the idle claudes are reaped first, with
 * a window far shorter than the hourly reaper's; a chat so reaped loses a few
 * seconds of resume on its next message and nothing else. Only when that
 * doesn't free enough is the chat asked — start anyway, end the longest-idle
 * claude first, check again, wait for room, or drop the message — because a
 * plain yes/no on every prompt is tapped "yes" every time and so protects
 * nothing. Waiting polls the machine and starts the moment it fits; what it
 * is really waiting for is the other claudes to cross the reap window.
 *
 * A message to a chat whose claude is already running never asks: it starts
 * nothing new.
 *
 * A claude that was let through a moment ago hasn't taken its memory yet: it
 * allocates over its first seconds, and MemAvailable doesn't move until it
 * does. Two threads started together would both read the same number and both
 * pass, which is how a box with room for one more ended up with two. So every
 * spawn the guard lets through is counted as a few hundred MB already spent
 * until it has had time to show up in the kernel's figure.
 */

import type { Api, Context } from 'grammy';
import type { Message } from 'grammy/types';
import { config } from '../config.js';
import { readMemory, type MemoryReading } from '../utils/memory-pressure.js';
import { getPtyProvider } from '../providers/claude-provider.js';
import { endIdlePtySessions, sessionHasWork } from './pty-idle-reaper.js';
import { closeExpiredQuestion, createPendingQuestion, questionTimeoutMs, withdrawPendingQuestion } from './ask-user.js';
import { getAdminIds } from '../utils/admins.js';
import { parseSessionKey } from '../utils/session-key.js';
import { EntityText } from '../telegram/entities.js';

export interface SpawnGuardOutcome {
  /** True when the message may go on to start a claude. */
  proceed: boolean;
  /** What to tell the chat when it may not. Empty when it may. */
  message: string;
}

const PROCEED: SpawnGuardOutcome = { proceed: true, message: '' };

/** What a fresh claude takes within its first seconds, before any work: measured 160–470 MB, with its MCP servers. */
export const SPAWN_RESERVE_MB = 350;
/** How long a let-through spawn is counted before MemAvailable is trusted to include it. */
const SPAWN_RESERVE_MS = 30_000;
/** The spawns let through recently, by session key, with when each stops counting. */
const startingClaudes = new Map<string, number>();

/** The floor 'auto' resolves to: a quarter of RAM, at least 1 GB. Exported for tests. */
export function resolveMinAvailableMB(totalMB: number): number {
  const setting = config.MEMORY_GUARD_MIN_AVAILABLE_MB;
  if (setting !== 'auto') return setting;
  return Math.max(1024, Math.round(totalMB / 4));
}

/** How many claudes the guard let through in the last half minute, other than `exceptKey`'s. */
function countStarting(exceptKey?: string): number {
  const now = Date.now();
  let n = 0;
  for (const [key, until] of startingClaudes) {
    if (until <= now) startingClaudes.delete(key);
    else if (key !== exceptKey) n++;
  }
  return n;
}

function noteSpawn(sessionKey: string): SpawnGuardOutcome {
  startingClaudes.set(sessionKey, Date.now() + SPAWN_RESERVE_MS);
  return PROCEED;
}

/** Forget the spawns being counted. For tests. */
export function clearStartingClaudes(): void {
  startingClaudes.clear();
}

const START = '▶️ Start anyway';
const END_IDLE = '♻️ End the longest-idle claude first';
const CHECK = '🔄 Check again';
const WAIT = '⏳ Wait for room';
const DROP = '✗ Drop this message';

/** How often a chat that chose to wait has the machine checked again. Exported for tests. */
export const WAIT_POLL_MS = 30_000;

export function isMemoryGuardEnabled(): boolean {
  return config.MEMORY_GUARD_MIN_AVAILABLE_MB !== 0;
}

function swapOverLimit(mem: MemoryReading): boolean {
  const limit = config.MEMORY_GUARD_MAX_SWAP_USED_MB;
  return limit > 0 && mem.swapUsedMB > limit;
}

/** Tight when what's left, after the claudes still starting take theirs, is under the floor — or swap is past its limit. */
function isTight(mem: MemoryReading | null, starting: number): mem is MemoryReading {
  if (mem === null) return false;
  return mem.availableMB - starting * SPAWN_RESERVE_MB < resolveMinAvailableMB(mem.totalMB) || swapOverLimit(mem);
}

const fmtMB = (mb: number) => `${mb.toLocaleString('en-US')} MB`;

export function formatIdle(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

/**
 * Check the machine before `sessionKey`'s next turn, and ask the chat when it
 * can't be made to fit. Returns at once for a chat with a claude already
 * running, or a guard turned off.
 */
export async function guardSpawn(ctx: Context | undefined, sessionKey: string): Promise<SpawnGuardOutcome> {
  if (!isMemoryGuardEnabled()) return PROCEED;
  const pty = getPtyProvider();
  if (pty.hasLiveSession(sessionKey)) return PROCEED;
  const starting = countStarting(sessionKey); // also drops the expired entries
  // Let through a moment ago and not yet live: that is this chat's own spawn.
  if (startingClaudes.has(sessionKey)) return PROCEED;
  const mem = readMemory();
  if (!isTight(mem, starting)) return noteSpawn(sessionKey);

  const room = await roomAfterReap(sessionKey, mem);
  if (room.fits) return noteSpawn(sessionKey);

  if (!ctx?.api) return noteSpawn(sessionKey); // nobody to ask; a scheduled run goes ahead
  return askChat(ctx, sessionKey, room.mem, room.starting);
}

type Room = { fits: true } | { fits: false; mem: MemoryReading; starting: number };

/**
 * Make room the cheap way and read the machine again. Idle claudes go first:
 * the chat they belonged to resumes from its transcript next time, which is
 * all the hourly reaper does anyway. Run before the chat is asked, on every
 * "Check again", and on every tick of a wait — so a claude that was busy when
 * the question went up is ended as soon as it has sat idle long enough.
 */
async function roomAfterReap(sessionKey: string, before: MemoryReading): Promise<Room> {
  const reaped = endIdlePtySessions(config.MEMORY_GUARD_REAP_IDLE_MS);
  if (reaped.length > 0) {
    console.log(`[MemoryGuard] ${fmtMB(before.availableMB)} available; ended ${reaped.length} idle claude(s) before starting ${sessionKey}: ${reaped.join(', ')}`);
    // Freed pages take a moment to show in MemAvailable; give it a tick.
    await new Promise((r) => setTimeout(r, 300));
  }
  const starting = countStarting(sessionKey);
  const mem = readMemory();
  return isTight(mem, starting) ? { fits: false, mem, starting } : { fits: true };
}

/**
 * Whether a claude may be started for `sessionKey` before anyone has sent it
 * anything (see prewarm.ts). An early start is a convenience, so it gets the
 * same floor and none of the remedies: nothing is reaped for it and nobody is
 * asked. Under the floor it just doesn't happen, and the first message goes
 * through {@link guardSpawn} as it would have. One that is allowed is counted
 * like any other spawn.
 */
export function allowPrewarm(sessionKey: string): boolean {
  if (!isMemoryGuardEnabled()) return true;
  const starting = countStarting(sessionKey);
  if (isTight(readMemory(), starting)) return false;
  noteSpawn(sessionKey);
  return true;
}

interface OtherClaudes {
  busy: number;
  /** Idle claudes that could be ended, longest idle first. */
  idle: { sessionKey: string; idleMs: number }[];
}

function surveyOthers(): OtherClaudes {
  const idle: OtherClaudes['idle'] = [];
  let busy = 0;
  for (const s of getPtyProvider().describeSessions()) {
    if (s.generating || sessionHasWork(s.sessionKey, s.pid)) busy++;
    else idle.push({ sessionKey: s.sessionKey, idleMs: s.idleMs });
  }
  idle.sort((a, b) => b.idleMs - a.idleMs);
  return { busy, idle };
}

type QuestionApi = Pick<Api, 'sendMessage' | 'editMessageText' | 'editMessageReplyMarkup'>;
type Shown = ReturnType<EntityText['build']>;
type Keyboard = { text: string; callback_data: string }[][];

/**
 * Put the question to the chat and act on the answer. One Telegram message
 * carries the whole exchange: "Check again" and a wait that runs out re-post
 * the question over it with fresh numbers, so a chat that asks three times
 * doesn't get three questions. The question is registered with `ownerCloses`,
 * so a tap only resolves it and the message stays this function's to edit.
 */
async function askChat(ctx: Context, sessionKey: string, mem: MemoryReading, starting: number): Promise<SpawnGuardOutcome> {
  const { chatId, threadId } = parseSessionKey(sessionKey);
  const api: QuestionApi = ctx.api;
  const timeoutMs = questionTimeoutMs();
  const timeoutMin = Math.round(timeoutMs / 60000);
  // The sender and the admins; in a group, a bystander's tap shouldn't start it.
  const responders = [...new Set([ctx.from?.id, ...getAdminIds()].filter((id): id is number => typeof id === 'number'))];
  const swapLimitMB = config.MEMORY_GUARD_MAX_SWAP_USED_MB;

  let sent: Message.TextMessage | undefined;
  let waitedOut = false; // the last wait ran out; the re-ask says so

  for (;;) {
    const others = surveyOthers();
    const labels = others.idle.length > 0 ? [START, END_IDLE, CHECK, WAIT, DROP] : [START, CHECK, WAIT, DROP];
    const { id, promise } = createPendingQuestion(labels, timeoutMs, sessionKey, responders, { ownerCloses: true });
    let shown = buildMemoryGuardMessage({ mem, others, starting, timeoutMin, swapLimitMB, ...(waitedOut ? { waitedMin: timeoutMin } : {}) });
    const keyboard = keyboardFor(labels, id);

    if (!sent) {
      try {
        sent = await api.sendMessage(chatId, shown.text, {
          entities: shown.entities,
          reply_markup: { inline_keyboard: keyboard },
          ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
        });
      } catch (err) {
        withdrawPendingQuestion(id);
        console.error('[MemoryGuard] failed to post the question:', err instanceof Error ? err.message : err);
        return noteSpawn(sessionKey); // better one claude too many than a message silently lost
      }
      console.log(`[MemoryGuard] ${fmtMB(mem.availableMB)} available, asking ${sessionKey} before starting a claude`);
    } else {
      await showQuestion(api, sent, shown, keyboard);
    }

    const answer = await promise;
    if (answer === null) {
      await closeExpiredQuestion(api, sent, shown.text, `No answer within ${timeoutMin} min, so the message was dropped.`, shown.entities);
      return { proceed: false, message: `🧠 Memory was tight and nobody answered in ${timeoutMin} min, so that message was dropped. Send it again to start Claude anyway.` };
    }
    let chosen = labels[answer.index];

    if (chosen === CHECK) {
      const room = await roomAfterReap(sessionKey, mem);
      if (room.fits) {
        await closeQuestion(api, sent, shown, '✅ Checked again: it fits now, so Claude is starting.');
        return noteSpawn(sessionKey);
      }
      ({ mem, starting } = room);
      waitedOut = false;
      continue;
    }

    if (chosen === WAIT) {
      console.log(`[MemoryGuard] ${sessionKey} waits for room`);
      const waited = await waitForRoom(api, sent, sessionKey, responders, timeoutMs, mem, starting, others.idle.length > 0);
      shown = waited.shown;
      if (waited.kind === 'fits') {
        console.log(`[MemoryGuard] room came free after ${formatIdle(waited.waitedMs)}; starting ${sessionKey}`);
        await closeQuestion(api, sent, shown, `✅ Room came free after ${formatIdle(waited.waitedMs)}, so Claude is starting.`);
        return noteSpawn(sessionKey);
      }
      if (waited.kind === 'timeout') {
        ({ mem, starting } = waited);
        waitedOut = true;
        continue; // ask again rather than drop: the chat said it wanted this message
      }
      chosen = waited.label;
    }

    if (chosen === START) {
      await closeQuestion(api, sent, shown, `✅ Answered: ${START}`);
      return noteSpawn(sessionKey);
    }
    if (chosen === END_IDLE) {
      await closeQuestion(api, sent, shown, `✅ Answered: ${END_IDLE}`);
      const ended = getPtyProvider().endLongestIdleSession(sessionHasWork);
      if (ended) {
        console.log(`[MemoryGuard] ended ${ended} on request before starting ${sessionKey}`);
        return noteSpawn(sessionKey);
      }
      // Everything went busy while the question was open; the tap still meant "go".
      console.log(`[MemoryGuard] nothing idle left to end; starting ${sessionKey} anyway`);
      return noteSpawn(sessionKey);
    }
    await closeQuestion(api, sent, shown, `✅ Answered: ${DROP}`);
    return { proceed: false, message: '🧠 Dropped. Send it again when you want Claude started anyway.' };
  }
}

type WaitOutcome =
  | { kind: 'fits'; waitedMs: number }
  | { kind: 'timeout'; mem: MemoryReading; starting: number }
  | { kind: 'answer'; label: string };

/**
 * Check the machine every {@link WAIT_POLL_MS} until the claude fits, the
 * question's timeout runs out, or the chat taps one of the buttons that stay
 * up meanwhile (start anyway, end the longest-idle one, drop). Each tick reaps
 * and re-reads like the first check did, and the message shows the latest
 * figure. A tap and a tick that both land are settled by whichever came
 * first; the question is withdrawn either way.
 */
async function waitForRoom(
  api: QuestionApi,
  sent: Message.TextMessage,
  sessionKey: string,
  responders: number[],
  timeoutMs: number,
  mem: MemoryReading,
  starting: number,
  hasIdle: boolean,
): Promise<WaitOutcome & { shown: Shown }> {
  const labels = hasIdle ? [START, END_IDLE, DROP] : [START, DROP];
  const { id, promise } = createPendingQuestion(labels, timeoutMs, sessionKey, responders, { ownerCloses: true });
  const keyboard = keyboardFor(labels, id);
  const timeoutMin = Math.round(timeoutMs / 60000);
  const startedAt = Date.now();
  const render = () => buildWaitingMessage({ mem, starting, waitedMs: Date.now() - startedAt, timeoutMin });
  let shown = render();
  await showQuestion(api, sent, shown, keyboard);

  let settled = false;
  let timer: NodeJS.Timeout | undefined;
  const poll = new Promise<WaitOutcome>((resolve) => {
    const tick = async () => {
      const room = await roomAfterReap(sessionKey, mem);
      if (settled) return;
      if (room.fits) {
        resolve({ kind: 'fits', waitedMs: Date.now() - startedAt });
        return;
      }
      ({ mem, starting } = room);
      shown = render();
      await showQuestion(api, sent, shown, keyboard);
      if (!settled) timer = setTimeout(tick, WAIT_POLL_MS);
    };
    timer = setTimeout(tick, WAIT_POLL_MS);
  });
  const tapped = promise.then((a): WaitOutcome => (a === null ? { kind: 'timeout', mem, starting } : { kind: 'answer', label: labels[a.index]! }));

  const outcome = await Promise.race([poll, tapped]);
  settled = true;
  if (timer) clearTimeout(timer);
  withdrawPendingQuestion(id); // a no-op when a tap already resolved it
  return { ...outcome, shown };
}

function keyboardFor(labels: string[], id: string): Keyboard {
  return labels.map((label, idx) => [{ text: label, callback_data: `q:${id}:${idx}` }]);
}

/** Re-post the question over its own message. Best-effort: the question is live either way, and the old text still answers. */
async function showQuestion(api: QuestionApi, sent: Message.TextMessage, shown: Shown, keyboard: Keyboard): Promise<void> {
  try {
    await api.editMessageText(sent.chat.id, sent.message_id, shown.text, {
      entities: shown.entities,
      reply_markup: { inline_keyboard: keyboard },
    });
  } catch (err) {
    console.warn('[MemoryGuard] could not update the question:', err instanceof Error ? err.message : err);
  }
}

/** Close the exchange: the footer says how it ended, and the keyboard comes down. Same fallbacks as ask-user's closeExpiredQuestion. */
async function closeQuestion(api: QuestionApi, sent: Message.TextMessage, shown: Shown, footer: string): Promise<void> {
  try {
    await api.editMessageText(sent.chat.id, sent.message_id, `${shown.text}\n\n${footer}`, { entities: shown.entities });
    return;
  } catch {
    // Losing the footer is cosmetic; a live keyboard on a closed question is not.
  }
  try {
    await api.editMessageReplyMarkup(sent.chat.id, sent.message_id);
  } catch (err) {
    console.warn('[MemoryGuard] could not close the question:', err instanceof Error ? err.message : err);
  }
}

interface WaitParts {
  mem: MemoryReading;
  starting: number;
  waitedMs: number;
  timeoutMin: number;
}

/** What the message says while the chat waits for room. Exported for tests. */
export function buildWaitingMessage(parts: WaitParts): Shown {
  const { mem, starting } = parts;
  const need = resolveMinAvailableMB(mem.totalMB) + starting * SPAWN_RESERVE_MB;
  const b = new EntityText();
  b.add('🧠 ').bold('Waiting for room').newline();
  b.add(`${fmtMB(mem.availableMB)} available of ${fmtMB(mem.totalMB)}; this chat's Claude starts at ${fmtMB(need)}.`);
  if (parts.waitedMs >= 60_000) b.add(` Waited ${formatIdle(parts.waitedMs)} so far.`);
  b.newline().newline();
  b.add(`Checked every ${Math.round(WAIT_POLL_MS / 1000)} s; claudes that go idle meanwhile are ended as they pass ${formatIdle(config.MEMORY_GUARD_REAP_IDLE_MS)}. `);
  b.add('The buttons still work while it waits.');
  b.newline().newline();
  b.italic(`Gives up in ${parts.timeoutMin} min → asks again.`);
  return b.build();
}

interface GuardParts {
  mem: MemoryReading;
  others: OtherClaudes;
  /** Claudes let through in the last half minute that MemAvailable doesn't show yet. */
  starting?: number;
  timeoutMin: number;
  /** MEMORY_GUARD_MAX_SWAP_USED_MB; 0 when swap isn't a trigger. */
  swapLimitMB?: number;
  /** Set when a wait for room just ran out: this is the re-ask. */
  waitedMin?: number;
}

/** Lay out the question. Exported for tests — the wording is the product. */
export function buildMemoryGuardMessage(parts: GuardParts): ReturnType<EntityText['build']> {
  const { mem, others } = parts;
  const b = new EntityText();
  b.add('🧠 ').bold('Memory is tight').newline();
  b.add(`${fmtMB(mem.availableMB)} available of ${fmtMB(mem.totalMB)}`);
  if (mem.swapTotalMB > 0) b.add(`, swap ${fmtMB(mem.swapUsedMB)} in use`);
  b.add('.');
  const swapLimit = parts.swapLimitMB ?? 0;
  if (swapLimit > 0 && mem.swapUsedMB > swapLimit) b.add(` Swap is past the ${fmtMB(swapLimit)} limit.`);
  const starting = parts.starting ?? 0;
  if (starting > 0) {
    b.add(starting === 1
      ? ` 1 more Claude was started just now and isn't in that figure yet.`
      : ` ${starting} more Claudes were started just now and aren't in that figure yet.`);
  }
  if (parts.waitedMin) b.add(` Waited ${parts.waitedMin} min for room and it didn't come.`);
  b.newline().newline();
  b.add('This message starts a new Claude for this chat, which takes a few hundred MB more. ');

  const total = others.busy + others.idle.length;
  if (total === 0) {
    b.add('No other Claude is running here; something else has the memory.');
  } else {
    const parts: string[] = [];
    if (others.busy > 0) parts.push(`${others.busy} busy`);
    if (others.idle.length > 0) {
      const longest = others.idle[0]!;
      parts.push(others.idle.length === 1
        ? `1 idle for ${formatIdle(longest.idleMs)}`
        : `${others.idle.length} idle, the longest for ${formatIdle(longest.idleMs)}`);
    }
    b.add(`${total} other Claude${total === 1 ? ' is' : 's are'} running: ${parts.join(', ')}.`);
  }
  b.newline().newline();
  b.italic(`Ending an idle one costs its chat a few seconds of resume next time. Waiting checks every ${Math.round(WAIT_POLL_MS / 1000)} s and starts Claude when it fits. Times out in ${parts.timeoutMin} min → dropped.`);
  return b.build();
}
