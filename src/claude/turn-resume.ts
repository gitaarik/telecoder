/**
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
