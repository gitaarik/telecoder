import { describe, it, expect } from 'vitest';
import { dialogResumeState, turnHold, type EndOfTurnSignals } from '../../src/claude/turn-end.js';

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

/** A finished turn: everything says done, nothing is holding it. */
function done(overrides: Partial<EndOfTurnSignals> = {}): EndOfTurnSignals {
  return {
    stopReceived: false,
    inflightTools: 0,
    isIdle: true,
    hasInputBox: true,
    stillGenerating: false,
    claudeProducedSomething: true,
    resumingAfterDialog: false,
    ...overrides,
  };
}

describe('turnHold', () => {
  it('lets a finished turn end', () => {
    expect(turnHold(done())).toBeNull();
  });

  it('holds while a tool is open', () => {
    // The case the count is for: ask_user long-polls and the pty goes silent,
    // which is otherwise indistinguishable from a finished turn.
    expect(turnHold(done({ inflightTools: 1 }))).toBe('tools');
  });

  it('lets Stop overrule a tool count that never came back down', () => {
    // The bug. A lost PostToolUse leaves the count high forever, and checking
    // it before Stop let one dropped curl outrank the only authoritative
    // end-of-turn signal there is — a turn hung to the two-hour ceiling with
    // claude idle and its answer already written.
    expect(turnHold(done({ stopReceived: true, inflightTools: 2 }))).toBeNull();
  });

  it('still waits for the screen to settle after Stop', () => {
    expect(turnHold(done({ stopReceived: true, isIdle: false }))).toBe('working');
  });

  it('ignores the screen entirely once Stop has fired', () => {
    // Stop is emitted at the real end of the turn, so the heuristics that
    // stand in for it in its absence have nothing left to add.
    expect(turnHold(done({
      stopReceived: true,
      hasInputBox: false,
      stillGenerating: true,
      claudeProducedSomething: false,
      resumingAfterDialog: true,
      inflightTools: 5,
    }))).toBeNull();
  });

  it('holds a turn whose dialog was just answered', () => {
    expect(turnHold(done({ resumingAfterDialog: true }))).toBe('resuming');
  });

  it('reports tools ahead of the dialog gap when both apply', () => {
    // Ordering matters only for the reason reported, but the reason drives
    // how soon the next check runs.
    expect(turnHold(done({ inflightTools: 1, resumingAfterDialog: true }))).toBe('tools');
  });

  it.each([
    ['the pty is not idle', { isIdle: false }],
    ['the input box is gone', { hasInputBox: false }],
    ['a spinner is up', { stillGenerating: true }],
    ['claude has written nothing yet', { claudeProducedSomething: false }],
  ])('holds while %s', (_label, signal) => {
    expect(turnHold(done(signal))).toBe('working');
  });
});
