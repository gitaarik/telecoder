import { describe, it, expect } from 'vitest';
import { scrapeCostSession } from '../../src/claude/cost-overlay-scraper.js';

// Real renders captured from claude 2.1.251 in a pty at 120 cols, scrollback
// included, so the tests face the same stale-overlay risk the live scraper does.
const RULE = '▔'.repeat(120);

const SCROLLBACK = [
  '',
  '❯ say only the word ok',
  '',
  '● ok',
  '',
  '✻ Crunched for 1s · done 10:30 PM',
].join('\n');

/** `/cost` after a turn: the per-model breakdown is present. */
const AFTER_A_TURN = [
  SCROLLBACK,
  RULE,
  '   Settings  Status   Config   Usage   Stats',
  '',
  '   Session',
  '',
  '   Total cost:            $0.0246',
  '   Total duration (API):  3s',
  '   Total duration (wall): 8s',
  '   Total code changes:    0 lines added, 0 lines removed',
  '   Usage by model:',
  '       claude-haiku-4-5:  1.8k input, 63 output, 26.3k cache read, 9.9k cache write ($0.0246)',
  '   Prompt cache (main):   1 request · 73% of input tokens from cache · no misses · warm (1h TTL, last activity 4s ',
  '   ago)',
  '',
  '   Current session',
  '   █████████                                          18% used',
  '   Resets 12:39am (UTC)',
  '',
  '   Current week (all models)',
  '                                                      0% used',
  '   Resets Sep 12, 7:59pm (UTC)',
].join('\n');

/** `/cost` in a session that has spent nothing: one flat `Usage:` row. */
const UNTOUCHED_SESSION = [
  SCROLLBACK,
  RULE,
  '   Settings  Status   Config   Usage   Stats',
  '',
  '   Session',
  '',
  '   Total cost:            $0.0000',
  '   Total duration (API):  0s',
  '   Total duration (wall): 3s',
  '   Total code changes:    0 lines added, 0 lines removed',
  '   Usage:                 0 input, 0 output, 0 cache read, 0 cache write',
  '',
  '   Current session',
].join('\n');

describe('scrapeCostSession', () => {
  it('reads the label/value rows off the Usage panel', () => {
    const session = scrapeCostSession(AFTER_A_TURN);
    expect(session?.rows).toEqual(
      expect.arrayContaining([
        { label: 'Total cost', value: '$0.0246', nested: false },
        { label: 'Total duration (API)', value: '3s', nested: false },
        { label: 'Total duration (wall)', value: '8s', nested: false },
        { label: 'Total code changes', value: '0 lines added, 0 lines removed', nested: false },
      ]),
    );
  });

  it('nests the per-model rows under their heading and keeps them in order', () => {
    const rows = scrapeCostSession(AFTER_A_TURN)!.rows;
    const heading = rows.findIndex((r) => r.label === 'Usage by model');
    expect(rows[heading].value).toBe('');
    expect(rows[heading + 1]).toEqual({
      label: 'claude-haiku-4-5',
      value: '1.8k input, 63 output, 26.3k cache read, 9.9k cache write ($0.0246)',
      nested: true,
    });
    // The row after the models is back at field indent, not swept up as one.
    expect(rows[heading + 2].nested).toBe(false);
  });

  it('rejoins a value the panel wrapped onto the next line', () => {
    const cache = scrapeCostSession(AFTER_A_TURN)!.rows.find((r) => r.label === 'Prompt cache (main)');
    expect(cache?.value).toBe(
      '1 request · 73% of input tokens from cache · no misses · warm (1h TTL, last activity 4s ago)',
    );
  });

  it('stops at the limits view rather than swallowing it', () => {
    const labels = scrapeCostSession(AFTER_A_TURN)!.rows.map((r) => r.label);
    expect(labels).not.toContain('Current session');
    expect(labels.join(' ')).not.toContain('Resets');
  });

  it('handles the flat Usage row a session that has spent nothing gets', () => {
    const rows = scrapeCostSession(UNTOUCHED_SESSION)!.rows;
    expect(rows).toContainEqual({
      label: 'Usage',
      value: '0 input, 0 output, 0 cache read, 0 cache write',
      nested: false,
    });
    expect(rows.some((r) => r.nested)).toBe(false);
  });

  it('returns null when no overlay is on screen', () => {
    expect(scrapeCostSession(SCROLLBACK)).toBeNull();
  });

  it('returns null when the overlay is showing some other panel', () => {
    const tasks = [SCROLLBACK, RULE, '   Background', '   2 active shells'].join('\n');
    expect(scrapeCostSession(tasks)).toBeNull();
  });

  it('will not reach past the panel header to find a Session heading', () => {
    // A stale overlay whose numbers are minutes old is worse than none — the
    // heading has to sit where the real layout puts it.
    const far = [SCROLLBACK, RULE, ...Array(10).fill('   filler'), '   Session', '   Total cost: $9.99'].join('\n');
    expect(scrapeCostSession(far)).toBeNull();
  });

  it('rejects a panel with no totals in it, whatever else matched', () => {
    const noTotals = [SCROLLBACK, RULE, '   x', '', '   Session', '', '   Whatever:  1'].join('\n');
    expect(scrapeCostSession(noTotals)).toBeNull();
  });

  it('reads the newest overlay when scrollback holds an older one', () => {
    const stale = [
      SCROLLBACK, RULE, '   Settings', '', '   Session', '', '   Total cost:  $1.11',
      '', '❯ ', '',
      RULE, '   Settings', '', '   Session', '', '   Total cost:  $2.22',
    ].join('\n');
    expect(scrapeCostSession(stale)!.rows[0].value).toBe('$2.22');
  });
});
