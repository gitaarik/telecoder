import { describe, it, expect } from 'vitest';
import headless from '@xterm/headless';
import { scrapeTip } from '../../src/claude/tip-scraper.js';

const { Terminal } = headless;

/** Build a headless xterm, write the given lines, return it for scraping. */
async function render(lines: string[]): Promise<headless.Terminal> {
  const term = new Terminal({ cols: 120, rows: 40, scrollback: 1000, allowProposedApi: true });
  const data = lines.join('\r\n');
  await new Promise<void>((resolve) => term.write(data, resolve));
  return term;
}

describe('scrapeTip', () => {
  it('extracts a single-line spinner tip', async () => {
    const term = await render([
      '● Reading file…',
      '',
      '✶ Percolating… (29s)',
      '  ⎿  Tip: run /code-review ultra (no number) to review your current branch instead.',
      '',
      '╭──────────────────────────────────╮',
      '│ ❯                                │',
      '╰──────────────────────────────────╯',
    ]);
    expect(scrapeTip(term)).toBe('run /code-review ultra (no number) to review your current branch instead.');
  });

  it('joins a wrapped continuation line (e.g. a /plugin install command)', async () => {
    const term = await render([
      '✶ Brewing… (12s)',
      '  ⎿  Tip: Working with HTML/CSS? Install the frontend-design plugin:',
      '         /plugin install frontend-design@claude-plugins-official',
      '',
      '╭──────────────────────────────────╮',
      '│ ❯                                │',
      '╰──────────────────────────────────╯',
    ]);
    expect(scrapeTip(term)).toBe(
      'Working with HTML/CSS? Install the frontend-design plugin: /plugin install frontend-design@claude-plugins-official',
    );
  });

  it('returns null when no tip is on screen', async () => {
    const term = await render([
      '✶ Percolating… (3s)',
      '',
      '╭──────────────────────────────────╮',
      '│ ❯                                │',
      '╰──────────────────────────────────╯',
    ]);
    expect(scrapeTip(term)).toBeNull();
  });

  it('ignores the startup update-banner tip in scrollback (no ⎿ connector, far from bottom)', async () => {
    const lines = [
      'Tip: For more frequent updates, use the claude-code@latest cask:',
      '     brew upgrade claude-code',
    ];
    // Push it well above the live bottom rows.
    for (let i = 0; i < 30; i++) lines.push(`● step ${i}`);
    lines.push('✶ Percolating… (1s)');
    lines.push('╭──────────────────────────────────╮');
    lines.push('│ ❯                                │');
    lines.push('╰──────────────────────────────────╯');
    const term = await render(lines);
    expect(scrapeTip(term)).toBeNull();
  });
});
