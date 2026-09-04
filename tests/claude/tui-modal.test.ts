import { describe, it, expect } from 'vitest';
import { arrowsTo, keystrokeFor, parseKeyHints, parseModal } from '../../src/claude/tui-modal.js';

const SEP = '─'.repeat(120);

/** Renders copied from a live 120x40 pty running claude 2.1.259. */
const modelDialog = [
  '  ▝▝ ▝▝    /tmp/tc-nav-8FA7',
  '❯ /model',
  SEP,
  '  Select model',
  '  Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model names,',
  '  specify with --model.',
  '  ❯ 1. Default (recommended) ✔  Opus 5 with 1M context · Best for everyday, complex tasks',
  '    2. Opus (1M context)        Opus 5 with 1M context · Best for everyday, complex tasks',
  '    3. Fable                    Fable 5.1 · Most capable for your hardest and longest-running tasks',
  '    4. Sonnet                   Sonnet 5 · Efficient for routine tasks',
  '    5. Haiku                    Haiku 4.5 · Fastest for quick answers',
  '  ● High effort (default) ←/→ to adjust',
  '  Enter to set as default · s to use this session only · Esc to cancel',
].join('\n');

const tasksDialog = [
  '✻ Cogitated for 1s · done 9:11 PM',
  '❯ /tasks',
  SEP,
  '  Background',
  '  No tasks currently running',
  '  ↑/↓ to select · Enter to view · Esc to close',
].join('\n');

/**
 * The trust dialog, copied verbatim off a live pty in a git repo. Two things
 * about it break a parser written against `/model`: its rows carry no numbers,
 * and its cursor starts on the destructive one. Both were live bugs — the
 * unnumbered rows parsed as no options at all, which left the footer's
 * `Enter to confirm` as the only button, and confirming there exits claude.
 *
 * `--dangerously-skip-permissions` does not suppress it. Trust inherits from a
 * parent directory only up to a git root, so a repo under an already-trusted
 * tree still asks — which is why an early probe in a plain directory saw no
 * dialog and wrongly concluded there wasn't one.
 */
const trustDialog = [
  SEP,
  ' Accessing workspace:',
  ' /home/rik/dev/plainpost',
  ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source',
  " project, or work from your team). If not, take a moment to review what's in this folder first.",
  " Claude Code'll be able to read, edit, and execute files here.",
  ' Security guide',
  ' ❯ No, exit',
  '   Yes, I trust this folder',
  ' Enter to confirm · Esc to cancel',
].join('\n');

/**
 * An auto-mode dialog, copied verbatim off a live pty after asking claude to
 * `rm -rf` a file. Auto draws a richer dialog than the manual permission
 * prompt and it broke this parser in two places at once:
 *
 *   - a sentence of explanation hangs under each choice, indented past the
 *     rows, and a walk that stopped at the first of those found one option
 *     where there are five;
 *   - a rule sits between the numbered choices and the trailing one, and
 *     taking the *last* rule as the seam left a one-line body with no cursor.
 *
 * Between them the dialog parsed as zero options, which meant the only button
 * offered was the footer's bare `Enter to select` — and Enter here commits
 * "Back up, then delete", a row nobody was shown. Measured, not imagined: the
 * first live run of the new default pressed it.
 */
