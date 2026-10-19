import { describe, it, expect } from 'vitest';
import headless from '@xterm/headless';
import { inputBoxHolds, inputBoxText, newPastePlaceholder, pastePlaceholderIds } from '../../src/claude/tui-state.js';

const { Terminal } = headless;

/**
 * The reader behind echo-verify, driven against a real xterm buffer at the pty
 * provider's own geometry.
 *
 * Every other test of this check builds its screen out of a string literal, and
 * that is exactly what let three rounds of it ship broken: a literal screen has
 * no capacity, so it never evicts, and eviction is the whole failure. Once the
 * 1000 scrollback rows are full, each row the TUI draws pushes one off the top —
 * so a tally of the needle across the whole screen can hold flat, or fall, while
 * the prompt sits plainly in the input box. The check read that as "the paste
 * never landed", retried twice, poisoned its own baseline a little more each
 * time, and told the user nothing had been sent.
 */
const COLS = 120;
const ROWS = 40;
const SCROLLBACK = 1000;
const SEP = '─'.repeat(COLS);

/** `PtyProvider._getScreenText`, verbatim — scrollback included, as it reads. */
function screenText(term: headless.Terminal): string {
  const buffer = term.buffer.active;
  let text = '';
  for (let i = 0; i < buffer.length; i++) {
    text += buffer.getLine(i)?.translateToString(true) + '\n';
  }
  return text.replace(/\n+$/, '');
}

function write(term: headless.Terminal, data: string): Promise<void> {
  return new Promise<void>((resolve) => term.write(data, resolve));
}

/** How many times `needle` appears in `haystack` — the discarded check. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) count++;
  return count;
}

/**
 * A session that has run long enough to fill the scrollback, on a subject that
 * leaves the needle in the transcript. Nothing exotic: that is what asking
 * "push" after a turn that ended "Not pushed yet" looks like, which is the pair
 * that took two turns off TeleCoder 4.
 */
async function saturatedSession(): Promise<headless.Terminal> {
  const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: SCROLLBACK, allowProposedApi: true });
  for (let i = 0; i < 1200; i++) {
    await write(term, i % 7 === 0
      ? `  ${i} · not pushed yet, say the word\r\n`
      : `  ${i} · ordinary transcript line\r\n`);
  }
  return term;
}

/** Draw the input box holding `typed`, the way claude redraws it on a paste. */
function drawBox(term: headless.Terminal, typed: string): Promise<void> {
  return write(term, [
    SEP,
    `❯ ${typed}`,
    SEP,
    '  ⏵⏵ auto mode on (shift+tab to cycle)                    Ctrl+Y to paste deleted text',
    '',
  ].join('\r\n'));
}

