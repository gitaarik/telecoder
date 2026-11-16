import { describe, it, expect, beforeEach, vi } from 'vitest';

const siblingBotNames = vi.fn();
const sourceOf = vi.fn();
const threadDisplayName = vi.fn();

vi.mock('../../src/providers/prefs-sync.js', () => ({
  siblingBotNames: () => siblingBotNames(),
  broadcastPrefsChange: vi.fn(),
}));

// Pulled in for the handlers, which these tests don't exercise.
vi.mock('../../src/providers/provider-router.js', () => ({
  getActiveProviderName: vi.fn(() => 'claude'),
  getAvailableModels: vi.fn(async () => []),
  isValidEffortLevel: vi.fn(() => true),
}));
vi.mock('../../src/providers/spawn-settings.js', () => ({ applySpawnSetting: vi.fn() }));
vi.mock('../../src/bot/handlers/command/all-view.js', () => ({ isFreshAllViewThread: vi.fn(() => false) }));
vi.mock('../../src/providers/user-preferences.js', () => ({
  userPreferences: {
    sourceOf: (...a: unknown[]) => sourceOf(...a),
    threadsPinnedOtherThan: vi.fn(() => []),
  },
}));
vi.mock('../../src/telegram/thread-titles.js', () => ({
  threadDisplayName: (k: string) => threadDisplayName(k),
}));

import {
  parseScopeArg,
  isBareLevelWord,
  buildWidenKeyboard,
  describeOutcome,
  describeSource,
  formatBroadcastResult,
  prefsConfirmation,
  type ScopeSite,
} from '../../src/bot/handlers/command/prefs-scope.js';
import type { PrefsBroadcastResult } from '../../src/providers/prefs-sync.js';
import type { EntityMessage } from '../../src/telegram/entities.js';

/** The stretches of `msg` carrying an entity of `type`, in order. */
function styled(msg: EntityMessage, type: string): string[] {
  return msg.entities
    .filter((e) => e.type === type)
    .map((e) => msg.text.slice(e.offset, e.offset + e.length));
}

const THREAD: ScopeSite = { inThread: true, allView: false, admin: true };
const ALL_VIEW: ScopeSite = { inThread: true, allView: true, admin: true };
const PLAIN: ScopeSite = { inThread: false, allView: false, admin: true };

describe('parseScopeArg', () => {
  it('leaves the level to the caller when none is typed', () => {
    expect(parseScopeArg('sonnet')).toEqual({ value: 'sonnet' });
    expect(parseScopeArg('')).toEqual({ value: '' });
  });

  it('reads each level word', () => {
    expect(parseScopeArg('sonnet this')).toEqual({ value: 'sonnet', level: 'thread' });
    expect(parseScopeArg('sonnet here')).toEqual({ value: 'sonnet', level: 'thread' });
    expect(parseScopeArg('sonnet new')).toEqual({ value: 'sonnet', level: 'default' });
    expect(parseScopeArg('sonnet default')).toEqual({ value: 'sonnet', level: 'default' });
    expect(parseScopeArg('sonnet chat')).toEqual({ value: 'sonnet', level: 'chat' });
    expect(parseScopeArg('  high   ALL ')).toEqual({ value: 'high', level: 'all' });
    expect(parseScopeArg('sonnet everywhere')).toEqual({ value: 'sonnet', level: 'all' });
  });

  it('leaves a lone level word alone so it still reaches the usual error path', () => {
    // Otherwise `/model all` would apply an empty model everywhere, and
    // `/effort default` would stop being the reset it always was.
    expect(parseScopeArg('all')).toEqual({ value: 'all' });
    expect(parseScopeArg('default')).toEqual({ value: 'default' });
  });

  it('keeps a full model id intact', () => {
    expect(parseScopeArg('claude-opus-4-8')).toEqual({ value: 'claude-opus-4-8' });
    expect(parseScopeArg('claude-opus-4-8 all')).toEqual({ value: 'claude-opus-4-8', level: 'all' });
  });
});

describe('isBareLevelWord', () => {
  it('knows the words that widen, and not the ones that mean this thread', () => {
    expect(isBareLevelWord('all')).toBe(true);
    expect(isBareLevelWord('Chat')).toBe(true);
    expect(isBareLevelWord('new')).toBe(true);
    expect(isBareLevelWord('here')).toBe(false);
    expect(isBareLevelWord('opus')).toBe(false);
  });
});

