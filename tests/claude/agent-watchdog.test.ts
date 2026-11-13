import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentWatchdog } from '../../src/claude/agent-watchdog.js';

const STALE_MS = 180_000;

function watchdog(shouldPauseStaleTool?: () => boolean) {
  const onStaleToolTimeout = vi.fn();
  const onSilenceTimeout = vi.fn();
  const w = new AgentWatchdog({
    chatId: 'test',
    warnAfterSeconds: 30,
    logIntervalSeconds: 10,
    silenceTimeoutMs: STALE_MS,
    staleToolTimeoutMs: STALE_MS,
    onStaleToolTimeout,
    onSilenceTimeout,
    shouldPauseStaleTool,
  });
  w.start();
  return { w, onStaleToolTimeout, onSilenceTimeout };
}

// Heartbeats every 10s for `ms`, as the SDK sends while a tool runs.
function heartbeats(w: AgentWatchdog, ms: number) {
  for (let t = 0; t < ms; t += 10_000) {
    vi.advanceTimersByTime(10_000);
    w.recordActivity('tool_progress');
  }
}

describe('AgentWatchdog stale tool timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('fires when only heartbeats arrive', () => {
    const { w, onStaleToolTimeout } = watchdog();
    heartbeats(w, STALE_MS + 20_000);
    expect(onStaleToolTimeout).toHaveBeenCalledOnce();
  });

  it('waits while a quiet shell command runs', () => {
    const { w, onStaleToolTimeout } = watchdog(() => true);
    heartbeats(w, 9 * 60_000);
    expect(onStaleToolTimeout).not.toHaveBeenCalled();
    w.stop();
  });

  it('counts from when the command ended, not from before it started', () => {
    let running = true;
    const { w, onStaleToolTimeout } = watchdog(() => running);
    heartbeats(w, 9 * 60_000);
    running = false;
    heartbeats(w, STALE_MS - 20_000);
    expect(onStaleToolTimeout).not.toHaveBeenCalled();
    heartbeats(w, 40_000);
    expect(onStaleToolTimeout).toHaveBeenCalledOnce();
  });

  it('still fires the silence timeout during a command', () => {
    const { onSilenceTimeout } = watchdog(() => true);
    vi.advanceTimersByTime(STALE_MS + 20_000);
    expect(onSilenceTimeout).toHaveBeenCalledOnce();
  });
});
