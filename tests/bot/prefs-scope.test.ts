import { describe, it, expect, beforeEach, vi } from 'vitest';

const siblingBotNames = vi.fn();

vi.mock('../../src/providers/prefs-sync.js', () => ({
  siblingBotNames: () => siblingBotNames(),
  broadcastPrefsChange: vi.fn(),
}));

// Pulled in for the callback handler, which these tests don't exercise.
vi.mock('../../src/providers/provider-router.js', () => ({
  getActiveProviderName: vi.fn(() => 'claude'),
  getAvailableModels: vi.fn(async () => []),
}));

import {
  parseScopeArg,
  buildApplyToAllKeyboard,
  formatBroadcastResult,
  prefsConfirmation,
} from '../../src/bot/handlers/command/prefs-scope.js';
import type { PrefsBroadcastResult } from '../../src/providers/prefs-sync.js';

describe('parseScopeArg', () => {
  it('defaults to this bot', () => {
    expect(parseScopeArg('sonnet')).toEqual({ value: 'sonnet', scope: 'this' });
  });

  it('takes a trailing all as the scope', () => {
    expect(parseScopeArg('sonnet all')).toEqual({ value: 'sonnet', scope: 'all' });
    expect(parseScopeArg('  high   ALL ')).toEqual({ value: 'high', scope: 'all' });
  });

  it('accepts an explicit this', () => {
    expect(parseScopeArg('sonnet this')).toEqual({ value: 'sonnet', scope: 'this' });
    expect(parseScopeArg('sonnet here')).toEqual({ value: 'sonnet', scope: 'this' });
  });

  it('leaves a bare "all" alone so it still reaches the usual error path', () => {
    // Otherwise `/model all` would silently broadcast an empty model.
    expect(parseScopeArg('all')).toEqual({ value: 'all', scope: 'this' });
  });

  it('keeps a full model id intact', () => {
    expect(parseScopeArg('claude-opus-4-8')).toEqual({ value: 'claude-opus-4-8', scope: 'this' });
    expect(parseScopeArg('claude-opus-4-8 all')).toEqual({ value: 'claude-opus-4-8', scope: 'all' });
  });

  it('is empty for a bare command', () => {
    expect(parseScopeArg('')).toEqual({ value: '', scope: 'this' });
  });
});

describe('buildApplyToAllKeyboard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('offers nothing when this is the only bot', () => {
    siblingBotNames.mockReturnValue([]);
    expect(buildApplyToAllKeyboard('model', 'sonnet')).toBeUndefined();
  });

  it('counts this bot plus its siblings', () => {
    siblingBotNames.mockReturnValue(['TeleCoder 2', 'TeleCoder 3']);

    const kb = buildApplyToAllKeyboard('model', 'sonnet')!;

    expect(kb[0][0].text).toBe('🌐 Apply to all 3 bots');
    expect(kb[0][0].callback_data).toBe('prefs_all:model:sonnet');
  });

  it('drops the button when the value would blow the callback_data limit', () => {
    siblingBotNames.mockReturnValue(['TeleCoder 2']);

    // Telegram caps callback_data at 64 bytes; the typed `all` form still works.
    expect(buildApplyToAllKeyboard('model', 'x'.repeat(60))).toBeUndefined();
  });
});

describe('prefsConfirmation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('names the bot once there is more than one', () => {
    siblingBotNames.mockReturnValue(['TeleCoder 2']);
    // BOT_NAME is pinned to "TeleCoder" in vitest.config.ts.
    expect(prefsConfirmation('model', 'opus')).toBe('✅ Model set to *opus* for *TeleCoder*');
  });

  it('stays terse in a single-bot setup', () => {
    siblingBotNames.mockReturnValue([]);
    expect(prefsConfirmation('effort', 'High')).toBe('✅ Effort set to *High*');
  });
});

describe('formatBroadcastResult', () => {
  const base: PrefsBroadcastResult = {
    applied: [], skipped: [], unreachable: [], multiInstance: true,
  };

  it('says there was nothing to do in single-instance mode', () => {
    const out = formatBroadcastResult({ ...base, multiInstance: false });
    expect(out).toContain('only bot running');
  });

  it('says the same for a launcher with one instance configured', () => {
    expect(formatBroadcastResult(base)).toContain('only bot running');
  });

  it('lists the bots that took the change', () => {
    const out = formatBroadcastResult({
      ...base,
      applied: [{ name: 'TeleCoder 2', status: 'applied' }, { name: 'TeleCoder 3', status: 'applied' }],
    });

    expect(out).toContain('*2* other bots');
    expect(out).toContain('TeleCoder 2, TeleCoder 3');
  });

  it('flags a bot whose running session kept the old value', () => {
    const out = formatBroadcastResult({
      ...base,
      applied: [{ name: 'TeleCoder 2', status: 'applied', busy: 1 }],
    });

    expect(out).toContain('mid\\-turn');
  });

  it('reports a bot that declined, with its reason', () => {
    const out = formatBroadcastResult({
      ...base,
      skipped: [{ name: 'TeleCoder 5', status: 'skipped', reason: 'on ccr, not claude' }],
    });

    expect(out).toContain('Not applied to *TeleCoder 5*');
    expect(out).toContain('on ccr, not claude');
  });

  it('separates bots that are down from a launcher that never answered', () => {
    const down = formatBroadcastResult({ ...base, unreachable: ['TeleCoder 6'] });
    expect(down).toContain('Not running, so unchanged: TeleCoder 6');

    const stale = formatBroadcastResult({ ...base, timedOut: true });
    expect(stale).toContain('launcher');
    expect(stale).not.toContain('Not running');
  });

  it('escapes bot names for MarkdownV2', () => {
    const out = formatBroadcastResult({
      ...base,
      applied: [{ name: 'Bot_1 (dev)', status: 'applied' }],
    });

    expect(out).toContain('Bot\\_1 \\(dev\\)');
  });
});
