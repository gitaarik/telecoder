import { describe, it, expect } from 'vitest';
import {
  tickWasStalled,
  withinStallCooldown,
  shouldEscalateWedged,
} from '../../src/utils/host-stall.js';

const CHECK_MS = 30_000;
const SLACK_MS = 30_000;
const COOLDOWN_MS = 180_000;
const MAX_DEFER_MS = 1_800_000;

const tick = (sinceLastTickMs: number) =>
  tickWasStalled({ sinceLastTickMs, intervalMs: CHECK_MS, slackMs: SLACK_MS });

const cooldown = (stalledAgoMs: number) =>
  withinStallCooldown({ stalledAgoMs, cooldownMs: COOLDOWN_MS });

const escalate = (stalledAgoMs: number, deferredForMs: number) =>
  shouldEscalateWedged({
    stalledAgoMs, deferredForMs, cooldownMs: COOLDOWN_MS, maxDeferMs: MAX_DEFER_MS,
  });

describe('tickWasStalled', () => {
  it('treats an on-time tick as healthy', () => {
    expect(tick(CHECK_MS)).toBe(false);
  });

  it('allows ordinary scheduling jitter', () => {
    expect(tick(CHECK_MS + SLACK_MS)).toBe(false);
  });

  it('flags a tick that fired past the slack', () => {
    expect(tick(CHECK_MS + SLACK_MS + 1)).toBe(true);
  });

  it('flags the multi-minute freezes seen under memory pressure', () => {
    // Real values from a thrashing host: a 30s monitor firing minutes late.
    expect(tick(306_000)).toBe(true);
    expect(tick(1_881_000)).toBe(true);
  });
});

describe('withinStallCooldown', () => {
  it('holds off while the stall is still recent', () => {
    expect(cooldown(0)).toBe(true);
    expect(cooldown(COOLDOWN_MS - 1)).toBe(true);
  });

  it('trusts the host again once the cooldown elapses', () => {
    expect(cooldown(COOLDOWN_MS)).toBe(false);
    expect(cooldown(COOLDOWN_MS * 10)).toBe(false);
  });

  it('never holds off on a host that has not stalled', () => {
    // What hostStalledAgoMs() reports before the first stall is ever seen.
    expect(cooldown(Infinity)).toBe(false);
  });
});

describe('shouldEscalateWedged', () => {
  it('escalates a worker that stays alive on a healthy host', () => {
    expect(escalate(Infinity, 0)).toBe(true);
    expect(escalate(COOLDOWN_MS, 0)).toBe(true);
  });

  it('defers while the host is still freezing', () => {
    // The failure this guards: one starved worker taking all six bots down
    // with the launcher because terminate() could not reach a thread that
    // simply was not being scheduled.
    expect(escalate(1_000, 0)).toBe(false);
    expect(escalate(COOLDOWN_MS - 1, MAX_DEFER_MS - 1)).toBe(false);
  });

  it('escalates anyway once deferring has cost more than it saves', () => {
    // A host stalling every few minutes for hours would defer forever, and an
    // instance deferred forever is an instance offline for good.
    expect(escalate(0, MAX_DEFER_MS)).toBe(true);
    expect(escalate(0, MAX_DEFER_MS * 2)).toBe(true);
  });
});
