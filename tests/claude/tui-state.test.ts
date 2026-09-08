import { describe, it, expect } from 'vitest';
import {
  hasInputBox,
  inputBoxPastePlaceholders,
  isGenerating,
  newPastePlaceholder,
  pastePlaceholderIds,
  pastePlaceholders,
  screenSignature,
} from '../../src/claude/tui-state.js';

const SEP = '─'.repeat(120);

/**
 * The renders below are copied from a live 120x40 pty running claude through
 * a `sleep 25` tool call — the footer's hint is the only part that moves
 * between the working and settled states.
 */
const working = [
  '● I\'ll run that command.',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ← for agents     ● high · /effort',
  '                                                                                                  /rc',
].join('\n');

const settled = [
  '● Done — it printed done.',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents                        ● high · /effort',
  '                                                                                                  /rc',
].join('\n');

/** A tool the model backgrounded keeps running, but the turn itself is over. */
const backgroundShell = [
  '● Backgrounded the shell.',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on · 1 shell · ← for agents · ↓ to manage                                 /rc',
].join('\n');

describe('isGenerating', () => {
  it('reads the interrupt hint as a turn in flight', () => {
    expect(isGenerating(working)).toBe(true);
  });

  it('is false once the hint clears', () => {
    expect(isGenerating(settled)).toBe(false);
  });

  it('is false while only a backgrounded shell is left running', () => {
    expect(isGenerating(backgroundShell)).toBe(false);
  });

  it('reads a live spinner above the input box as a turn in flight', () => {
    expect(isGenerating([
      '✶ Percolating… (29s)',
      '  ⎿  Tip: run /code-review ultra to review your current branch.',
      SEP,
      '❯ ',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents                                /rc',
    ].join('\n'))).toBe(true);
  });

  it('does not read the completed-turn timer as a turn in flight', () => {
    expect(isGenerating([
      '● All set.',
      '✻ Brewed for 3m 5s',
      SEP,
      '❯ ',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents                                /rc',
    ].join('\n'))).toBe(false);
  });

  it('does not take an assistant message quoting the hint as chrome', () => {
    expect(isGenerating([
      '● The footer shows `esc to interrupt` while a turn is running.',
      SEP,
      '❯ ',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents                                /rc',
    ].join('\n'))).toBe(false);
  });

  it('ignores an interrupt hint scrolled up into the transcript', () => {
    const scrolled = [
      'esc to interrupt',
      ...Array.from({ length: 10 }, (_, i) => `● line ${i}`),
      SEP,
      '❯ ',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents                                /rc',
    ].join('\n');
    expect(isGenerating(scrolled)).toBe(false);
  });
});

describe('screenSignature', () => {
  it('is unchanged when only the spinner timer ticks', () => {
    const at = (secs: number) => [
      '● Reading file…',
      `✶ Percolating… (${secs}s)`,
      SEP,
      '❯ ',
    ].join('\n');
    expect(screenSignature(at(29))).toBe(screenSignature(at(30)));
  });

  it('changes when the transcript does', () => {
    const before = ['● Reading file…', '✶ Percolating… (29s)', '❯ '].join('\n');
    const after = ['● Reading file…', '● Writing file…', '✶ Percolating… (29s)', '❯ '].join('\n');
    expect(screenSignature(before)).not.toBe(screenSignature(after));
  });

  it('ignores trailing whitespace the TUI pads rows with', () => {
    expect(screenSignature('❯   \n')).toBe(screenSignature('❯\n'));
  });
});

/**
 * Overlay renders copied from a live 120x40 pty. Each is a real screen that
 * a bare `includes('❯')` reads as an open prompt, because the highlighted option
 * carries the same glyph the input box does.
 */
const modelOverlay = [
  '  ▝▝ ▝▝    /tmp/tc-nav-8FA7',
  '❯ /model',
  SEP,
  '  Select model',
  '  Switch between Claude models. Your pick becomes the default for new sessions.',
  '  ❯ 1. Default (recommended) ✔  Opus 5 with 1M context · Best for everyday, complex tasks',
  '    2. Opus (1M context)        Opus 5 with 1M context · Best for everyday, complex tasks',
  '    3. Fable                    Fable 5.1 · Most capable for your hardest tasks',
  '  Enter to set as default · s to use this session only · Esc to cancel',
].join('\n');

