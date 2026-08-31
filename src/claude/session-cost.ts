/**
 * What a conversation has cost, accumulated turn by turn.
 *
 * Claude Code cannot answer this. Its own cost counter belongs to the CLI
 * process that spent the money: ask `/cost` in a live process and you get its
 * running total, resume that same session in a fresh one and you get zero,
 * because the session log records token counts but no pricing. So the total
 * for a conversation that spans many turns — many processes, in SDK mode —
 * only exists if something keeps it, and this is that something.
 *
 * Only SDK-mode turns feed it. They end in a result message carrying
 * `total_cost_usd` for the process that just answered, which is exactly one
 * turn's spend. PTY mode never sees a cost figure at all: its numbers come
 * from tailing the session JSONL, which has none to give. The turn count
 * travels with the total so the figure stays interpretable — a resumed
 * session starts from zero here, and "$0.42 across 7 turns" says that plainly
 * where a bare "$0.42" would imply the whole history.
 */

import { BoundedMap } from '../utils/bounded-map.js';

export interface SessionCost {
  /** Dollars across every turn recorded for this session key. */
  usd: number;
  /** How many turns went into that total. */
  turns: number;
}

const sessionCosts = new BoundedMap<string, SessionCost>(1000);

/** Add one turn's cost to a session's running total, and return the total. */
export function recordTurnCost(sessionKey: string, turnCostUsd: number): SessionCost {
  const prior = sessionCosts.get(sessionKey);
  // A turn with no cost still counts as a turn — PTY-mode zeros never reach
  // here, so a zero from the SDK is a real turn that happened to be free.
  const next: SessionCost = {
    usd: (prior?.usd ?? 0) + (Number.isFinite(turnCostUsd) ? turnCostUsd : 0),
    turns: (prior?.turns ?? 0) + 1,
  };
  sessionCosts.set(sessionKey, next);
  return next;
}

/** The running total for a session, or zero when nothing has been recorded. */
export function getSessionCost(sessionKey: string): SessionCost {
  return sessionCosts.get(sessionKey) ?? { usd: 0, turns: 0 };
}

/** Forget a session's total — it starts again from zero on the next turn. */
export function clearSessionCost(sessionKey: string): void {
  sessionCosts.delete(sessionKey);
}
