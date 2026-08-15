/**
 * Telling a frozen host apart from a broken bot.
 *
 * Every watchdog in the bot — the launcher's heartbeat monitor, its
 * wedged-worker escalation, the worker's own Telegram liveness check — reads
 * the same symptom when the machine runs out of memory: something that should
 * have happened on time didn't. Acting on that reads a starved process as a
 * dead one and restarts it, which costs a live Claude session and adds respawn
 * load to a machine already thrashing.
 *
 * These are the decisions those watchdogs share. They live here, away from the
 * launcher's worker-thread spawning and the bot's module-level config load, so
 * they can be tested directly.
 */

export interface TickInput {
  /** Gap between the last two firings of a fixed-interval timer. */
  sinceLastTickMs: number;
  /** The interval that timer was scheduled at. */
  intervalMs: number;
  /** Lateness that's ordinary scheduling jitter rather than a freeze. */
  slackMs: number;
}

/**
 * Did our own timer fire so late that the thread plainly wasn't running?
 *
 * This is the one first-hand piece of evidence a watchdog has about the host:
 * a timer is late because nothing got scheduled, and whatever the round would
 * have measured was not being measured either.
 */
export function tickWasStalled({ sinceLastTickMs, intervalMs, slackMs }: TickInput): boolean {
  return sinceLastTickMs > intervalMs + slackMs;
}

export interface CooldownInput {
  /** How long ago a stall was last observed; Infinity if never. */
  stalledAgoMs: number;
  /** How long after a stall the fleet is given to check back in. */
  cooldownMs: number;
}

/**
 * Should a watchdog keep its hands off because the host froze recently?
 *
 * `tickWasStalled` only covers the tick that fired late. A freeze that starves
 * the workers without delaying the watchdog's own loop — or one that lifts
 * just before its next tick — leaves them looking silent through no fault of
 * their own, so the suspicion has to outlive the stall that raised it.
 */
export function withinStallCooldown({ stalledAgoMs, cooldownMs }: CooldownInput): boolean {
  return stalledAgoMs < cooldownMs;
}

export interface WedgeInput extends CooldownInput {
  /** How long past its original deadline the escalation has been deferred. */
  deferredForMs: number;
  /** The point at which deferring costs more than escalating. */
  maxDeferMs: number;
}

/**
 * Is a worker that won't exit genuinely wedged, or just starved?
 *
 * They look identical from outside: both ignore terminate(), neither reaches
 * the exit handler. Only the wedged one is worth the cure — killing the
 * launcher so every instance restarts — so defer while the host is still
 * freezing. The deferral is bounded: a machine that stalls every few minutes
 * for hours would otherwise defer forever, leaving the instance offline for
 * good, which is the outcome the escalation exists to prevent.
 */
export function shouldEscalateWedged({
  stalledAgoMs,
  cooldownMs,
  deferredForMs,
  maxDeferMs,
}: WedgeInput): boolean {
  if (deferredForMs >= maxDeferMs) return true;
  return !withinStallCooldown({ stalledAgoMs, cooldownMs });
}
