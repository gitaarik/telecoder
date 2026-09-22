import { describe, it, expect } from 'vitest';
import {
  optionLetter,
  letteredOptionLines,
  buildLetteredKeyboard,
} from '../../src/telegram/lettered-options.js';

describe('optionLetter', () => {
  it('keys the first options A, B, C', () => {
    expect([0, 1, 2].map(optionLetter)).toEqual(['A', 'B', 'C']);
  });

  it('falls back to a number past Z', () => {
    expect(optionLetter(26)).toBe('27');
  });
});

describe('letteredOptionLines', () => {
  it('writes one line per option, keyed by letter', () => {
    expect(letteredOptionLines([{ label: 'Left' }, { label: 'Right' }])).toEqual([
      'A. Left',
      'B. Right',
    ]);
  });

  it('appends a description to the option that carries one', () => {
    expect(letteredOptionLines([{ label: 'Left', description: 'first' }, { label: 'Right' }])).toEqual([
      'A. Left — first',
      'B. Right',
    ]);
  });

  it('flattens a label that spans lines, so one option stays one line', () => {
    const lines = letteredOptionLines([{ label: 'telecoder\n· resume\tbuttons', description: '2h\nago' }]);
    expect(lines).toEqual(['A. telecoder · resume buttons — 2h ago']);
  });
});

describe('buildLetteredKeyboard', () => {
  it('keeps short labels on their own buttons, one per row', () => {
    expect(
      buildLetteredKeyboard([
        { label: 'Yes', callbackData: 'x:0' },
        { label: 'No', callbackData: 'x:1' },
      ]),
    ).toEqual([
      [{ text: 'A · Yes', callback_data: 'x:0' }],
      [{ text: 'B · No', callback_data: 'x:1' }],
    ]);
  });

  it('drops the whole keyboard to bare letters when any label is too wide', () => {
    expect(
      buildLetteredKeyboard([
        { label: 'Yes', callbackData: 'x:0' },
        { label: 'Rewrite the readiness check to poll the cursor row', callbackData: 'x:1' },
      ]),
    ).toEqual([
      [
        { text: 'A', callback_data: 'x:0' },
        { text: 'B', callback_data: 'x:1' },
      ],
    ]);
  });

  it('packs letter buttons four to a row, keeping each option its callback', () => {
    const options = Array.from({ length: 6 }, (_, i) => ({
      label: `Option ${i} with a label far too wide for a button`,
      callbackData: `resume:conv-${i}`,
    }));
    const keyboard = buildLetteredKeyboard(options);
    expect(keyboard.map((row) => row.map((b) => b.text))).toEqual([
      ['A', 'B', 'C', 'D'],
      ['E', 'F'],
    ]);
    expect(keyboard[1][1].callback_data).toBe('resume:conv-5');
  });

  it('keeps a label that lands exactly on the width budget', () => {
    // 'A · ' + 26 chars = 30, the maximum a button is allowed to render.
    const label = 'x'.repeat(26);
    const fits = buildLetteredKeyboard([{ label, callbackData: 'a' }, { label: 'No', callbackData: 'b' }]);
    expect(fits[0][0].text).toBe(`A · ${label}`);
    const over = buildLetteredKeyboard([{ label: label + 'x', callbackData: 'a' }, { label: 'No', callbackData: 'b' }]);
    expect(over[0][0].text).toBe('A');
  });

  it('measures the label as it renders, not the whitespace it arrived with', () => {
    // 26 visible chars once the trailing newlines go — exactly the budget.
    const label = 'x'.repeat(26) + '\n\n\n';
    expect(buildLetteredKeyboard([{ label, callbackData: 'a' }])[0][0].text).toBe(`A · ${'x'.repeat(26)}`);
  });
});
