/**
 * What keeps a pty turn from ending, and what is allowed to overrule it.
 *
 * The two answers here were each written after a live session hung on the
 * other one's absence, and they fail in opposite directions: one ended a turn
 * that was still running, the other refused to end one that had finished over
 * an hour earlier. Both are decisions about trusting a signal that is not
 * quite the thing it stands for, which is why they live together and in the
 * open rather than inline in a timer callback.
 *
 * ---
 *
 * The gap between answering a dialog and claude picking the turn back up.
 *
 * The end-of-turn check has no direct signal for "claude is finished" — it
 * infers it from a quiet pty, the input box being back, no spinner, and the
 * session log having moved since the prompt went in. That inference holds for
 * an ordinary turn. It does not hold in the moment after a dialog is answered,
 * where every one of those is true and none of them mean what they usually do:
 * the dialog is gone so the box is back, the spinner is not drawn yet because
 * claude has not resumed, and the log moved long before the dialog opened.
 *
 * A turn resolved in that gap is not merely early, it is unrecoverable for the
 * session. The bot hands back an answer and forgets the turn; claude carries on
 * working with nobody listening. Its hooks arrive with no active turn and are
 * dropped, so the in-flight tool count stops being maintained; its output goes
 * nowhere; and because the screen does say "generating" once it resumes, every
 * later message is held against it and rejected when the ceiling runs out.
 * That is one live session spending 37 minutes unreachable, which is what this
 * module exists to prevent.
 *
 * So the gap is waited out rather than reasoned about. Claude ends it by
 * showing itself — a spinner on screen, or a tool announcing itself through the
 * hooks — and a bound ends it if claude never does, because a dialog whose
 * answer genuinely finished the turn has to resolve too.
 */

export interface ResumeInputs {
  /** Spinner on screen: claude is visibly working again. */
  generating: boolean;
  /** Tools the hooks say are open; >0 is claude working without a spinner. */
  inflightTools: number;
  /** Now, as a timestamp. Injected so the bound is testable. */
  now: number;
  /** How long to wait for claude before the ordinary rules apply again. */
  graceMs: number;
}

export interface ResumeState {
  /** The marker to keep on the session: null once claude has shown itself. */
  answeredAt: number | null;
  /** While true, the idle end-of-turn path must not be believed. */
  resuming: boolean;
}

/**
 * Where a turn stands relative to a dialog it answered at `answeredAt`.
 *
 * `null` in, `null` out and `resuming: false` — no dialog was answered, so
 * there is nothing to wait for and the caller's usual rules stand unchanged.
 */
export function dialogResumeState(
  answeredAt: number | null,
  { generating, inflightTools, now, graceMs }: ResumeInputs,
): ResumeState {
  if (answeredAt === null) return { answeredAt: null, resuming: false };

  // Claude showed itself. The marker has done its job and must be cleared, not
  // just ignored: leaving it set would hold the *real* end of this turn off for
  // the rest of the grace window every time the check ran.
  if (generating || inflightTools > 0) return { answeredAt: null, resuming: false };

  // Nothing from claude yet. Keep waiting, unless we have waited long enough
  // that "the dialog ended the turn" is the better reading. Note this keeps the
  // marker: the bound stops it blocking, and clearing it here would restart the
  // window on a later check that happened to see the same silence.
  return { answeredAt, resuming: now - answeredAt < graceMs };
}

/** What the end-of-turn check knows when it decides whether a turn is over. */
export interface EndOfTurnSignals {
  /** Claude's Stop hook has fired for this turn. */
  stopReceived: boolean;
  /** Tools the hooks say are still open. */
  inflightTools: number;
  /** The pty has been quiet for the current idle window. */
  isIdle: boolean;
  /** Claude's input box is drawn. */
  hasInputBox: boolean;
  /** The TUI is showing a spinner. */
  stillGenerating: boolean;
  /** Claude wrote to the session log since the prompt went in, or we gave up waiting. */
  claudeProducedSomething: boolean;
  /** A dialog was answered and claude has not shown itself since. */
  resumingAfterDialog: boolean;
}

/** Why a turn cannot end yet. Null means it may. */
export type TurnHold =
  /** A tool is still open, per the hooks. */
  | 'tools'
  /** A dialog was just answered and claude has not resumed yet. */
  | 'resuming'
  /** Claude still looks busy: output, spinner, or no input box. */
  | 'working'
  | null;

/**
 * Whether the turn may end, and what is holding it if not.
 *
 * Stop outranks the tool count, and that ordering is the whole point. Stop is
 * emitted after every tool has completed, so once it has fired a non-zero
 * count cannot be a live tool — it is a decrement that never arrived. The
 * hooks are `curl` calls into a loopback server, fired and forgotten
 * (`>/dev/null 2>&1; exit 0`), and a POST that fails takes its decrement with
 * it. There is no retry, and nothing else ever brings the count back down.
 *
 * Checking the count first, as this did, let one lost hook outrank the only
 * authoritative end-of-turn signal there is. A turn then hung until the
 * two-hour ceiling with claude idle at its prompt and its finished answer
 * sitting undelivered in the session log — which is exactly what happened to
 * one chat, an hour and seven minutes after claude had said "Done".
 *
 * The count still guards the ordinary path, where it earns its keep: a tool
 * like claudegram_ask_user long-polls for a button tap and the pty is silent
 * by design for as long as it waits, which is otherwise indistinguishable
 * from a finished turn.
 */
export function turnHold(s: EndOfTurnSignals): TurnHold {
  // Stop is authoritative. All it waits for is the screen to settle.
  if (s.stopReceived) return s.isIdle ? null : 'working';

  if (s.inflightTools > 0) return 'tools';
  if (!(s.isIdle && s.hasInputBox && !s.stillGenerating && s.claudeProducedSomething)) {
    return 'working';
  }
  // Everything says finished, which is also how the moment after a dialog is
  // answered looks. That one is not finished.
  return s.resumingAfterDialog ? 'resuming' : null;
}
