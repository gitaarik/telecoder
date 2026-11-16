/**
 * Not starting a claude the machine has no room for.
 *
 * Every PTY chat keeps its own `claude`, a few hundred MB each, and nothing
 * about a typed message says whether it will reuse one or start one. On a box
 * that is already in swap, the one that starts is the one that takes the
 * machine down — bot, every other claude and all.
 *
 * So before a message starts a new claude, the kernel's MemAvailable is read.
 * Under MEMORY_GUARD_MIN_AVAILABLE_MB the idle claudes are reaped first, with
 * a window far shorter than the hourly reaper's; a chat so reaped loses a few
 * seconds of resume on its next message and nothing else. Only when that
 * doesn't free enough is the chat asked — start anyway, end the longest-idle
 * claude first, or drop the message — because a plain yes/no on every prompt
 * is tapped "yes" every time and so protects nothing.
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

import type { Context } from 'grammy';
import type { Message } from 'grammy/types';
import { config } from '../config.js';
import { readMemory, type MemoryReading } from '../utils/memory-pressure.js';
import { getPtyProvider } from '../providers/claude-provider.js';
import { endIdlePtySessions, sessionHasWork } from './pty-idle-reaper.js';
import { closeExpiredQuestion, createPendingQuestion, questionTimeoutMs } from './ask-user.js';
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
const DROP = '✗ Drop this message';

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
  let mem = readMemory();
  if (!isTight(mem, starting)) return noteSpawn(sessionKey);

  // Idle claudes go first: the chat they belonged to resumes from its
  // transcript next time, which is all the hourly reaper does anyway.
  const reaped = endIdlePtySessions(config.MEMORY_GUARD_REAP_IDLE_MS);
  if (reaped.length > 0) {
    console.log(`[MemoryGuard] ${fmtMB(mem.availableMB)} available; ended ${reaped.length} idle claude(s) before starting ${sessionKey}: ${reaped.join(', ')}`);
    // Freed pages take a moment to show in MemAvailable; give it a tick.
    await new Promise((r) => setTimeout(r, 300));
    mem = readMemory();
    if (!isTight(mem, starting)) return noteSpawn(sessionKey);
  }

  if (!ctx?.api) return noteSpawn(sessionKey); // nobody to ask; a scheduled run goes ahead
  return askChat(ctx, sessionKey, mem, starting);
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

async function askChat(ctx: Context, sessionKey: string, mem: MemoryReading, starting: number): Promise<SpawnGuardOutcome> {
  const { chatId, threadId } = parseSessionKey(sessionKey);
  const others = surveyOthers();
  const timeoutMs = questionTimeoutMs();
  const timeoutMin = Math.round(timeoutMs / 60000);

  const labels = others.idle.length > 0 ? [START, END_IDLE, DROP] : [START, DROP];
  // The sender and the admins; in a group, a bystander's tap shouldn't start it.
  const responders = [...new Set([ctx.from?.id, ...getAdminIds()].filter((id): id is number => typeof id === 'number'))];
  const { id, promise } = createPendingQuestion(labels, timeoutMs, sessionKey, responders);

  const { text, entities } = buildMemoryGuardMessage({ mem, others, starting, timeoutMin, swapLimitMB: config.MEMORY_GUARD_MAX_SWAP_USED_MB });
  const keyboard = labels.map((label, idx) => [{ text: label, callback_data: `q:${id}:${idx}` }]);

  let sent: Message.TextMessage;
  try {
    sent = await ctx.api.sendMessage(chatId, text, {
      entities,
      reply_markup: { inline_keyboard: keyboard },
      ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
    });
  } catch (err) {
    console.error('[MemoryGuard] failed to post the question:', err instanceof Error ? err.message : err);
    return noteSpawn(sessionKey); // better one claude too many than a message silently lost
  }
  console.log(`[MemoryGuard] ${fmtMB(mem.availableMB)} available, asking ${sessionKey} before starting a claude`);

  const answer = await promise;
  if (answer === null) {
    await closeExpiredQuestion(ctx.api, sent, text, `No answer within ${timeoutMin} min, so the message was dropped.`, entities);
    return { proceed: false, message: `🧠 Memory was tight and nobody answered in ${timeoutMin} min, so that message was dropped. Send it again to start Claude anyway.` };
  }
  const chosen = labels[answer.index];
  if (chosen === START) return noteSpawn(sessionKey);
  if (chosen === END_IDLE) {
    const ended = getPtyProvider().endLongestIdleSession(sessionHasWork);
    if (ended) {
      console.log(`[MemoryGuard] ended ${ended} on request before starting ${sessionKey}`);
      return noteSpawn(sessionKey);
    }
    // Everything went busy while the question was open; the tap still meant "go".
    console.log(`[MemoryGuard] nothing idle left to end; starting ${sessionKey} anyway`);
    return noteSpawn(sessionKey);
  }
  return { proceed: false, message: '🧠 Dropped. Send it again when you want Claude started anyway.' };
}

interface GuardParts {
  mem: MemoryReading;
  others: OtherClaudes;
  /** Claudes let through in the last half minute that MemAvailable doesn't show yet. */
  starting?: number;
  timeoutMin: number;
  /** MEMORY_GUARD_MAX_SWAP_USED_MB; 0 when swap isn't a trigger. */
  swapLimitMB?: number;
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
  b.italic(`Ending an idle one costs its chat a few seconds of resume next time. Times out in ${parts.timeoutMin} min → dropped.`);
  return b.build();
}
