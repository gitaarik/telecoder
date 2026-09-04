import { describe, it, expect } from 'vitest';
import { dialogResumeState } from '../../src/claude/turn-resume.js';

const GRACE = 15_000;
const ANSWERED = 1_000_000;

/** The inputs for a turn that has answered a dialog and heard nothing since. */
function silent(overrides: Partial<Parameters<typeof dialogResumeState>[1]> = {}) {
  return {
    generating: false,
    inflightTools: 0,
    now: ANSWERED + 500,
    graceMs: GRACE,
    ...overrides,
  };
}

describe('dialogResumeState', () => {
  it('does nothing when no dialog was answered', () => {
    // The ordinary turn: every other input is irrelevant, because there is no
    // gap to wait out.
    expect(dialogResumeState(null, silent())).toEqual({ answeredAt: null, resuming: false });
    expect(dialogResumeState(null, silent({ generating: true, inflightTools: 3 })))
      .toEqual({ answeredAt: null, resuming: false });
  });

  it('holds the turn open while claude has not shown itself yet', () => {
    // The whole bug in one assertion. Silence here is claude resuming, and the
    // caller's other conditions — quiet pty, input box back, log already
    // written — are all true and all misleading.
    expect(dialogResumeState(ANSWERED, silent())).toEqual({
      answeredAt: ANSWERED,
      resuming: true,
    });
  });

  it('lets go the moment a spinner appears', () => {
    expect(dialogResumeState(ANSWERED, silent({ generating: true }))).toEqual({
      answeredAt: null,
      resuming: false,
    });
  });

  it('lets go when a tool opens without a spinner ever being seen', () => {
    // The hooks are the other half of "claude is working": a tool can be in
    // flight across a check that catches the screen between repaints.
    expect(dialogResumeState(ANSWERED, silent({ inflightTools: 1 }))).toEqual({
      answeredAt: null,
      resuming: false,
    });
  });

  it('clears the marker rather than merely ignoring it', () => {
    // If resuming went false while answeredAt stayed set, the real end of this
    // turn would be blocked again by every later check inside the window.
    const resumed = dialogResumeState(ANSWERED, silent({ generating: true }));
    expect(resumed.answeredAt).toBeNull();

    const afterwards = dialogResumeState(resumed.answeredAt, silent({ now: ANSWERED + 600 }));
    expect(afterwards.resuming).toBe(false);
  });

  it('gives up once the grace window is spent', () => {
    // A dialog whose answer genuinely ended the turn produces this silence
    // forever, so the wait has to be bounded or the turn hangs to the ceiling.
    expect(dialogResumeState(ANSWERED, silent({ now: ANSWERED + GRACE }))).toEqual({
      answeredAt: ANSWERED,
      resuming: false,
    });
  });

  it('waits right up to the bound, and not past it', () => {
    expect(dialogResumeState(ANSWERED, silent({ now: ANSWERED + GRACE - 1 })).resuming).toBe(true);
    expect(dialogResumeState(ANSWERED, silent({ now: ANSWERED + GRACE + 1 })).resuming).toBe(false);
  });

  it('keeps the marker after giving up, so the window cannot restart', () => {
    // Clearing it on expiry would make the next check see a fresh null, and a
    // later dialog-free silence could then be read as a new gap.
    const expired = dialogResumeState(ANSWERED, silent({ now: ANSWERED + GRACE * 2 }));
    expect(expired).toEqual({ answeredAt: ANSWERED, resuming: false });
  });

  it('does not treat the answering instant itself as already expired', () => {
    expect(dialogResumeState(ANSWERED, silent({ now: ANSWERED })).resuming).toBe(true);
  });
});
