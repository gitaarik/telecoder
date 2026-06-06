import { describe, it, expect } from 'vitest';
import { formatBashCommandBlock, elideToolOutput } from '../../src/telegram/terminal-renderer.js';

describe('formatBashCommandBlock', () => {
  it('returns undefined for empty or whitespace-only input', () => {
    expect(formatBashCommandBlock(undefined, false)).toBeUndefined();
    expect(formatBashCommandBlock('', false)).toBeUndefined();
    expect(formatBashCommandBlock('   \n  ', false)).toBeUndefined();
  });

  it('preserves a short multi-line command in full (not just the first line)', () => {
    const cmd = 'cd /home/rik/dev/sjs-ops\nnpm run build';
    expect(formatBashCommandBlock(cmd, false)).toBe(cmd);
    expect(formatBashCommandBlock(cmd, true)).toBe(cmd);
  });

  it('trims surrounding whitespace', () => {
    expect(formatBashCommandBlock('  ls -la  ', false)).toBe('ls -la');
  });

  it('elides the middle of a long command in non-verbose mode, keeping head and tail', () => {
    const cmd = 'cd /srv/app && ' + 'x'.repeat(400) + ' && npm run build';
    const out = formatBashCommandBlock(cmd, false)!;
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out).toContain('…');
    // Leading setup and trailing work both survive the elision.
    expect(out).toContain('cd /srv/app');
    expect(out).toContain('npm run build');
  });

  it('keeps a 1KB command intact in verbose mode but caps it in non-verbose', () => {
    const cmd = 'echo start && ' + 'y'.repeat(1000) + ' && echo end';
    const verbose = formatBashCommandBlock(cmd, true)!;
    const compact = formatBashCommandBlock(cmd, false)!;
    expect(verbose).toBe(cmd); // under the 3500 failsafe ceiling
    expect(compact.length).toBeLessThanOrEqual(300);
    expect(compact).toContain('…');
  });

  it('applies the verbose failsafe ceiling so a huge command never breaks the Telegram edit', () => {
    const cmd = 'cat <<EOF > big.txt\n' + 'lorem ipsum '.repeat(1000) + '\nEOF';
    const out = formatBashCommandBlock(cmd, true)!;
    expect(out.length).toBeLessThanOrEqual(3500);
    expect(out).toContain('…');
    expect(out).toContain('cat <<EOF');
    expect(out).toContain('EOF');
  });
});

describe('elideToolOutput', () => {
  it('returns content unchanged when within both caps', () => {
    const out = 'line 1\nline 2\nline 3';
    expect(elideToolOutput(out, 20, 2000)).toBe(out);
  });

  it('keeps the TAIL of error output (failures live at the end)', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    lines[99] = '3 failing'; // the line you actually care about
    const out = elideToolOutput(lines.join('\n'), 20, 100000, { isError: true });
    expect(out).toContain('3 failing'); // tail survived — plain head truncation would drop it
    expect(out).toContain('line 1'); // some head context kept
    expect(out).toContain('more lines]'); // middle marker
    // Roughly respects the line budget (head + marker + tail).
    expect(out.split('\n').length).toBeLessThanOrEqual(20);
  });

  it('weights error output toward the tail — more trailing than leading lines', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `L${i + 1}`);
    const out = elideToolOutput(lines.join('\n'), 12, 100000, { isError: true }).split('\n');
    const kept = out.filter((l) => /^L\d+$/.test(l)).map((l) => Number(l.slice(1)));
    const headKept = kept.filter((n) => n <= 50).length;
    const tailKept = kept.filter((n) => n > 50).length;
    expect(tailKept).toBeGreaterThan(headKept);
  });

  it('weights successful output toward the HEAD — more leading than trailing lines', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `L${i + 1}`);
    const out = elideToolOutput(lines.join('\n'), 12, 100000).split('\n'); // default: success
    const kept = out.filter((l) => /^L\d+$/.test(l)).map((l) => Number(l.slice(1)));
    const headKept = kept.filter((n) => n <= 50).length;
    const tailKept = kept.filter((n) => n > 50).length;
    expect(headKept).toBeGreaterThan(tailKept);
    // ...but a trailing slice is still kept so a final summary line survives.
    expect(tailKept).toBeGreaterThan(0);
  });

  it('reports the correct hidden-line count', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `r${i}`);
    const out = elideToolOutput(lines.join('\n'), 10, 100000);
    // 30 total, keep head+tail = 9, marker line → 21 hidden (independent of bias).
    expect(out).toContain('[+21 more lines]');
  });

  it('char-caps a single very long error line toward the middle, preserving the tail', () => {
    const longLine = 'ERR_HEAD ' + 'x'.repeat(5000) + ' ERR_TAIL';
    const out = elideToolOutput(longLine, 20, 500, { isError: true });
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out).toContain('ERR_HEAD');
    expect(out).toContain('ERR_TAIL'); // tail of the line survives
    expect(out).toContain('chars truncated');
  });
});