describe('prefsConfirmation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('says how far the change reaches', () => {
    siblingBotNames.mockReturnValue([]);
    expect(prefsConfirmation('model', 'opus', 'thread', THREAD).text).toBe('✅ Model set to opus in this thread');
    expect(prefsConfirmation('model', 'opus', 'default', THREAD).text)
      .toBe('✅ Model set to opus for this thread and new threads in this chat');
    expect(prefsConfirmation('model', 'opus', 'default', ALL_VIEW).text).toBe('✅ Model set to opus for new threads in this chat');
    expect(prefsConfirmation('model', 'opus', 'chat', THREAD).text).toBe('✅ Model set to opus for every thread in this chat');
    expect(prefsConfirmation('effort', 'High', 'all', THREAD).text).toBe('✅ Effort set to High everywhere');
  });

  it('calls a chat without threads a chat', () => {
    siblingBotNames.mockReturnValue([]);
    expect(prefsConfirmation('model', 'opus', 'thread', PLAIN).text).toBe('✅ Model set to opus in this chat');
  });

  it('names the bot once there is more than one, except everywhere', () => {
    siblingBotNames.mockReturnValue(['TeleCoder 2']);
    // BOT_NAME is pinned to "TeleCoder" in vitest.config.ts.
    const msg = prefsConfirmation('model', 'opus', 'thread', THREAD);
    expect(msg.text).toBe('✅ Model set to opus in this thread on TeleCoder');
    expect(styled(msg, 'bold')).toEqual(['opus', 'TeleCoder']);
    expect(prefsConfirmation('model', 'opus', 'all', THREAD).text).toBe('✅ Model set to opus everywhere');
  });
});

describe('buildWidenKeyboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    siblingBotNames.mockReturnValue([]);
  });

  const labels = (kb: ReturnType<typeof buildWidenKeyboard>) => (kb ?? []).flat().map((b) => b.text);

  it('offers every wider level from a thread', () => {
    siblingBotNames.mockReturnValue(['TeleCoder 2', 'TeleCoder 3']);
    const kb = buildWidenKeyboard('model', 'opus', 'thread', THREAD)!;

    expect(labels(kb)).toEqual(['🆕 New threads too', '🧵 All threads here', '🌐 Everywhere (3 bots)']);
    expect(kb.flat().map((b) => b.callback_data)).toEqual([
      'pscope:default:model:opus', 'pscope:chat:model:opus', 'pscope:all:model:opus',
    ]);
  });

  it('only offers what is wider than the level applied', () => {
    expect(labels(buildWidenKeyboard('effort', 'high', 'chat', THREAD))).toEqual(['🌐 Every chat']);
    expect(buildWidenKeyboard('effort', 'high', 'all', THREAD)).toBeUndefined();
  });

  it('keeps every chat to admins', () => {
    expect(labels(buildWidenKeyboard('model', 'opus', 'chat', { ...THREAD, admin: false }))).toEqual([]);
  });

  it('offers no thread levels in a chat without threads', () => {
    expect(labels(buildWidenKeyboard('model', 'opus', 'thread', PLAIN))).toEqual(['🌐 Every chat']);
  });

  it('offers to delete the empty thread the All view opened', () => {
    const kb = buildWidenKeyboard('model', 'opus', 'default', ALL_VIEW)!;
    expect(labels(kb)).toEqual(['🧵 All threads here', '🌐 Every chat', '🗑️ Delete this thread']);
    expect(kb.at(-1)![0].callback_data).toBe('delthread:confirm');
  });

  it('drops a button whose data would blow the callback_data limit', () => {
    // Telegram caps callback_data at 64 bytes; the typed form still works.
    expect(buildWidenKeyboard('model', 'x'.repeat(60), 'thread', THREAD)).toBeUndefined();
  });
});

