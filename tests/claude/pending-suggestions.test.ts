import { describe, it, expect } from 'vitest';
import { storeSuggestion, consumeSuggestion } from '../../src/claude/pending-suggestions.js';

describe('pending suggestions', () => {
  it('round-trips the text and session it was stored for', () => {
    const id = storeSuggestion('chat:1', 'run the tests');
    expect(consumeSuggestion(id)).toEqual({
      text: 'run the tests',
      sessionKey: 'chat:1',
      presentation: 'button',
    });
  });

  it('remembers that a suggestion was offered on a card', () => {
    const id = storeSuggestion('chat:1', 'a prompt too wide for a button', 'card');
    expect(consumeSuggestion(id)?.presentation).toBe('card');
  });

  it('is single-use, so a stale button cannot replay a prompt', () => {
    const id = storeSuggestion('chat:1', 'run the tests');
    consumeSuggestion(id);
    expect(consumeSuggestion(id)).toBeNull();
  });

  it('returns null for an id it never issued', () => {
    expect(consumeSuggestion('nope')).toBeNull();
  });
});
