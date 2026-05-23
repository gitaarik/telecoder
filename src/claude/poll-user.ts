/**
 * Pending-poll registry for claudegram_poll_user MCP tool.
 *
 * Mirrors ask-user.ts but uses Telegram polls instead of inline keyboards —
 * better for group decisions, vote counts, or multi-select. Telegram polls
 * MUST be non-anonymous for us to receive poll_answer events; anonymous
 * polls only emit aggregate "poll" updates with no per-user trigger.
 *
 * Resolves on the first poll_answer (multi-select captures the snapshot at
 * that moment). Users can change votes afterward but we've already returned.
 */

interface PendingPollEntry {
  resolve: (answer: PollAnswer | null) => void;
  timer: NodeJS.Timeout;
  optionLabels: string[];
  allowsMultiple: boolean;
  sessionKey?: string;
}

export interface PollAnswer {
  /** Labels of the option(s) the user selected. */
  labels: string[];
  /** Zero-based indices into the options array. */
  indices: number[];
}

const pending: Map<string, PendingPollEntry> = new Map();

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function clearPending(pollId: string): PendingPollEntry | undefined {
  const entry = pending.get(pollId);
  if (!entry) return undefined;
  pending.delete(pollId);
  clearTimeout(entry.timer);
  return entry;
}

/**
 * Register a pending poll keyed by Telegram's poll_id (returned from
 * bot.api.sendPoll). The poll_id is unique per poll instance and what
 * arrives back on poll_answer updates.
 */
export function createPendingPoll(
  pollId: string,
  optionLabels: string[],
  allowsMultiple: boolean,
  sessionKey?: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<PollAnswer | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const entry = clearPending(pollId);
      if (entry) entry.resolve(null);
    }, timeoutMs);
    pending.set(pollId, { resolve, timer, optionLabels, allowsMultiple, sessionKey });
  });
}

/**
 * Resolve a pending poll with the user's selected option indices.
 * Returns true if a pending entry existed for the poll_id.
 */
export function resolvePendingPoll(pollId: string, optionIndices: number[]): boolean {
  const entry = clearPending(pollId);
  if (!entry) return false;
  const labels = optionIndices
    .map((i) => entry.optionLabels[i])
    .filter((l): l is string => l !== undefined);
  entry.resolve({ labels, indices: optionIndices });
  return true;
}