describe('echo-verify on a saturated buffer', () => {
  it('sees a prompt the whole-screen tally cannot', async () => {
    const term = await saturatedSession();
    expect(term.buffer.active.length).toBe(SCROLLBACK + ROWS);

    const before = screenText(term);
    const needlesBefore = countOccurrences(before, 'push');
    expect(needlesBefore).toBeGreaterThan(0);

    await drawBox(term, 'push');
    const after = screenText(term);

    // What the user saw in the screen dump: the prompt, in the box, waiting.
    expect(inputBoxText(after)).toContain('push');
    // What the old check asked, and why it could only ever answer no. Drawing
    // the box added an occurrence and evicted at least one, so the tally never
    // rises above the baseline it was compared against.
    expect(countOccurrences(after, 'push')).toBeLessThanOrEqual(needlesBefore);
  });

  it('does not get more findable as the retries redraw the box', async () => {
    // The retry loop clears the box and writes again, and each redraw scrolls
    // another copy of the box into the scrollback. Under the old check that
    // inflated the baseline every attempt; the box reader is indifferent to it.
    const term = await saturatedSession();
    for (let attempt = 0; attempt < 3; attempt++) {
      await drawBox(term, 'push');
      expect(inputBoxText(screenText(term))).toContain('push');
    }
  });

  it('reads a submitted prompt as gone from the box, not as still waiting', async () => {
    // Claude redraws a submitted prompt into the transcript, where it stays for
    // the rest of the session. A whole-screen search finds it there forever and
    // keeps firing Enter at a session that took it long ago.
    const term = await saturatedSession();
    await drawBox(term, 'push');
    await write(term, ['❯ push', '● Pushing now.', ''].join('\r\n'));
    await drawBox(term, '');

    const after = screenText(term);
    expect(after).toContain('❯ push');
    expect(inputBoxText(after)).not.toContain('push');
  });

  it('still claims a collapsed paste by its id', async () => {
    // The other half of the check, which the scrollback does not break: ids are
    // minted in increasing order, so one the baseline has not seen is ours.
    const term = await saturatedSession();
    await drawBox(term, '[Pasted text #4 +2 lines]');
    const known = pastePlaceholderIds(screenText(term));

    await drawBox(term, '[Image #7] [Pasted text #9 +7 lines]');
    const mine = newPastePlaceholder(known, screenText(term));

    expect(mine).toEqual({ id: 9, lines: 7 });
  });

  it('reports no box at all while an overlay has replaced it', async () => {
    // Undefined, not empty: the caller is deciding whether to send \r, and an
    // overlay is the one thing that must never receive it.
    const term = await saturatedSession();
    await write(term, [
      '  Select model',
      '  ❯ 1. Default (recommended) ✔  Opus 5',
      '    2. Opus (1M context)',
      '  Enter to set as default · Esc to cancel',
      '',
    ].join('\r\n'));

    expect(inputBoxText(screenText(term))).toBeUndefined();
  });
});

describe('echo-verify on a prompt the box wrapped', () => {
  // The message that could not be sent to TeleCoder 6, three times in a row.
  // Its first 24 characters run into a URL too long for the rest of the row,
  // so claude moves the whole URL down a row and the needle straddles the break.
  const URL = 'https://evallab.rikwanders.tech/t/10-16-compare-two-code-reviews-compare-reviews-of-example-ch11-p';
  const NEEDLE = "I'm about to submit http";

  /** The box exactly as a live 120x40 pty drew that paste. */
  function drawWrappedBox(term: headless.Terminal, firstRow: string): Promise<void> {
    return write(term, [
      SEP,
      `❯ ${firstRow}`,
      `  ${URL} do a final check`,
      SEP,
      '  ⏵⏵ auto mode on (shift+tab to cycle)                    Ctrl+Y to paste deleted text',
      '',
    ].join('\r\n'));
  }

  it('finds the needle across the row break', async () => {
    const term = await saturatedSession();
    await drawWrappedBox(term, "I'm about to submit");
    const screen = screenText(term);

    // The old check: the words are on screen, but not in one piece.
    expect(inputBoxText(screen)).not.toContain(NEEDLE);
    expect(inputBoxHolds(screen, NEEDLE)).toBe(true);
  });

  it('finds it in a side-bordered box too', async () => {
    const term = await saturatedSession();
    await write(term, [
      `╭${'─'.repeat(COLS - 2)}╮`,
      `│ ❯ I'm about to submit${' '.repeat(COLS - 24)}│`,
      `│   ${URL}${' '.repeat(COLS - URL.length - 5)}│`,
      `╰${'─'.repeat(COLS - 2)}╯`,
      '',
    ].join('\r\n'));

    expect(inputBoxHolds(screenText(term), NEEDLE)).toBe(true);
  });

  it('does not find a prompt the box does not hold', async () => {
    const term = await saturatedSession();
    await drawWrappedBox(term, "I'm about to send");

    expect(inputBoxHolds(screenText(term), NEEDLE)).toBe(false);
  });

  it('does not find a prompt that is only in the transcript', async () => {
    const term = await saturatedSession();
    await write(term, [`❯ I'm about to submit ${URL}`, '● Submitted.', ''].join('\r\n'));
    await drawBox(term, '');

    expect(inputBoxHolds(screenText(term), NEEDLE)).toBe(false);
  });

  it('reports no box at all as not holding it', async () => {
    const term = await saturatedSession();
    expect(inputBoxHolds(screenText(term), NEEDLE)).toBe(false);
  });
});
