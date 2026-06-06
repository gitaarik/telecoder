import { describe, it, expect } from 'vitest';
import { formatBashCommandBlock } from '../../src/telegram/terminal-renderer.js';

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
