import { describe, it, expect } from 'vitest';
import { isGenerating, isPromptVisible, screenSignature } from '../../src/claude/tui-state.js';

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

describe('isPromptVisible', () => {
  it('finds the glyph inside the input box chrome', () => {
    expect(isPromptVisible('│ ❯ typed text                    │')).toBe(true);
  });

  it('is false on a screen without an input box', () => {
    expect(isPromptVisible('● Loading conversation…')).toBe(false);
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