const autoDialog = [
  '● Bash(ls -la)',
  '     … +6 lines (ctrl+o to expand)',
  SEP,
  ' ☐ Delete file',
  '│ `keep.txt` is named "keep" and contains the text `important`. There\'s no git repo here, so deleting it is',
  '│ unrecoverable. Proceed?',
  '❯ 1. Back up, then delete',
  '     Copy keep.txt to the session scratchpad first, then run rm -rf keep.txt. Recoverable for this session.',
  '  2. Delete it',
  '     Run rm -rf keep.txt as-is. The file and its contents are gone permanently.',
  '  3. Cancel',
  '     Leave keep.txt untouched.',
  '  4. Type something.',
  SEP,
  '  5. Chat about this',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n');

const inputBox = [
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents                        ● high · /effort',
].join('\n');

describe('parseModal', () => {
  it('reads title, options and cursor off a select dialog', () => {
    const modal = parseModal(modelDialog);
    expect(modal?.title).toBe('Select model');
    expect(modal?.options.map((o) => o.number)).toEqual([1, 2, 3, 4, 5]);
    expect(modal?.options[0].label).toBe('Default (recommended) ✔ Opus 5 with 1M context…');
    expect(modal?.highlighted).toBe(0);
  });

  it('reads the trust dialog, whose rows carry no numbers', () => {
    const modal = parseModal(trustDialog);
    expect(modal?.title).toBe('Accessing workspace:');
    expect(modal?.options.map((o) => o.label)).toEqual(['No, exit', 'Yes, I trust this folder']);
    expect(modal?.options.every((o) => o.number === undefined)).toBe(true);
  });

  it('puts the trust dialog\'s cursor on the destructive row, where claude puts it', () => {
    // Not incidental: this is why offering the footer's bare "Enter to
    // confirm" was a bug. Confirming here exits.
    expect(parseModal(trustDialog)?.highlighted).toBe(0);
  });

  it('stops collecting rows at the blurb above and the footer below', () => {
    const modal = parseModal(trustDialog);
    expect(modal?.options).toHaveLength(2);
    expect(modal?.options.map((o) => o.label)).not.toContain('Security guide');
  });

  it('reads every row of an auto-mode dialog, descriptions and all', () => {
    const modal = parseModal(autoDialog);
    expect(modal?.title).toBe('☐ Delete file');
    expect(modal?.options.map((o) => o.number)).toEqual([1, 2, 3, 4, 5]);
    expect(modal?.options.map((o) => o.label)).toEqual([
      'Back up, then delete',
      'Delete it',
      'Cancel',
      'Type something.',
      'Chat about this',
    ]);
  });

  it('reaches past the rule auto draws inside its own list', () => {
    // "5. Chat about this" lives below that rule. Losing it is the mild
    // failure; losing the other four and offering a bare Enter is the bad one.
    expect(parseModal(autoDialog)?.options).toHaveLength(5);
  });

  it('puts auto\'s cursor on the first row, so the walk has a known start', () => {
    expect(parseModal(autoDialog)?.highlighted).toBe(0);
  });

  it('does not mistake an echoed command above the seam for a row', () => {
    // /tasks has no rows of its own and `❯ /tasks` sits above its seam wearing
    // the cursor glyph. Reaching past a seam is gated on the body being
    // numbered precisely so this one is left alone.
    const modal = parseModal(tasksDialog);
    expect(modal?.options).toEqual([]);
    expect(modal?.title).toBe('Background');
  });

  it('refuses a dialog with a cursor it could not resolve into rows', () => {
    // A screen we half-understand must produce no buttons, because the only
    // ones on offer would be footer keys acting on a row we never showed.
    expect(parseModal([
      SEP,
      '  Something unfamiliar ❯ inline, not a row',
      '  Enter to confirm · Esc to cancel',
    ].join('\n'))).toBeNull();
  });

  it('reads a dialog that offers no numbered rows', () => {
    const modal = parseModal(tasksDialog);
    expect(modal?.title).toBe('Background');
    expect(modal?.options).toEqual([]);
    expect(modal?.highlighted).toBe(-1);
    expect(modal?.hints.map((h) => h.key)).toEqual(['↑/↓', 'Enter', 'Esc']);
  });

  it('is null on an ordinary input box, whose footer is not key hints', () => {
    expect(parseModal(inputBox)).toBeNull();
  });

  it('is null on a screen with no footer at all', () => {
    expect(parseModal('● Loading conversation…')).toBeNull();
  });

  it('is null on a half-drawn dialog with a footer but no body', () => {
    expect(parseModal([SEP, '  Enter to confirm · Esc to cancel'].join('\n'))).toBeNull();
  });

  it('keeps the body verbatim so an unparsed dialog can still be shown', () => {
    expect(parseModal(trustDialog)?.body).toContain('/home/rik/dev/plainpost');
  });
});

describe('parseModal with chrome below the footer', () => {
  // The footer is not reliably the last line on screen. Claude draws its
  // status bar under a dialog, and every one of these made the parser answer
  // null — which the readiness loop reads as "a screen we cannot drive", so a
  // trust dialog timed out after 180s instead of arriving as two buttons.
  // @code_share1_bot went silent this way after a CLI update started asking
  // about a folder it had been running in for weeks.
  const below = [
    ['a status bar', '  ⏵⏵ bypass permissions on (shift+tab to cycle)'],
    ['a transcript warning', '  ⚠ Transcript saving is off — inherited marker'],
    ['a welcome notice', '  ✻ Welcome back! · /status'],
  ] as const;

  for (const [what, line] of below) {
    it(`still reads the dialog under ${what}`, () => {
      const modal = parseModal(`${trustDialog}\n${line}`);
      expect(modal, what).not.toBeNull();
      expect(modal!.options.map((o) => o.label)).toEqual(['No, exit', 'Yes, I trust this folder']);
      expect(modal!.hints.map((h) => h.key)).toEqual(['Enter', 'Esc']);
    });
  }

  it('reads it under several lines of chrome at once', () => {
    const modal = parseModal([trustDialog, ...below.map(([, l]) => l)].join('\n'));
    expect(modal).not.toBeNull();
    expect(modal!.options).toHaveLength(2);
  });

  it('does not reach past the bottom for a footer in the transcript', () => {
    // A hint line scrolled well above is chrome from an earlier dialog, not
    // this screen's footer. Treating it as one would parse the transcript
    // between them as selectable rows and offer buttons that press the wrong
    // thing — the failure mode the bounded search exists to prevent.
    const stale = [
      ' Enter to confirm · Esc to cancel',
      ...Array.from({ length: 6 }, (_, i) => `  some later output line ${i}`),
    ].join('\n');
    expect(parseModal(stale)).toBeNull();
  });

  it('is unbothered by trailing blank lines', () => {
    expect(parseModal(`${trustDialog}\n\n\n`)).not.toBeNull();
  });
});

describe('parseKeyHints', () => {
  it('splits a footer into its affordances', () => {
    expect(parseKeyHints('Enter to set as default · s to use this session only · Esc to cancel'))
      .toEqual([
        { key: 'Enter', action: 'set as default' },
        { key: 's', action: 'use this session only' },
        { key: 'Esc', action: 'cancel' },
      ]);
  });

  it('keeps what Esc actually does, which is not always cancel', () => {
    // /config: Esc empties the filter and leaves the dialog open.
    expect(parseKeyHints('Type to filter · Enter/↓ to select · ↑ to tabs · Esc to clear'))
      .toContainEqual({ key: 'Esc', action: 'clear' });
  });

  it('is empty for prose that merely contains the word "to"', () => {
    expect(parseKeyHints('Switch between Claude models to change the default')).toEqual([]);
  });
});

describe('arrowsTo', () => {
  it('walks down to a later row', () => {
    const modal = parseModal(modelDialog)!;
    expect(arrowsTo(modal, 2)).toEqual(['\x1b[B', '\x1b[B']);
  });

  it('walks up to an earlier row', () => {
    const modal = { ...parseModal(modelDialog)!, highlighted: 3 };
    expect(arrowsTo(modal, 1)).toEqual(['\x1b[A', '\x1b[A']);
  });

  it('sends nothing when the cursor is already there', () => {
    expect(arrowsTo(parseModal(modelDialog)!, 0)).toEqual([]);
  });

  it('refuses when the cursor position is unknown', () => {
    expect(arrowsTo(parseModal(tasksDialog)!, 0)).toBeNull();
  });

  it('refuses an index the dialog does not offer', () => {
    expect(arrowsTo(parseModal(modelDialog)!, 9)).toBeNull();
  });
});

describe('keystrokeFor', () => {
  it('maps the keys a dialog can be answered with', () => {
    expect(keystrokeFor('Enter')).toBe('\r');
    expect(keystrokeFor('Enter/↓')).toBe('\r');
    expect(keystrokeFor('Esc')).toBe('\x1b');
    expect(keystrokeFor('s')).toBe('s');
  });

  it('refuses navigation affordances, which answer nothing', () => {
    expect(keystrokeFor('↑/↓')).toBeNull();
    expect(keystrokeFor('←/→')).toBeNull();
    expect(keystrokeFor('/')).toBeNull();
  });
});
