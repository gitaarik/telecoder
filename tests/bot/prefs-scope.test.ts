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
  effortResetConfirmation,
} from '../../src/bot/handlers/command/prefs-scope.js';
import type { PrefsBroadcastResult } from '../../src/providers/prefs-sync.js';
import type { EntityMessage } from '../../src/telegram/entities.js';

/** The stretches of `msg` carrying an entity of `type`, in order. */
function styled(msg: EntityMessage, type: string): string[] {
  return msg.entities
    .filter((e) => e.type === type)
    .map((e) => msg.text.slice(e.offset, e.offset + e.length));
}

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
    const msg = prefsConfirmation('model', 'opus');
    expect(msg.text).toBe('✅ Model set to opus for TeleCoder');
    expect(styled(msg, 'bold')).toEqual(['opus', 'TeleCoder']);
  });

  it('stays terse in a single-bot setup', () => {
    siblingBotNames.mockReturnValue([]);
    const msg = prefsConfirmation('effort', 'High');
    expect(msg.text).toBe('✅ Effort set to High');
    expect(styled(msg, 'bold')).toEqual(['High']);
  });

  it('words an effort reset the same way', () => {
    siblingBotNames.mockReturnValue(['TeleCoder 2']);
    const msg = effortResetConfirmation();
    expect(msg.text).toBe('✅ Effort reset to auto (CLI default) for TeleCoder');
    expect(styled(msg, 'bold')).toEqual(['auto', 'TeleCoder']);
  });
});

describe('formatBroadcastResult', () => {
  const base: PrefsBroadcastResult = {
    applied: [], skipped: [], unreachable: [], multiInstance: true,
  };

  it('says there was nothing to do in single-instance mode', () => {
    const out = formatBroadcastResult({ ...base, multiInstance: false });
    expect(out.text).toContain('only bot running');
    expect(out.text.startsWith('\n\n')).toBe(true);
  });

  it('says the same for a launcher with one instance configured', () => {
    expect(formatBroadcastResult(base).text).toContain('only bot running');
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
      'TeleCoder 2 is mid-turn — the running session keeps the old value until it restarts.',
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
