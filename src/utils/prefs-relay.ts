/**
 * Bookkeeping for a preference change one bot asked to apply to all of them.
 *
 * The launcher is the only path between workers, so it has to hold each
 * broadcast open until every sibling has answered, then hand the requester a
 * summary of what they each did. Getting that wrong is invisible in the good
 * case and misleading in the bad one — a bot reported as "applied" that never
 * got the message, or a requester left waiting on a worker that died mid-relay.
 *
 * Kept out of launcher.ts, alongside the backoff and host-stall policies, for
 * the same reason those are: the launcher spawns worker threads at import time
 * and can't be loaded in a test, and this is the part with the edge cases.
 */

export interface PrefsOutcome {
  name: string;
  status: 'applied' | 'skipped';
  reason?: string;
  busy?: number;
}

export interface PrefsRelaySummary {
  applied: PrefsOutcome[];
  skipped: PrefsOutcome[];
  /** Bots that never answered: not running, unreachable, or too slow. */
  unreachable: string[];
}

interface Pending {
  awaiting: Set<string>;
  outcomes: PrefsOutcome[];
  unreachable: string[];
  onSettle: (summary: PrefsRelaySummary) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export interface BeginInput {
  /** Bots the change was successfully handed to; we wait on each. */
  awaiting: string[];
  /** Bots already known not to have received it. */
  unreachable: string[];
  /** How long to hold the broadcast open before answering with what we have. */
  timeoutMs: number;
  onSettle: (summary: PrefsRelaySummary) => void;
  /** Called when the wait times out, with the bots still outstanding. */
  onTimeout?: (stillAwaiting: string[]) => void;
}

/**
 * Tracks broadcasts in flight and decides when each is done.
 *
 * A broadcast settles exactly once: on the last reply, on the timeout, or
 * immediately when there was nobody to wait for. Everything after that —
 * a late reply from a slow worker, a duplicate — is dropped, because the
 * requester has already been answered and been told that bot didn't respond.
 */
export class PrefsRelay {
  private pending = new Map<string, Pending>();

  /** Whether this id is still open. */
  has(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  /** Bots this broadcast is still waiting on. Empty for an unknown id. */
  awaiting(requestId: string): string[] {
    return [...(this.pending.get(requestId)?.awaiting ?? [])];
  }

  /**
   * Open a broadcast. Settles synchronously — before returning — when there
   * are no siblings to wait on, so a lone bot gets an answer straight away
   * rather than after the timeout.
   */
  begin(requestId: string, input: BeginInput): void {
    // A reused id would orphan the first requester; settling it first at least
    // answers them rather than leaving them on their own timeout.
    if (this.pending.has(requestId)) this.settle(requestId);

    const entry: Pending = {
      awaiting: new Set(input.awaiting),
      outcomes: [],
      unreachable: [...input.unreachable],
      onSettle: input.onSettle,
    };
    this.pending.set(requestId, entry);

    if (entry.awaiting.size === 0) {
      this.settle(requestId);
      return;
    }

    entry.timer = setTimeout(() => {
      input.onTimeout?.(this.awaiting(requestId));
      this.settle(requestId);
    }, input.timeoutMs);
    // The launcher must not be held alive by a broadcast nobody is waiting on.
    entry.timer.unref?.();
  }

  /**
   * Record one bot's answer, settling the broadcast if it was the last one
   * outstanding. Ignores answers for unknown ids and bots not being awaited —
   * a duplicate reply, or one that arrives after the timeout.
   */
  record(requestId: string, outcome: PrefsOutcome): void {
    const entry = this.pending.get(requestId);
    if (!entry || !entry.awaiting.delete(outcome.name)) return;

    entry.outcomes.push(outcome);
    if (entry.awaiting.size === 0) this.settle(requestId);
  }

  /**
   * Give up on a bot without an answer from it — it exited while the broadcast
   * was open. Settles if it was the last one outstanding.
   */
  abandon(requestId: string, name: string): void {
    const entry = this.pending.get(requestId);
    if (!entry || !entry.awaiting.delete(name)) return;

    entry.unreachable.push(name);
    if (entry.awaiting.size === 0) this.settle(requestId);
  }

  /** Same, for every broadcast currently waiting on `name`. */
  abandonEverywhere(name: string): void {
    for (const requestId of [...this.pending.keys()]) {
      this.abandon(requestId, name);
    }
  }

  /** Answer the requester now, with whatever has come back. */
  settle(requestId: string): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;

    if (entry.timer) clearTimeout(entry.timer);
    this.pending.delete(requestId);

    entry.onSettle({
      applied: entry.outcomes.filter((o) => o.status === 'applied'),
      skipped: entry.outcomes.filter((o) => o.status === 'skipped'),
      // Anything still awaited when we settle never answered.
      unreachable: [...entry.unreachable, ...entry.awaiting],
    });
  }
}
