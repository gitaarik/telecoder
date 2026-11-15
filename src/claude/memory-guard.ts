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
 */

import type { Context } from 'grammy';
import type { Message } from 'grammy/types';
import { config } from '../config.js';
import { readMemory, type MemoryReading } from '../utils/memory-pressure.js';
import { getActiveMethod, getPtyProvider } from '../providers/claude-provider.js';
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

const START = '▶️ Start anyway';
const END_IDLE = '♻️ End the longest-idle claude first';
const DROP = '✗ Drop this message';

export function isMemoryGuardEnabled(): boolean {
  return config.MEMORY_GUARD_MIN_AVAILABLE_MB > 0;
}

function isTight(mem: MemoryReading | null): mem is MemoryReading {
  return mem !== null && mem.availableMB < config.MEMORY_GUARD_MIN_AVAILABLE_MB;
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
 * running, a chat on the SDK, or a guard turned off.
 */
export async function guardSpawn(ctx: Context | undefined, sessionKey: string): Promise<SpawnGuardOutcome> {
  if (!isMemoryGuardEnabled()) return PROCEED;
  if (getActiveMethod(sessionKey) !== 'pty') return PROCEED;
  const pty = getPtyProvider();
  if (pty.hasLiveSession(sessionKey)) return PROCEED;

  let mem = readMemory();
  if (!isTight(mem)) return PROCEED;

  // Idle claudes go first: the chat they belonged to resumes from its
  // transcript next time, which is all the hourly reaper does anyway.
  const reaped = endIdlePtySessions(config.MEMORY_GUARD_REAP_IDLE_MS);
  if (reaped.length > 0) {
    console.log(`[MemoryGuard] ${fmtMB(mem.availableMB)} available; ended ${reaped.length} idle claude(s) before starting ${sessionKey}: ${reaped.join(', ')}`);
    // Freed pages take a moment to show in MemAvailable; give it a tick.
    await new Promise((r) => setTimeout(r, 300));
    mem = readMemory();
    if (!isTight(mem)) return PROCEED;
  }

  if (!ctx?.api) return PROCEED; // nobody to ask; a scheduled run goes ahead
  return askChat(ctx, sessionKey, mem);
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

async function askChat(ctx: Context, sessionKey: string, mem: MemoryReading): Promise<SpawnGuardOutcome> {
  const { chatId, threadId } = parseSessionKey(sessionKey);
  const others = surveyOthers();
  const timeoutMs = questionTimeoutMs();
  const timeoutMin = Math.round(timeoutMs / 60000);

  const labels = others.idle.length > 0 ? [START, END_IDLE, DROP] : [START, DROP];
  // The sender and the admins; in a group, a bystander's tap shouldn't start it.
  const responders = [...new Set([ctx.from?.id, ...getAdminIds()].filter((id): id is number => typeof id === 'number'))];
  const { id, promise } = createPendingQuestion(labels, timeoutMs, sessionKey, responders);

  const { text, entities } = buildMemoryGuardMessage({ mem, others, timeoutMin });
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
    return PROCEED; // better one claude too many than a message silently lost
  }
  console.log(`[MemoryGuard] ${fmtMB(mem.availableMB)} available, asking ${sessionKey} before starting a claude`);

  const answer = await promise;
  if (answer === null) {
    await closeExpiredQuestion(ctx.api, sent, text, `No answer within ${timeoutMin} min, so the message was dropped.`, entities);
    return { proceed: false, message: `🧠 Memory was tight and nobody answered in ${timeoutMin} min, so that message was dropped. Send it again to start Claude anyway.` };
  }
  const chosen = labels[answer.index];
  if (chosen === START) return PROCEED;
  if (chosen === END_IDLE) {
    const ended = getPtyProvider().endLongestIdleSession(sessionHasWork);
    if (ended) {
      console.log(`[MemoryGuard] ended ${ended} on request before starting ${sessionKey}`);
      return PROCEED;
    }
    // Everything went busy while the question was open; the tap still meant "go".
    console.log(`[MemoryGuard] nothing idle left to end; starting ${sessionKey} anyway`);
    return PROCEED;
  }
  return { proceed: false, message: '🧠 Dropped. Send it again when you want Claude started anyway.' };
}

interface GuardParts {
  mem: MemoryReading;
  others: OtherClaudes;
  timeoutMin: number;
}

/** Lay out the question. Exported for tests — the wording is the product. */
export function buildMemoryGuardMessage(parts: GuardParts): ReturnType<EntityText['build']> {
  const { mem, others } = parts;
  const b = new EntityText();
  b.add('🧠 ').bold('Memory is tight').newline();
  b.add(`${fmtMB(mem.availableMB)} available of ${fmtMB(mem.totalMB)}`);
  if (mem.swapTotalMB > 0) b.add(`, swap ${fmtMB(mem.swapUsedMB)} in use`);
  b.add('.').newline().newline();
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
