import { describe, it, expect } from 'vitest';
import { scrapeTasksOverlay, parseTaskRows, parseTaskDetail } from '../../src/claude/tasks-overlay-scraper.js';

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

// From claude 2.1.311, where the overlay's rule is the input box's `─` and the
// rows carry a bullet and a status column. Captured live at 120 cols.
const THIN_RULE = '─'.repeat(120);

const LIST_VIEW_311 = [
  SCROLLBACK,
  '❯ /tasks',
  '',
  THIN_RULE,
  '  Background',
  '  4 active shells',
  '',
  '  ❯ ● Wait for background sleep 100 to finish              running',
  '    ● sleep 100                                            running',
  '    ● sleep 150                                            running',
  '    ● for i in $(seq 1 40); do echo "line $i"; sleep 2;…   running',
  '',
  '      Earlier in this session (0)',
  '',
  '  ↑/↓ to select · Enter to view · x to stop · Esc to close',
].join('\n');

const DETAIL_VIEW_311 = [
  SCROLLBACK,
  '❯ /tasks',
  '',
  THIN_RULE,
  '  Shell details',
  '',
  '  Status:   running',
  '  Runtime:  22s',
  '  Command:  for i in $(seq 1 40); do echo "line $i"; sleep 2; done',
  '',
  '  Output:',
  '  ╭' + '─'.repeat(112) + '╮',
  '  │ line 4' + ' '.repeat(105) + '│',
  '  │ line 5' + ' '.repeat(105) + '│',
  '  │ line 6' + ' '.repeat(105) + '│',
  '  │' + ' '.repeat(112) + '│',
  '  ╰' + '─'.repeat(112) + '╯',
  '  Showing 3 lines',
  '',
  '  ← to go back · Esc/Enter/Space to close · x to stop',
].join('\n');

const NO_OUTPUT_DETAIL_311 = [
  SCROLLBACK,
  THIN_RULE,
  '  Shell details',
  '',
  '  Status:   running',
  '  Runtime:  17s',
  '  Command:  sleep 100',
  '',
  '  Output:',
  '  No output available',
  '',
  '  ← to go back · Esc/Enter/Space to close · x to stop',
].join('\n');

// The closed state on 2.1.311: the overlay gone, the input box back, and the
// status lines plus an agents pane under its lower rule.
const NO_OVERLAY_311 = [
  SCROLLBACK,
  '❯ /tasks ',
  '  ⎿  Shell details dismissed',
  '',
  THIN_RULE,
  '❯ ',
  THIN_RULE,
  '  ⏵⏵ auto mode on · 3 shells · ↓ to manage                           ◐ medium · /effort',
  '',
  '  ● main',
  '  ◯ general-purpose  count to fifty slowly                              10s · ↓ 32.0k tokens',
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

describe('scrapeTasksOverlay on 2.1.311, whose rule is the input box glyph', () => {
  it('reads the list under a ─ rule', () => {
    const result = scrapeTasksOverlay(LIST_VIEW_311);
    expect(result).not.toBeNull();
    expect(result!.empty).toBe(false);
    expect(result!.text).toContain('4 active shells');
    expect(result!.text).toContain('● sleep 150');
    expect(result!.text).not.toContain('to close');
    expect(result!.text).not.toContain('Crunched for');
  });

  it('reads a detail view and keeps its output box', () => {
    const result = scrapeTasksOverlay(DETAIL_VIEW_311);
    expect(result!.text).toContain('Shell details');
    expect(result!.text).toContain('│ line 4');
  });

  it('does not take the closed input box and its status lines for an overlay', () => {
    expect(scrapeTasksOverlay(NO_OVERLAY_311)).toBeNull();
  });
});

describe('parseTaskRows', () => {
  it('lists the rows in screen order with their status', () => {
    const rows = parseTaskRows(scrapeTasksOverlay(LIST_VIEW_311)!.text);
    expect(rows.map((r) => r.label)).toEqual([
      'Wait for background sleep 100 to finish',
      'sleep 100',
      'sleep 150',
      'for i in $(seq 1 40); do echo "line $i"; sleep 2;',
    ]);
    expect(rows.every((r) => r.status === 'running')).toBe(true);
  });

  it('marks a label the column cut short', () => {
    const rows = parseTaskRows(scrapeTasksOverlay(LIST_VIEW_311)!.text);
    expect(rows.map((r) => r.truncated)).toEqual([false, false, false, true]);
  });

  it('skips the section heading, which has no bullet', () => {
    const rows = parseTaskRows(scrapeTasksOverlay(LIST_VIEW_311)!.text);
    expect(rows.some((r) => r.label.includes('Earlier in this session'))).toBe(false);
  });

  it('finds no rows in a detail view or the old bullet-less layout', () => {
    expect(parseTaskRows(scrapeTasksOverlay(DETAIL_VIEW_311)!.text)).toEqual([]);
    expect(parseTaskRows(scrapeTasksOverlay(LIST_VIEW)!.text)).toEqual([]);
  });
});

describe('parseTaskDetail', () => {
  it('returns null for the list', () => {
    expect(parseTaskDetail(scrapeTasksOverlay(LIST_VIEW_311)!.text)).toBeNull();
  });

  it('reads the fields and the output box, chrome stripped', () => {
    const detail = parseTaskDetail(scrapeTasksOverlay(DETAIL_VIEW_311)!.text)!;
    expect(detail.title).toBe('Shell details');
    expect(detail.fields).toEqual([
      { label: 'Status', value: 'running' },
      { label: 'Runtime', value: '22s' },
      { label: 'Command', value: 'for i in $(seq 1 40); do echo "line $i"; sleep 2; done' },
    ]);
    expect(detail.output).toBe('line 4\nline 5\nline 6');
    expect(detail.note).toBe('Showing 3 lines');
  });

  it('reports no output as null rather than as the placeholder text', () => {
    const detail = parseTaskDetail(scrapeTasksOverlay(NO_OUTPUT_DETAIL_311)!.text)!;
    expect(detail.output).toBeNull();
    expect(detail.fields.find((f) => f.label === 'Command')?.value).toBe('sleep 100');
  });

  it('reads the 2.1.226 detail too', () => {
    const detail = parseTaskDetail(scrapeTasksOverlay(DETAIL_VIEW)!.text)!;
    expect(detail.fields.find((f) => f.label === 'Command')?.value).toBe('sleep 300');
    expect(detail.output).toBeNull();
  });
});
