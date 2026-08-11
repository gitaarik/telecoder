import { describe, it, expect } from 'vitest';
import { scrapeTasksOverlay } from '../../src/claude/tasks-overlay-scraper.js';

// Fixtures are the real renders captured from claude 2.1.226 in a pty at
// 120 cols, scrollback included, so the tests exercise the same scrollback
// rejection the live scraper faces.
const RULE = '▔'.repeat(120);

const SCROLLBACK = [
  '',
  '╭─── Claude Code v2.1.226 ─────────────────────────────────────────────╮',
  '│                  Welcome back Rik!                                   │',
  '╰──────────────────────────────────────────────────────────────────────╯',
  '',
  '❯ Use the Bash tool with run_in_background=true ...',
  '',
  '  Ran 1 shell command',
  '',
  '● Background task running: sleep 300 (ID: b6k6edeg0)',
  '',
  '✻ Crunched for 5s · 1 shell still running',
  '',
  '',
].join('\n');

const LIST_VIEW = [
  SCROLLBACK,
  RULE,
  '   Background',
  '   2 active shells',
  '',
  '   ❯ sleep 500 (running)',
  '     sleep 400 (running)',
  '',
  '   ↑/↓ to select · Enter to view · x to stop · Esc to close',
].join('\n');

const DETAIL_VIEW = [
  SCROLLBACK,
  RULE,
  '   Shell details',
  '',
  '   Status:   running',
  '   Runtime:  7s',
  '   Command:  sleep 300',
  '',
  '   Output:',
  '   No output available',
  '',
  '   ← to go back · Esc/Enter/Space to close · x to stop',
].join('\n');

const EMPTY_VIEW = [
  SCROLLBACK,
  RULE,
  '   Background',
  '',
  '   No tasks currently running',
  '',
  '   ↑/↓ to select · Enter to view · Esc to close',
].join('\n');

const NO_OVERLAY = [
  SCROLLBACK,
  '────────────────────────────────────────────────────────────────────────',
  '❯ ',
  '────────────────────────────────────────────────────────────────────────',
  '  ◇ Haiku 4.5  probe-tasks2                                         /rc',
  '  -- INSERT -- ⏵⏵ bypass permissions on · 1 shell · ← for agents',
].join('\n');

describe('scrapeTasksOverlay', () => {
  it('extracts the list view and drops the scrollback above it', () => {
    const result = scrapeTasksOverlay(LIST_VIEW);
    expect(result).not.toBeNull();
    expect(result!.empty).toBe(false);
    // The selected row keeps its alignment with the unselected one.
    expect(result!.text).toBe(
      'Background\n2 active shells\n\n  sleep 500 (running)\n  sleep 400 (running)',
    );
    // Nothing from above the rule leaks through.
    expect(result!.text).not.toContain('Welcome back');
    expect(result!.text).not.toContain('Crunched for');
  });

  it('drops the keyboard hint line, which means nothing over Telegram', () => {
    const result = scrapeTasksOverlay(LIST_VIEW);
    expect(result!.text).not.toContain('to close');
    expect(result!.text).not.toContain('↑/↓');
  });

  it('strips the selection caret so rows read uniformly', () => {
    const result = scrapeTasksOverlay(LIST_VIEW);
    expect(result!.text).not.toContain('❯');
  });

  it('extracts the single-task detail view claude opens instead of a list', () => {
    const result = scrapeTasksOverlay(DETAIL_VIEW);
    expect(result).not.toBeNull();
    expect(result!.empty).toBe(false);
    expect(result!.text).toContain('Shell details');
    expect(result!.text).toContain('Status:   running');
    expect(result!.text).toContain('Command:  sleep 300');
    expect(result!.text).not.toContain('to go back');
  });

  it('flags the idle case', () => {
    const result = scrapeTasksOverlay(EMPTY_VIEW);
    expect(result).not.toBeNull();
    expect(result!.empty).toBe(true);
    expect(result!.text).toContain('No tasks currently running');
  });

  it('returns null when no overlay is open', () => {
    expect(scrapeTasksOverlay(NO_OVERLAY)).toBeNull();
  });

  it('is not fooled by the input box separators, which use a different glyph', () => {
    // The TUI draws its own rules with ─ (U+2500); only the overlay uses ▔.
    expect(scrapeTasksOverlay('a\n' + '─'.repeat(120) + '\nb')).toBeNull();
  });

  it('returns null when the rule is there but the body is only chrome', () => {
    const body = [RULE, '', '   ↑/↓ to select · Esc to close', ''].join('\n');
    expect(scrapeTasksOverlay(body)).toBeNull();
  });

  it('takes the lowest rule when an earlier overlay is still in scrollback', () => {
    const stale = [
      RULE,
      '   Background',
      '   1 active shell',
      '   ↑/↓ to select · Esc to close',
      '',
      RULE,
      '   Background',
      '   3 active shells',
      '   ↑/↓ to select · Esc to close',
    ].join('\n');
    const result = scrapeTasksOverlay(stale);
    expect(result!.text).toContain('3 active shells');
    expect(result!.text).not.toContain('1 active shell');
  });

  it('treats an unfamiliar body as content rather than claiming nothing runs', () => {
    // A layout change should degrade to "here is what claude said", not to a
    // confident and wrong "nothing running".
    const odd = [RULE, '   Background', '   surprising new layout', ''].join('\n');
    const result = scrapeTasksOverlay(odd);
    expect(result!.empty).toBe(false);
    expect(result!.text).toContain('surprising new layout');
  });
});
