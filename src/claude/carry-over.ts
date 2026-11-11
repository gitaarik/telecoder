/**
 * Plain-text context to put in front of a chat's next prompt, queued when a
 * conversation can't go on in its own session — a provider switch, or a
 * /resume of a session another backend wrote — and the next turn has to start
 * a fresh one. It carries no thinking blocks, so any backend can take it.
 *
 * Its own module so both the SDK agent and the PTY provider can take from it.
 */

import { BoundedMap } from '../utils/bounded-map.js';

const pendingCarryOver = new BoundedMap<string, string>(1000);

/** Queue a one-shot context preamble for the next turn of `sessionKey`. */
export function setPendingCarryOver(sessionKey: string, preamble: string): void {
  pendingCarryOver.set(sessionKey, preamble);
}

/**
 * `prompt` with the queued preamble, if any, in front of it, which clears the
 * queue. A slash command goes through as it is and leaves the preamble for the
 * prompt after it: text in front of `/model` would make it a plain prompt.
 */
export function withPendingCarryOver(sessionKey: string, prompt: string): string {
  const carryOver = pendingCarryOver.get(sessionKey);
  if (!carryOver || prompt.trimStart().startsWith('/')) return prompt;
  pendingCarryOver.delete(sessionKey);
  return `${carryOver}\n\n${prompt}`;
}
