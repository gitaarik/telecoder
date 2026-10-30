/**
 * The worker's half of /rebuildbot's "when idle" option: restart once there is
 * nothing left to finish, rather than cutting a turn off halfway.
 *
 * The launcher starts it ('drain'), and from then on this worker watches its
 * own work and tells the launcher what is holding it up ('drain_busy') until
 * there is nothing, at which point it says so ('drain_idle') and the launcher
 * restarts it the way it restarts any worker. The bot that ran the command
 * shows the launcher's tally in one message, edited as instances go
 * ('drain_render') — whichever incarnation of that bot is live by then, since
 * it may well have restarted first.
 *
 * "Nothing left" is four things, because no one of them sees everything:
 *  - updates still in the middleware chain: a voice note being transcribed,
 *    a message in the batcher, a turn that answers it — every handler awaits
 *    its turn, so the count only drops once the reply has gone out;
 *  - the request queue, for turns no update started (/schedule fires);
 *  - a turn claude started itself on a background task's result, which
 *    nothing in either of those knows about;
 *  - background tasks still running, whose results would start one of those.
 */

import { isMainThread, parentPort } from 'worker_threads';
import type { Api, MiddlewareFn } from 'grammy';
import { busySessionCount } from './claude/request-queue.js';
import { hasSelfStartedTurn, whenRepliesSent } from './claude/monitor-relay.js';
import { taskTracker } from './telegram/task-tracker.js';

/** How often a draining worker looks again. */
const CHECK_MS = 2000;

let updatesInFlight = 0;

/**
 * Counts updates from the moment they arrive until their handler returns.
 * Registered first, so an update waiting on the batcher or behind another in
 * sequentialize counts as much as one being answered.
 */
export const countUpdatesInFlight: MiddlewareFn = async (_ctx, next) => {
  updatesInFlight++;
  try {
    await next();
  } finally {
    updatesInFlight--;
  }
};

export interface WorkSnapshot {
  updates: number;
  turns: number;
  selfStartedTurn: boolean;
  backgroundTasks: number;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** What is keeping the worker busy, in a few words — or null when nothing is. */
export function describeWork(work: WorkSnapshot): string | null {
  const parts: string[] = [];
  if (work.turns > 0) parts.push(plural(work.turns, 'turn running', 'turns running'));
  // Every turn an update started is an update too, so these only say
  // something when no turn accounts for them.
  else if (work.updates > 0) parts.push(plural(work.updates, 'message being handled', 'messages being handled'));
  if (work.selfStartedTurn) parts.push('answering a background task');
  if (work.backgroundTasks > 0) parts.push(plural(work.backgroundTasks, 'background task', 'background tasks'));
  return parts.length > 0 ? parts.join(', ') : null;
}

function currentWork(): WorkSnapshot {
  return {
    updates: updatesInFlight,
    turns: busySessionCount(),
    selfStartedTurn: hasSelfStartedTurn(),
    backgroundTasks: taskTracker.getBackgroundedTotal(),
  };
}

interface LauncherMessage {
  type?: string;
  chatId?: number;
  messageId?: number;
  text?: string;
  buttons?: boolean;
}

/** The status message's buttons: route back through handleRebuildCallback. */
export const IDLE_RESTART_BUTTONS = [
  [
    { text: '⚡ Restart the rest now', callback_data: 'rebuild:idle_force' },
    { text: '✖️ Cancel', callback_data: 'rebuild:idle_cancel' },
  ],
];

/**
 * Listen for the launcher's drain messages and say we can take them. Called
 * once the bot is up; a no-op outside multi-instance mode.
 *
 * The 'ready' is what the launcher waits for before sending anything: a
 * worker still starting up has no listener yet, and a 'drain' sent into that
 * gap would leave the launcher waiting on an instance that never heard it.
 */
export function initRestartWhenIdle(api: Api): void {
  if (isMainThread || !parentPort) return;
  const pp = parentPort;

  let timer: NodeJS.Timeout | null = null;
  let lastReported: string | null = null;
  let checking = false;

  const stop = (): void => {
    if (timer) clearInterval(timer);
    timer = null;
    lastReported = null;
  };

  const check = async (): Promise<void> => {
    if (!timer || checking) return;
    const busy = describeWork(currentWork());
    if (busy) {
      if (busy !== lastReported) pp.postMessage({ type: 'drain_busy', detail: busy });
      lastReported = busy;
      return;
    }
    // A reply the relay has handed on may still be on its way to Telegram.
    // Let it land, then make sure nothing new started while it did.
    checking = true;
    try {
      await whenRepliesSent();
    } finally {
      checking = false;
    }
    if (!timer || describeWork(currentWork())) return;
    stop();
    console.log('[IdleRestart] Nothing left to finish — asking to be restarted');
    pp.postMessage({ type: 'drain_idle' });
  };

  pp.on('message', (msg: LauncherMessage) => {
    if (msg?.type === 'drain') {
      if (timer) return;
      console.log('[IdleRestart] Restart pending — waiting until nothing is left to finish');
      // Not checked straight away: the bot that ran the command is still in
      // that command's handler, and so are the others for a moment if this
      // arrived alongside a message.
      timer = setInterval(() => { void check(); }, CHECK_MS);
      timer.unref();
    } else if (msg?.type === 'drain_cancel') {
      if (timer) console.log('[IdleRestart] Pending restart cancelled');
      stop();
    } else if (msg?.type === 'drain_render') {
      if (msg.chatId === undefined || msg.messageId === undefined || !msg.text) return;
      api.editMessageText(msg.chatId, msg.messageId, msg.text, {
        reply_markup: { inline_keyboard: msg.buttons ? IDLE_RESTART_BUTTONS : [] },
      }).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('message is not modified')) return;
        console.warn('[IdleRestart] Could not update the status message:', message);
      });
    }
  });

  pp.postMessage({ type: 'ready' });
}
