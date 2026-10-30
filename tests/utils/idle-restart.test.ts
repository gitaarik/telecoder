import { describe, it, expect } from 'vitest';
import { IdleRestart } from '../../src/utils/idle-restart.js';

const ORIGIN = { instance: 'TeleCoder 1', chatId: 42, messageId: 7 };

function tally(names = ['TeleCoder 1', 'TeleCoder 2', 'TeleCoder 3']): IdleRestart {
  return new IdleRestart(ORIGIN, names);
}

describe('IdleRestart', () => {
  it('lists every instance as waiting until it reports', () => {
    const t = tally();
    const { text, buttons } = t.render();

    expect(buttons).toBe(true);
    expect(text).toContain('⏳ TeleCoder 1 — checking');
    expect(text).toContain('⏳ TeleCoder 3 — checking');
    expect(t.isFinished()).toBe(false);
  });

  it('shows what a busy instance says it is doing', () => {
    const t = tally();
    expect(t.busy('TeleCoder 2', '1 turn running')).toBe(true);

    expect(t.render().text).toContain('⏳ TeleCoder 2 — 1 turn running');
  });

  it('ignores reports from instances it is not waiting on', () => {
    const t = tally(['TeleCoder 1']);
    t.restarting('TeleCoder 1');

    expect(t.busy('TeleCoder 1', '1 turn running')).toBe(false);
    expect(t.busy('TeleCoder 9', '1 turn running')).toBe(false);
  });

  it('moves restarted instances off the waiting list, once', () => {
    const t = tally();
    expect(t.restarting('TeleCoder 1')).toBe(true);
    expect(t.restarting('TeleCoder 1')).toBe(false);

    const { text } = t.render();
    expect(text).toContain('✅ TeleCoder 1');
    expect(text).not.toContain('⏳ TeleCoder 1');
    expect(t.waitingOn()).toEqual(['TeleCoder 2', 'TeleCoder 3']);
  });

  it('finishes when the last one restarts, without buttons', () => {
    const t = tally(['TeleCoder 1', 'TeleCoder 2']);
    t.restarting('TeleCoder 2');
    t.restarting('TeleCoder 1');

    expect(t.isFinished()).toBe(true);
    expect(t.render()).toEqual({
      text: '✅ All 2 bots are on the new build.\n\nTeleCoder 2, TeleCoder 1',
      buttons: false,
    });
  });

  it('names the instances that were restarted without waiting', () => {
    const t = tally(['TeleCoder 1', 'TeleCoder 2']);
    t.restarting('TeleCoder 1');
    t.restarting('TeleCoder 2', { forced: true });

    expect(t.render().text).toContain('(TeleCoder 2 without waiting)');
  });

  it('says which instances a cancel leaves on the old build', () => {
    const t = tally();
    t.restarting('TeleCoder 1');

    expect(t.cancel()).toEqual(['TeleCoder 2', 'TeleCoder 3']);
    expect(t.isFinished()).toBe(true);
    const { text, buttons } = t.render();
    expect(buttons).toBe(false);
    expect(text).toContain('✖️ Restart cancelled.');
    expect(text).toContain('✅ Restarted: TeleCoder 1');
    expect(text).toContain('⏸ Still on the old build: TeleCoder 2, TeleCoder 3');
  });

  it('closes its message when a newer rebuild takes over', () => {
    const t = tally();
    t.restarting('TeleCoder 1');
    t.supersede();

    expect(t.isFinished()).toBe(true);
    expect(t.render()).toEqual({ text: '🔄 Superseded by a newer rebuild.\n\n✅ Restarted: TeleCoder 1', buttons: false });
  });

  it('keeps the note under the tally the whole way through', () => {
    const t = new IdleRestart({ ...ORIGIN, note: '⚠️ The launcher is stale.' }, ['TeleCoder 1']);
    expect(t.render().text.endsWith('\n\n⚠️ The launcher is stale.')).toBe(true);

    t.restarting('TeleCoder 1');
    expect(t.render().text.endsWith('\n\n⚠️ The launcher is stale.')).toBe(true);
  });
});
