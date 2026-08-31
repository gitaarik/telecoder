import { describe, it, expect, beforeEach } from 'vitest';
import { recordTurnCost, getSessionCost, clearSessionCost } from '../../src/claude/session-cost.js';

describe('session cost accumulator', () => {
  beforeEach(() => {
    clearSessionCost('chat-1');
    clearSessionCost('chat-2');
  });

  it('reports zero for a session that has never spent anything', () => {
    expect(getSessionCost('chat-1')).toEqual({ usd: 0, turns: 0 });
  });

  it('sums turns into a running total', () => {
    recordTurnCost('chat-1', 0.05);
    recordTurnCost('chat-1', 0.02);
    const total = getSessionCost('chat-1');
    expect(total.usd).toBeCloseTo(0.07, 10);
    expect(total.turns).toBe(2);
  });

  it('returns the new total from the call that recorded it', () => {
    recordTurnCost('chat-1', 0.1);
    expect(recordTurnCost('chat-1', 0.1).usd).toBeCloseTo(0.2, 10);
  });

  it('counts a free turn as a turn', () => {
    // A local slash command answers without a model call. It still happened.
    expect(recordTurnCost('chat-1', 0)).toEqual({ usd: 0, turns: 1 });
  });

  it('ignores a non-finite cost rather than poisoning the total', () => {
    recordTurnCost('chat-1', 0.05);
    expect(recordTurnCost('chat-1', Number.NaN).usd).toBeCloseTo(0.05, 10);
  });

  it('keeps sessions apart', () => {
    recordTurnCost('chat-1', 0.05);
    recordTurnCost('chat-2', 0.30);
    expect(getSessionCost('chat-1').usd).toBeCloseTo(0.05, 10);
    expect(getSessionCost('chat-2').usd).toBeCloseTo(0.30, 10);
  });

  it('starts over after a clear', () => {
    recordTurnCost('chat-1', 0.05);
    clearSessionCost('chat-1');
    expect(getSessionCost('chat-1')).toEqual({ usd: 0, turns: 0 });
  });
});
