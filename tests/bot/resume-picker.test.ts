import { describe, it, expect } from 'vitest';
import { buildResumePicker, type PickerEntry } from '../../src/bot/handlers/command/resume.js';

const NOW = Date.now();
const HOUR = 3600_000;
const entry = (sessionId: string, name: string, hoursAgo: number, marks: string[] = []): PickerEntry =>
  ({ sessionId, name, mtimeMs: NOW - hoursAgo * HOUR, marks });

describe('buildResumePicker', () => {
  it('writes every session into the body, keyed by letter, with its age and marks', () => {
    const { text } = buildResumePicker({
      heading: 'Sessions in telecoder',
      entries: [entry('id-1', 'Resume picker', 2, ['current']), entry('id-2', 'Status line', 5, ['open elsewhere', 'via CCR'])],
    });
    expect(text.text).toBe(
      '📜 Sessions in telecoder\n\nA. Resume picker — 2h ago · current\nB. Status line — 5h ago · open elsewhere · via CCR',
    );
    expect(text.entities).toEqual([{ type: 'bold', offset: 3, length: 'Sessions in telecoder'.length }]);
  });

  it('points each button at the session on the same letter, by Claude session id', () => {
    const { keyboard } = buildResumePicker({
      heading: 'h',
      entries: [entry('11111111-1111-1111-1111-111111111111', 'a', 1), entry('22222222-2222-2222-2222-222222222222', 'b', 1)],
    });
    expect(keyboard).toEqual([
      [{ text: 'A · a', callback_data: 'resume:s:11111111-1111-1111-1111-111111111111' }],
      [{ text: 'B · b', callback_data: 'resume:s:22222222-2222-2222-2222-222222222222' }],
    ]);
    // Telegram's cap on callback data.
    for (const row of keyboard) for (const b of row) expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
  });

  it('pages both ways and toggles the scope', () => {
    const { text, keyboard } = buildResumePicker({
      heading: 'h',
      entries: [entry('x', 'a', 1)],
      paging: { scope: 'p', page: 1, more: true },
      toggle: { label: '🌐 All projects', scope: 'a' },
    });
    expect(text.text).toContain('Page 2');
    expect(keyboard.slice(-2)).toEqual([
      [
        { text: '◀ Newer', callback_data: 'resume:l:p:0' },
        { text: 'Older ▶', callback_data: 'resume:l:p:2' },
      ],
      [{ text: '🌐 All projects', callback_data: 'resume:l:a:0' }],
    ]);
  });

  it('leaves the page number and arrows off a list that fits one page', () => {
    const { text, keyboard } = buildResumePicker({
      heading: 'h',
      entries: [entry('x', 'a', 1)],
      paging: { scope: 'a', page: 0, more: false },
    });
    expect(text.text).not.toContain('Page');
    expect(keyboard).toEqual([[{ text: 'A · a', callback_data: 'resume:s:x' }]]);
  });
});