const tasksOverlay = [
  '✻ Cogitated for 1s · done 9:11 PM',
  '❯ /tasks',
  SEP,
  '  Background',
  '  No tasks currently running',
  '  ↑/↓ to select · Enter to view · Esc to close',
].join('\n');

const configOverlay = [
  '    Verbose output                             false',
  '    Default permission mode                    Manual',
  '  ↓ 22 more below',
  '  Type to filter · Enter/↓ to select · ↑ to tabs · Esc to clear',
].join('\n');

describe('hasInputBox', () => {
  it('accepts the box fenced by its two rules', () => {
    expect(hasInputBox(settled)).toBe(true);
  });

  it('accepts it mid-turn, when the footer carries the interrupt hint', () => {
    expect(hasInputBox(working)).toBe(true);
  });

  it('accepts the side-bordered render', () => {
    expect(hasInputBox('│ ❯ typed text                    │')).toBe(true);
  });

  it('rejects a select list whose highlighted option carries the glyph', () => {
    expect(modelOverlay.includes('❯')).toBe(true); // what we used to go on
    expect(hasInputBox(modelOverlay)).toBe(false);
  });

  it('rejects an overlay drawn under a single seam rule', () => {
    expect(tasksOverlay.includes('❯')).toBe(true);
    expect(hasInputBox(tasksOverlay)).toBe(false);
  });

  it('rejects a scrolled list with no rule near the bottom at all', () => {
    expect(hasInputBox(configOverlay)).toBe(false);
  });

  it('rejects a startup screen that has not drawn its box yet', () => {
    expect(hasInputBox('● Loading conversation…')).toBe(false);
  });

  it('ignores an input box scrolled up above an overlay', () => {
    // The box is real, but it is behind the overlay — a prompt written now
    // lands in the list, not the editor.
    expect(hasInputBox([
      SEP,
      '❯ ',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
      '❯ /model',
      SEP,
      '  Select model',
      '  ❯ 1. Default (recommended) ✔',
      '    2. Opus (1M context)',
      '    3. Fable',
      '    4. Sonnet',
      '    5. Haiku',
      '  Enter to set as default · Esc to cancel',
    ].join('\n'))).toBe(false);
  });

  it('is not fooled by a model quoting rules in its reply', () => {
    expect(hasInputBox([
      '● The box renders as:',
      '●   ──────────────────────',
      '●   ❯ your prompt',
      '●   ──────────────────────',
      '  Enter to confirm · Esc to cancel',
    ].join('\n'))).toBe(false);
  });
});

/**
 * The renders below are copied from a live 120x40 pty. Claude's editor drops a
 * pasted block that runs past 800 characters or two newlines and draws a
 * placeholder for it, so a photo-upload prompt — eleven lines of note plus the
 * staged image path — is never on screen as the text we wrote.
 */
describe('pastePlaceholders', () => {
  it('reads the id and line count of a collapsed paste', () => {
    expect(pastePlaceholders([
      SEP,
      '❯ [Pasted text #2 +10 lines]',
      SEP,
    ].join('\n'))).toEqual([{ id: 2, lines: 10 }]);
  });

  it('counts a paste with no newlines as zero lines', () => {
    // Over 800 characters but on one line: claude drops the "+N lines" half.
    expect(pastePlaceholders('❯ [Pasted text #1]')).toEqual([{ id: 1, lines: 0 }]);
  });

  it('finds stale frames in the scrollback as well as the live box', () => {
    // Submitting expands a placeholder back to its text, so the two above are
    // frames of the box that scrolled off rather than transcript entries —
    // which is exactly why a caller has to compare ids rather than trust a hit.
    expect(pastePlaceholders([
      '❯ [Pasted text #1 +10 lines]',
      '❯ [Pasted text #2 +5 lines]',
      '● Done.',
      SEP,
      '❯ [Pasted text #3 +10 lines]',
      SEP,
    ].join('\n'))).toEqual([
      { id: 1, lines: 10 },
      { id: 2, lines: 5 },
      { id: 3, lines: 10 },
    ]);
  });

  it('finds nothing on a screen with no pastes', () => {
    expect(pastePlaceholders(settled)).toEqual([]);
  });
});

