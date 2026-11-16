import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';

// Stands in for the launcher on the other end of the worker's message port.
const parentPort = new EventEmitter() as EventEmitter & { postMessage: ReturnType<typeof vi.fn> };
parentPort.postMessage = vi.fn();
let isMainThread = false;

vi.mock('worker_threads', () => ({
  get isMainThread() { return isMainThread; },
  get parentPort() { return isMainThread ? null : parentPort; },
}));

vi.mock('../../src/utils/instances.js', () => ({
  listSiblingBots: () => [{ name: 'TeleCoder 2', botId: '2' }],
}));

// The receiving half of a fleet-wide /model or /effort. What it touches is
// mocked: the point is which level it applies at, and when it declines.
const applySpawnSetting = vi.fn();
const getActiveProviderName = vi.fn();

vi.mock('../../src/providers/provider-router.js', () => ({
  getActiveProviderName: (...a: unknown[]) => getActiveProviderName(...a),
  isValidEffortLevel: (l: string) => ['low', 'medium', 'high', 'xhigh', 'max'].includes(l),
}));

vi.mock('../../src/providers/spawn-settings.js', () => ({
  applySpawnSetting: (...a: unknown[]) => applySpawnSetting(...a),
}));

import {
  applyPrefsChange,
  broadcastPrefsChange,
  initPrefsSync,
  siblingBotNames,
  type PrefsChange,
} from '../../src/providers/prefs-sync.js';

function change(over: Partial<PrefsChange> = {}): PrefsChange {
  return { chatId: 42, setting: 'model', value: 'sonnet', provider: 'claude', level: 'all', ...over };
}

describe('applyPrefsChange', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getActiveProviderName.mockReturnValue('claude');
    applySpawnSetting.mockReturnValue({ dropped: [], restarted: [], busy: [] });
  });

  it('applies a model change at the level it was made', () => {
    const outcome = applyPrefsChange(change());

    expect(outcome.status).toBe('applied');
    expect(applySpawnSetting).toHaveBeenCalledWith(42, 'model', 'sonnet', 'all');
  });

  it('applies an effort change', () => {
    const outcome = applyPrefsChange(change({ setting: 'effort', value: 'high' }));

    expect(outcome.status).toBe('applied');
    expect(applySpawnSetting).toHaveBeenCalledWith(42, 'effort', 'high', 'all');
  });

  it('passes a null value through as the CLI default', () => {
    applyPrefsChange(change({ setting: 'effort', value: null }));

    expect(applySpawnSetting).toHaveBeenCalledWith(42, 'effort', null, 'all');
  });

  it('reads a change from an older worker, which has no level, as chat-wide', () => {
    applyPrefsChange(change({ level: undefined }));

    expect(applySpawnSetting).toHaveBeenCalledWith(42, 'model', 'sonnet', 'chat');
  });

  it('declines a change made against a different backend', () => {
    getActiveProviderName.mockReturnValue('ccr');

    const outcome = applyPrefsChange(change({ provider: 'claude' }));

    // Aliases mean different things on each backend, so applying it anyway
    // would point this bot at a model it can't serve.
    expect(outcome.status).toBe('skipped');
    expect(outcome.reason).toContain('ccr');
    expect(applySpawnSetting).not.toHaveBeenCalled();
  });

  it('declines an effort level it does not recognise', () => {
    const outcome = applyPrefsChange(change({ setting: 'effort', value: 'turbo' }));

    expect(outcome.status).toBe('skipped');
    expect(applySpawnSetting).not.toHaveBeenCalled();
  });

  it('reports the sessions that switch when their turn ends', () => {
    applySpawnSetting.mockReturnValue({ dropped: [], restarted: ['42'], busy: ['42:7'] });

    expect(applyPrefsChange(change()).busy).toBe(1);
  });
});

