import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PrefsRelay, type PrefsRelaySummary } from '../../src/utils/prefs-relay.js';

const TIMEOUT = 3500;

function applied(name: string, busy?: number) {
  return { name, status: 'applied' as const, ...(busy === undefined ? {} : { busy }) };
}

describe('PrefsRelay', () => {
  let settled: PrefsRelaySummary[];
  let relay: PrefsRelay;

  const begin = (id: string, awaiting: string[], unreachable: string[] = []) =>
    relay.begin(id, {
      awaiting,
      unreachable,
      timeoutMs: TIMEOUT,
      onSettle: (s) => settled.push(s),
    });

  beforeEach(() => {
    vi.useFakeTimers();
    settled = [];
    relay = new PrefsRelay();
  });

  afterEach(() => vi.useRealTimers());

  it('answers immediately when there is nobody to wait for', () => {
    begin('r1', []);

    expect(settled).toHaveLength(1);
    expect(settled[0]).toEqual({ applied: [], skipped: [], unreachable: [] });
    expect(relay.has('r1')).toBe(false);
  });

  it('holds the broadcast open until the last bot answers', () => {
    begin('r1', ['b2', 'b3']);

    relay.record('r1', applied('b2'));
    expect(settled).toHaveLength(0);

    relay.record('r1', applied('b3'));
    expect(settled).toHaveLength(1);
    expect(settled[0].applied.map((o) => o.name)).toEqual(['b2', 'b3']);
  });

  it('splits answers into applied and skipped', () => {
    begin('r1', ['b2', 'b3']);
    relay.record('r1', applied('b2', 1));
    relay.record('r1', { name: 'b3', status: 'skipped', reason: 'on ccr, not claude' });

    const [summary] = settled;
    expect(summary.applied).toEqual([applied('b2', 1)]);
    expect(summary.skipped).toEqual([{ name: 'b3', status: 'skipped', reason: 'on ccr, not claude' }]);
  });

  it('carries through bots that were never sent the change', () => {
    begin('r1', ['b2'], ['b4']);
    relay.record('r1', applied('b2'));

    expect(settled[0].unreachable).toEqual(['b4']);
  });

  it('reports a bot that never answered as unreachable, after the timeout', () => {
    const onTimeout = vi.fn();
    relay.begin('r1', {
      awaiting: ['b2', 'b3'],
      unreachable: [],
      timeoutMs: TIMEOUT,
      onTimeout,
      onSettle: (s) => settled.push(s),
    });
    relay.record('r1', applied('b2'));

    vi.advanceTimersByTime(TIMEOUT);

    expect(onTimeout).toHaveBeenCalledWith(['b3']);
    expect(settled).toHaveLength(1);
    expect(settled[0].applied.map((o) => o.name)).toEqual(['b2']);
    expect(settled[0].unreachable).toEqual(['b3']);
  });

  it('does not settle twice when a straggler answers after the timeout', () => {
    begin('r1', ['b2']);
    vi.advanceTimersByTime(TIMEOUT);
    expect(settled).toHaveLength(1);

    // The requester has already been told b2 didn't answer; a second summary
    // would overwrite the message it produced with a contradictory one.
    relay.record('r1', applied('b2'));
    expect(settled).toHaveLength(1);
  });

  it('ignores a duplicate answer from the same bot', () => {
    begin('r1', ['b2', 'b3']);
    relay.record('r1', applied('b2'));
    relay.record('r1', applied('b2'));

    expect(settled).toHaveLength(0);
    expect(relay.awaiting('r1')).toEqual(['b3']);
  });

  it('ignores answers for an unknown broadcast', () => {
    relay.record('nope', applied('b2'));
    expect(settled).toHaveLength(0);
  });

  it('settles as soon as a bot it was waiting on exits', () => {
    begin('r1', ['b2', 'b3']);
    relay.record('r1', applied('b2'));

    relay.abandonEverywhere('b3');

    // No waiting out the timeout for a worker that is already gone.
    expect(settled).toHaveLength(1);
    expect(settled[0].unreachable).toEqual(['b3']);
  });

  it('abandons a bot across every open broadcast', () => {
    begin('r1', ['b2']);
    begin('r2', ['b2']);

    relay.abandonEverywhere('b2');

    expect(settled).toHaveLength(2);
    expect(settled.every((s) => s.unreachable.includes('b2'))).toBe(true);
  });

  it('leaves broadcasts that were not waiting on the exited bot alone', () => {
    begin('r1', ['b2']);
    relay.abandonEverywhere('b9');

    expect(settled).toHaveLength(0);
    expect(relay.has('r1')).toBe(true);
  });

  it('keeps concurrent broadcasts independent', () => {
    begin('r1', ['b2']);
    begin('r2', ['b3']);

    relay.record('r1', applied('b2'));

    expect(settled).toHaveLength(1);
    expect(settled[0].applied.map((o) => o.name)).toEqual(['b2']);
    expect(relay.has('r2')).toBe(true);
  });

  it('answers the first requester rather than orphaning it if an id repeats', () => {
    begin('r1', ['b2']);
    begin('r1', ['b3']);

    // The first broadcast settles on the spot; without this it would keep its
    // timer, overwrite nothing, and never reach its own requester.
    expect(settled).toHaveLength(1);
    expect(settled[0].unreachable).toEqual(['b2']);
    expect(relay.awaiting('r1')).toEqual(['b3']);
  });
});
