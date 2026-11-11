import { describe, it, expect } from 'vitest';
import {
  SUGGESTION_CARD_BUTTON,
  buildSuggestionCardText,
  flattenSuggestion,
  formatSuggestionLabel,
  suggestionFitsOnButton,
} from '../../src/telegram/prompt-suggestion.js';
import { MAX_BUTTON_TEXT_LEN } from '../../src/telegram/button-text.js';

// A suggestion is scraped from one row of a 120-column terminal, so this is
// roughly the widest one that can reach us — and the case the old truncating
// label lost two thirds of.
const LONG = 'Run the full test suite and fix whatever fails in the PTY provider before touching the docs';

describe('flattenSuggestion', () => {
  it('collapses whitespace so what is shown is what gets sent', () => {
    expect(flattenSuggestion('  run   the\ttests \n')).toBe('run the tests');
  });

  it('is empty for blank ghost text', () => {
    expect(flattenSuggestion('   ')).toBe('');
  });
});

describe('formatSuggestionLabel', () => {
  it('carries the whole suggestion — never an ellipsis', () => {
    expect(formatSuggestionLabel('run the tests')).toBe('💡 run the tests');
  });

  it('does not truncate even a long one; the fit check is what gates it', () => {
    expect(formatSuggestionLabel(LONG)).toContain('touching the docs');
    expect(formatSuggestionLabel(LONG)).not.toContain('…');
  });
});

describe('suggestionFitsOnButton', () => {
  it('accepts a short suggestion', () => {
    expect(suggestionFitsOnButton('run the tests')).toBe(true);
  });

  it('rejects one Telegram would clip', () => {
    expect(suggestionFitsOnButton(LONG)).toBe(false);
  });

  it('counts the bulb prefix against the button width', () => {
    // '💡 ' is 3 UTF-16 units, so the widest suggestion that still fits is
    // three short of the button limit — one char more and it needs a card.
    const widest = 'x'.repeat(MAX_BUTTON_TEXT_LEN - 3);
    expect(formatSuggestionLabel(widest).length).toBe(MAX_BUTTON_TEXT_LEN);
    expect(suggestionFitsOnButton(widest)).toBe(true);
    expect(suggestionFitsOnButton(widest + 'x')).toBe(false);
  });
});

describe('buildSuggestionCardText', () => {
  const italic = (text: string, offset: number) => [{ type: 'italic', offset, length: text.length - offset }];

  it('puts the full prompt in the body, where nothing clips it', () => {
    const card = buildSuggestionCardText(LONG);
    expect(card.text).toBe(`💡 Suggested next prompt:\n${LONG}`);
    expect(card.entities).toEqual(italic(card.text, '💡 Suggested next prompt:\n'.length));
  });

  it('keeps markdown specials in the prompt verbatim', () => {
    const card = buildSuggestionCardText('fix src/a-b.ts (the _slow_ one)');
    expect(card.text).toBe('💡 Suggested next prompt:\nfix src/a-b.ts (the _slow_ one)');
  });

  it('rewrites to a sent form that still shows the prompt', () => {
    const card = buildSuggestionCardText('run the tests', { sent: true });
    expect(card.text).toBe('✅ Sent:\nrun the tests');
    expect(card.entities).toEqual(italic(card.text, '✅ Sent:\n'.length));
  });

  it('flattens the same way the button label does', () => {
    expect(buildSuggestionCardText('run  the\ntests').text).toBe('💡 Suggested next prompt:\nrun the tests');
  });
});

describe('SUGGESTION_CARD_BUTTON', () => {
  it('is a fixed label short enough to survive the clip', () => {
    expect(SUGGESTION_CARD_BUTTON.length).toBeLessThanOrEqual(MAX_BUTTON_TEXT_LEN);
  });
});