describe('broadcastPrefsChange', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isMainThread = false;
    parentPort.removeAllListeners();
  });

  it('reports single-instance mode instead of waiting on a launcher', async () => {
    isMainThread = true;

    const result = await broadcastPrefsChange(change());

    expect(result.multiInstance).toBe(false);
    expect(parentPort.postMessage).not.toHaveBeenCalled();
  });

  it('sends the change to the launcher and resolves on its reply', async () => {
    const pending = broadcastPrefsChange(change());

    const sent = parentPort.postMessage.mock.calls[0][0];
    expect(sent.type).toBe('prefs_broadcast');
    expect(sent.change).toEqual(change());

    parentPort.emit('message', {
      type: 'prefs_broadcast_result',
      requestId: sent.requestId,
      applied: [{ name: 'TeleCoder 2', status: 'applied' }],
      skipped: [],
      unreachable: ['TeleCoder 6'],
    });

    const result = await pending;
    expect(result.multiInstance).toBe(true);
    expect(result.applied).toEqual([{ name: 'TeleCoder 2', status: 'applied' }]);
    expect(result.unreachable).toEqual(['TeleCoder 6']);
  });

  it('ignores a reply meant for a different broadcast', async () => {
    const pending = broadcastPrefsChange(change());
    const { requestId } = parentPort.postMessage.mock.calls[0][0];

    parentPort.emit('message', { type: 'prefs_broadcast_result', requestId: 'someone-else', applied: [{ name: 'X', status: 'applied' }] });
    parentPort.emit('message', { type: 'prefs_broadcast_result', requestId, applied: [] });

    expect((await pending).applied).toEqual([]);
  });

  it('gives concurrent broadcasts distinct ids', () => {
    broadcastPrefsChange(change());
    broadcastPrefsChange(change({ setting: 'effort', value: 'high' }));

    const [a, b] = parentPort.postMessage.mock.calls.map((c) => c[0].requestId);
    expect(a).not.toBe(b);
  });

  it('reports a timeout distinctly from bots being down', async () => {
    vi.useFakeTimers();
    try {
      const pending = broadcastPrefsChange(change());
      await vi.advanceTimersByTimeAsync(5000);

      const result = await pending;
      // A launcher predating this message type never answers. The other bots
      // are running fine — it's the relay that isn't — so they must not be
      // reported as down.
      expect(result.timedOut).toBe(true);
      expect(result.unreachable).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops listening once a broadcast resolves', async () => {
    const before = parentPort.listenerCount('message');
    const pending = broadcastPrefsChange(change());
    const { requestId } = parentPort.postMessage.mock.calls[0][0];

    parentPort.emit('message', { type: 'prefs_broadcast_result', requestId });
    await pending;

    expect(parentPort.listenerCount('message')).toBe(before);
  });
});

describe('initPrefsSync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isMainThread = false;
    parentPort.removeAllListeners();
    getActiveProviderName.mockReturnValue('claude');
    applySpawnSetting.mockReturnValue({ dropped: [], restarted: [], busy: [] });
  });

  afterEach(() => parentPort.removeAllListeners());

  it('applies a relayed change and answers the launcher', () => {
    initPrefsSync();

    parentPort.emit('message', { type: 'prefs_apply', requestId: 'r1', change: change() });

    expect(applySpawnSetting).toHaveBeenCalledWith(42, 'model', 'sonnet', 'all');
    expect(parentPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'prefs_apply_result', requestId: 'r1', status: 'applied' }),
    );
  });

  it('answers even when the change is declined, so nobody waits on it', () => {
    getActiveProviderName.mockReturnValue('ccr');
    initPrefsSync();

    parentPort.emit('message', { type: 'prefs_apply', requestId: 'r1', change: change() });

    expect(parentPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'prefs_apply_result', status: 'skipped' }),
    );
  });

  it('answers rather than throwing when applying fails', () => {
    applySpawnSetting.mockImplementation(() => { throw new Error('disk full'); });
    initPrefsSync();

    parentPort.emit('message', { type: 'prefs_apply', requestId: 'r1', change: change() });

    // Silence here would hang the requesting bot until its own timeout.
    expect(parentPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'skipped', reason: 'disk full' }),
    );
  });

  it('ignores unrelated and malformed messages', () => {
    initPrefsSync();

    parentPort.emit('message', { type: 'shutdown' });
    parentPort.emit('message', { type: 'prefs_apply', requestId: 'r1' });
    parentPort.emit('message', { type: 'prefs_apply', change: change() });

    expect(applySpawnSetting).not.toHaveBeenCalled();
    expect(parentPort.postMessage).not.toHaveBeenCalled();
  });

  it('does nothing in single-instance mode', () => {
    isMainThread = true;
    initPrefsSync();

    expect(parentPort.listenerCount('message')).toBe(0);
  });
});

describe('siblingBotNames', () => {
  it('lists the other configured bots', () => {
    isMainThread = false;
    expect(siblingBotNames()).toEqual(['TeleCoder 2']);
  });

  it('is empty in single-instance mode, where the fan-out has no meaning', () => {
    isMainThread = true;
    expect(siblingBotNames()).toEqual([]);
  });
});