describe('describeOutcome', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    threadDisplayName.mockImplementation((k: string) => ({ '1:2': 'Spinoff A', '1:3': 'Spinoff B' })[k]);
  });

  const none = { dropped: [], restarted: [], busy: [] };

  it('says nothing when nothing else happened', () => {
    expect(describeOutcome(none, { level: 'thread', current: '1:9', keptPins: [] }).text).toBe('');
  });

  it('gives the plain restart note when only this thread restarts', () => {
    const out = describeOutcome({ ...none, restarted: ['1:9'] }, { level: 'thread', current: '1:9', keptPins: [] });
    expect(out.text).toContain('restarts on your next message');
  });

  it('names the threads a chat-wide change brought in line', () => {
    const out = describeOutcome(
      { dropped: ['1:2', '1:3'], restarted: ['1:2', '1:9'], busy: ['1:3'] },
      { level: 'chat', current: '1:9', keptPins: [] },
    );
    expect(out.text).toContain('instead of their own choice: Spinoff A, Spinoff B.');
    expect(out.text).toContain('restarts in 2 threads on the next message there');
    expect(out.text).toContain('1 thread is mid-turn and switches when that turn ends.');
  });

  it('names the pinned threads a new-threads change left alone', () => {
    const out = describeOutcome(none, { level: 'default', current: '1:9', keptPins: ['1:2'] });
    expect(out.text).toContain('1 thread chose their own and keep it: Spinoff A.');
    expect(styled(out, 'bold')).toEqual(['All threads here']);
  });

  it('falls back to the thread id for a thread with no known name', () => {
    const out = describeOutcome({ ...none, dropped: ['1:44'] }, { level: 'chat', current: '1:9', keptPins: [] });
    expect(out.text).toContain('thread 44');
  });
});

describe('describeSource', () => {
  it('says where the value comes from', () => {
    sourceOf.mockReturnValueOnce('thread');
    expect(describeSource('1:2', 'model')).toBe('pinned in this thread');
    sourceOf.mockReturnValueOnce('chat');
    expect(describeSource('1:2', 'model')).toBe("this chat's default");
    sourceOf.mockReturnValueOnce('chat');
    expect(describeSource('1', 'model')).toBe('set for this chat');
    sourceOf.mockReturnValueOnce('bot');
    expect(describeSource('1:2', 'effort')).toBe('the default everywhere');
    sourceOf.mockReturnValueOnce(undefined);
    expect(describeSource('1:2', 'model')).toBe("Claude Code's default");
  });
});

describe('formatBroadcastResult', () => {
  const base: PrefsBroadcastResult = {
    applied: [], skipped: [], unreachable: [], multiInstance: true,
  };

  it('says nothing in single-instance mode, where everywhere is this bot', () => {
    expect(formatBroadcastResult({ ...base, multiInstance: false }).text).toBe('');
  });

  it('says the same for a launcher with one instance configured', () => {
    expect(formatBroadcastResult(base).text).toBe('');
  });

  it('lists the bots that took the change', () => {
    const out = formatBroadcastResult({
      ...base,
      applied: [{ name: 'TeleCoder 2', status: 'applied' }, { name: 'TeleCoder 3', status: 'applied' }],
    });

    expect(out.text).toBe('\n\n🌐 Also applied to 2 other bots: TeleCoder 2, TeleCoder 3');
    expect(styled(out, 'bold')).toEqual(['2']);
  });

  it('flags a bot whose running session kept the old value', () => {
    const out = formatBroadcastResult({
      ...base,
      applied: [{ name: 'TeleCoder 2', status: 'applied', busy: 1 }],
    });

    expect(styled(out, 'italic')).toEqual([
      'TeleCoder 2 is mid-turn — switching when that turn ends.',
    ]);
  });

  it('reports a bot that declined, with its reason', () => {
    const out = formatBroadcastResult({
      ...base,
      skipped: [{ name: 'TeleCoder 5', status: 'skipped', reason: 'on ccr, not claude' }],
    });

    expect(out.text).toContain('Not applied to TeleCoder 5 — on ccr, not claude.');
    expect(styled(out, 'bold')).toEqual(['TeleCoder 5']);
  });

  it('separates bots that are down from a launcher that never answered', () => {
    const down = formatBroadcastResult({ ...base, unreachable: ['TeleCoder 6'] });
    expect(down.text).toContain('Not running, so unchanged: TeleCoder 6');

    const stale = formatBroadcastResult({ ...base, timedOut: true });
    expect(stale.text).toContain('launcher');
    expect(stale.text).not.toContain('Not running');
  });

  it('keeps bot names verbatim, punctuation and all', () => {
    const out = formatBroadcastResult({
      ...base,
      applied: [{ name: 'Bot_1 (dev)', status: 'applied' }],
      skipped: [{ name: 'Bot*2', status: 'skipped' }],
    });

    expect(out.text).toContain(': Bot_1 (dev)');
    expect(styled(out, 'bold')).toEqual(['1', 'Bot*2']);
  });
});
