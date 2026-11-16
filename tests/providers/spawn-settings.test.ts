import { describe, it, expect, beforeEach, vi } from 'vitest';

// Which claudes a level change restarts, and when. Preferences are a plain
// in-memory stand-in: the point is the before/after comparison.
const values = new Map<string, string | undefined>();
const applyLevel = vi.fn();
const listSessionKeys = vi.fn();
const listSessionKeysForChat = vi.fn();
const clearConversation = vi.fn();
const isInFlight = vi.fn();
const runAfterTurn = vi.fn();

vi.mock('../../src/providers/user-preferences.js', () => ({
  userPreferences: {
    getModel: (k: string) => values.get(k),
    getEffort: (k: string) => values.get(k),
    applyLevel: (...a: unknown[]) => applyLevel(...a),
  },
}));
vi.mock('../../src/providers/claude-provider.js', () => ({
  getPtyProvider: () => ({ listSessionKeys, listSessionKeysForChat, clearConversation }),
}));
vi.mock('../../src/claude/in-flight-tracker.js', () => ({
  isInFlight: (k: string) => isInFlight(k),
  runAfterTurn: (k: string, fn: () => void) => runAfterTurn(k, fn),
}));

import { applySpawnSetting } from '../../src/providers/spawn-settings.js';

describe('applySpawnSetting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    values.clear();
    isInFlight.mockReturnValue(false);
    applyLevel.mockReturnValue([]);
  });

  it('restarts only the live sessions whose value changed', () => {
    listSessionKeysForChat.mockReturnValue(['42:1', '42:2', '42:3']);
    values.set('42:1', 'fable').set('42:2', 'haiku').set('42:3', 'opus');
    applyLevel.mockImplementation(() => {
      values.set('42:1', 'opus');
      return ['42:1'];
    });

    const out = applySpawnSetting('42:1', 'model', 'opus', 'chat', '42:1');

    expect(clearConversation.mock.calls).toEqual([['42:1']]);
    expect(out).toEqual({ dropped: ['42:1'], restarted: ['42:1'], busy: [] });
  });

  it('switches a session mid-turn when its turn ends, not now', () => {
    listSessionKeysForChat.mockReturnValue(['42:1', '42:2']);
    values.set('42:1', 'fable').set('42:2', 'fable');
    isInFlight.mockImplementation((k: string) => k === '42:2');
    applyLevel.mockImplementation(() => {
      values.set('42:1', 'opus').set('42:2', 'opus');
      return [];
    });

    const out = applySpawnSetting('42:1', 'model', 'opus', 'chat', '42:1');

    expect(out.restarted).toEqual(['42:1']);
    expect(out.busy).toEqual(['42:2']);
    expect(clearConversation).not.toHaveBeenCalledWith('42:2');
    // The deferred action is the same restart.
    runAfterTurn.mock.calls[0][1]();
    expect(clearConversation).toHaveBeenCalledWith('42:2');
  });

  it('restarts the session it was typed in even mid-turn, as /model always has', () => {
    listSessionKeysForChat.mockReturnValue(['42:1']);
    isInFlight.mockReturnValue(true);
    applyLevel.mockImplementation(() => { values.set('42:1', 'opus'); return []; });

    expect(applySpawnSetting('42:1', 'model', 'opus', 'thread', '42:1').restarted).toEqual(['42:1']);
  });

  it('looks at every chat for an everywhere change', () => {
    listSessionKeys.mockReturnValue(['42:1', '77']);
    applyLevel.mockImplementation(() => { values.set('77', 'opus'); return []; });

    const out = applySpawnSetting('42:1', 'model', 'opus', 'all', '42:1');

    expect(listSessionKeysForChat).not.toHaveBeenCalled();
    expect(out.restarted).toEqual(['77']);
  });
});
