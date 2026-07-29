import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordDeliveredProse,
  getDeliveredProse,
  clearDeliveredProse,
  stripDeliveredPrefix,
} from '../../src/claude/turn-prose.js';

describe('stripDeliveredPrefix', () => {
  it('returns the text unchanged when nothing has been delivered', () => {
    expect(stripDeliveredPrefix('Here is the answer.', undefined)).toBe('Here is the answer.');
    expect(stripDeliveredPrefix('Here is the answer.', '')).toBe('Here is the answer.');
  });

  it('drops the delivered prefix along with the record separator', () => {
    const delivered = 'I compared both options.';
    const full = 'I compared both options.\n\nGoing with the second one, here is why.';
    expect(stripDeliveredPrefix(full, delivered)).toBe('Going with the second one, here is why.');
  });

  it('returns empty when the whole turn was already delivered', () => {
    expect(stripDeliveredPrefix('All of it.', 'All of it.')).toBe('');
  });

  it('handles a second flush later in the same turn', () => {
    // First ask flushed "A", second flushed "A\n\nB"; end-of-turn adds C.
    const full = 'A\n\nB\n\nC';
    expect(stripDeliveredPrefix(full, 'A\n\nB')).toBe('C');
  });

  it('keeps everything when the turn text does not start with what we sent', () => {
    // Screen-scrape fallback, a compaction rewriting the log, a swapped
    // session: better to repeat a paragraph than to eat the reply.
    expect(stripDeliveredPrefix('A totally different reply.', 'I compared both options.'))
      .toBe('A totally different reply.');
  });

  it('preserves prose that merely shares a prefix with no record boundary', () => {
    // Cutting at a non-boundary match would behead the reply mid-sentence.
    expect(stripDeliveredPrefix('Rebase now, please', 'Rebase')).toBe('Rebase now, please');
    expect(stripDeliveredPrefix('Rebase\nnow', 'Rebase')).toBe('Rebase\nnow');
  });

  it('leaves empty turn text alone', () => {
    expect(stripDeliveredPrefix('', 'delivered')).toBe('');
  });
});

describe('delivered-prose registry', () => {
  beforeEach(() => {
    clearDeliveredProse('sess-1');
    clearDeliveredProse('sess-2');
  });

  it('starts empty and records the high-water mark', () => {
    expect(getDeliveredProse('sess-1')).toBeUndefined();
    recordDeliveredProse('sess-1', 'first chunk');
    expect(getDeliveredProse('sess-1')).toBe('first chunk');
    recordDeliveredProse('sess-1', 'first chunk\n\nsecond chunk');
    expect(getDeliveredProse('sess-1')).toBe('first chunk\n\nsecond chunk');
  });

  it('keeps sessions independent', () => {
    recordDeliveredProse('sess-1', 'one');
    expect(getDeliveredProse('sess-2')).toBeUndefined();
  });

  it('ignores an empty record so a blank flush cannot mask real prose', () => {
    recordDeliveredProse('sess-1', '');
    expect(getDeliveredProse('sess-1')).toBeUndefined();
  });

  it('clears so the next turn starts fresh', () => {
    recordDeliveredProse('sess-1', 'one');
    clearDeliveredProse('sess-1');
    expect(getDeliveredProse('sess-1')).toBeUndefined();
  });
});