describe('inputBoxPastePlaceholders', () => {
  it('takes the paste waiting in the box, not the ones already sent', () => {
    expect(inputBoxPastePlaceholders([
      '❯ [Pasted text #1 +10 lines]',
      '● Sure — that image is a screenshot of a stack trace.',
      SEP,
      '❯ [Pasted text #2 +10 lines]',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
    ].join('\n'))).toEqual([{ id: 2, lines: 10 }]);
  });

  it('is empty once the prompt has left the box', () => {
    // #1 is the frame the box scrolled off, not a prompt waiting to be sent.
    expect(inputBoxPastePlaceholders([
      '❯ [Pasted text #1 +10 lines]',
      '● Sure — that image is a screenshot of a stack trace.',
      SEP,
      '❯ ',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
    ].join('\n'))).toEqual([]);
  });

  it('does not read a scrolled-off frame above a short transcript as unsent', () => {
    // The whole screen fits in any window counted from the bottom, so only the
    // ❯ row itself separates the editor from what has already gone out.
    expect(inputBoxPastePlaceholders([
      '❯ [Pasted text #1 +10 lines]',
      '● Sure — that image is a screenshot of a stack trace.',
      SEP,
      '❯ ',
      SEP,
    ].join('\n'))).toEqual([]);
  });

  it('keeps a wrapped input that spills below the ❯ row', () => {
    expect(inputBoxPastePlaceholders([
      SEP,
      '❯ have a look at [Pasted text #4 +10 lines] and also at',
      '  [Pasted text #5 +12 lines] before you answer',
      SEP,
    ].join('\n'))).toEqual([{ id: 4, lines: 10 }, { id: 5, lines: 12 }]);
  });

  it('finds nothing while an overlay has replaced the box', () => {
    // The list marks its highlighted option with the box's own glyph, so the
    // rows that have to be rejected here are `❯` rows — an overlay carrying no
    // glyph at all would pass without proving anything. What separates them is
    // the rule above the box, which neither an option row nor the command that
    // opened the overlay has.
    expect(inputBoxPastePlaceholders([
      '  [Pasted text #1 +10 lines]',
      '❯ /model',
      SEP,
      '  Select model',
      '  ❯ 1. Default (recommended) ✔  Opus 5',
      '    2. Opus (1M context)',
      '  Enter to set as default · Esc to cancel',
    ].join('\n'))).toEqual([]);
  });
});

describe('newPastePlaceholder', () => {
  // The screen TeleCoder 4 logged when a photo upload gave up. The staged
  // prompt went in with 10 newlines; claude pulled the /tmp image path out
  // into a chip and drew what was left as "+7 lines".
  const failureScreen = [
    '─────────────────────────────────────────',
    '❯  [Image #7] [Image #8][Pasted text #9 +7 lines]',
    '─────────────────────────────────────────',
    '  paste again to expand      Ctrl+Y to paste deleted text',
  ].join('\n');

  it('claims a placeholder whose line count does not match what was written', () => {
    const before = pastePlaceholderIds('❯  [Image #7] [Image #8]');
    expect(newPastePlaceholder(before, failureScreen)).toEqual({ id: 9, lines: 7 });
  });

  it('ignores a placeholder that was already on screen', () => {
    const before = pastePlaceholderIds(failureScreen);
    expect(newPastePlaceholder(before, failureScreen)).toBeUndefined();
  });

  it('picks the new placeholder when an old one is still drawn', () => {
    const before = pastePlaceholderIds('❯  [Pasted text #3 +4 lines]');
    const after = '❯  [Pasted text #3 +4 lines] [Pasted text #4 +9 lines]';
    expect(newPastePlaceholder(before, after)).toEqual({ id: 4, lines: 9 });
  });

  it('treats an empty screen as having nothing known', () => {
    expect(pastePlaceholderIds('').size).toBe(0);
    expect(newPastePlaceholder(new Set(), failureScreen)).toEqual({ id: 9, lines: 7 });
  });
});
