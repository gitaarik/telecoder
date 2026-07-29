/**
 * Tracks assistant prose already delivered to Telegram *during* a PTY turn.
 *
 * PTY mode has no streaming text channel. The turn's prose is scraped from
 * Claude Code's JSONL log at end-of-turn (readLastAssistantTurnText) and posted
 * as one message. That is fine right up until the model stops mid-turn to ask a
 * question: everything it wrote to explain the choice is still sitting
 * undelivered in the log, so the buttons arrive with no reasoning attached and
 * the explanation only lands after the user has already picked.
 *
 * The ask_user bridge fixes that by flushing the prose written so far as its
 * own message just above the question, and recording it here. At end-of-turn
 * the provider strips what was already sent so the user doesn't read it twice.
 *
 * In-memory and per-turn: cleared when a turn starts and when it finishes, so
 * a crash mid-turn can at worst cause one duplicated paragraph, never a
 * swallowed reply.
 */

/**
 * How readLastAssistantTurnText joins consecutive assistant text records. The
 * flushed text is always a prefix of the end-of-turn text under this same
 * join, which is what makes the strip below a plain prefix match.
 */
const RECORD_SEPARATOR = '\n\n';

const delivered: Map<string, string> = new Map();

/** Remember the full run of turn prose that has now been sent to the chat. */
export function recordDeliveredProse(sessionKey: string, text: string): void {
  if (!text) return;
  delivered.set(sessionKey, text);
}

/** What has been delivered so far this turn, if anything. */
export function getDeliveredProse(sessionKey: string): string | undefined {
  return delivered.get(sessionKey);
}

/** Drop the turn's record. Called at both ends of a PTY turn. */
export function clearDeliveredProse(sessionKey: string): void {
  delivered.delete(sessionKey);
}

/**
 * Return the part of `full` that hasn't been delivered yet.
 *
 * Deliberately conservative: if `full` doesn't actually start with what we
 * delivered — a screen-scrape fallback, a compaction rewriting the log, a
 * session swapped underneath us — nothing is stripped. Showing a paragraph
 * twice is a cosmetic annoyance; silently eating the model's answer is not.
 */
export function stripDeliveredPrefix(full: string, alreadyDelivered: string | undefined): string {
  if (!alreadyDelivered || !full) return full;
  if (full === alreadyDelivered) return '';
  if (!full.startsWith(alreadyDelivered)) return full;

  const rest = full.slice(alreadyDelivered.length);
  // Only a record boundary counts as a real continuation. What we delivered is
  // always a whole run of joined records, so anything else means the two
  // strings merely happen to share a prefix — cutting there would behead the
  // reply mid-sentence.
  if (!rest.startsWith(RECORD_SEPARATOR)) return full;
  return rest.slice(RECORD_SEPARATOR.length);
}
