import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  MAX_WINDOW_MS,
  MIN_WINDOW_MS,
  DEFAULT_WINDOW_MS,
  alwaysPrompts,
  closeWindow,
  consumeAutoApproval,
  formatDuration,
  formatRemaining,
  getWindow,
  listAlwaysPrompted,
  openWindow,
  parseWindowDuration,
  resetAutoApprove,
} from '../../src/claude/auto-approve.js';

const CHAT = -1009990001;
const OTHER_CHAT = -1009990002;

function open(overrides: Partial<Parameters<typeof openWindow>[1]> = {}, chatId = CHAT) {
  return openWindow(chatId, {
    openedBy: 2,
    openedByName: 'Ann',
    durationMs: 30 * 60 * 1000,
    ...overrides,
  });
}

beforeEach(() => {
  resetAutoApprove();
});

afterEach(() => {
  resetAutoApprove();
  vi.useRealTimers();
});

describe('opening and closing a window', () => {
  it('starts closed', () => {
    expect(getWindow(CHAT)).toBeNull();
  });

  it('records who opened it and how long it runs', () => {
    const window = open({ durationMs: 10 * 60 * 1000 });
    expect(window.openedBy).toBe(2);
    expect(window.openedByName).toBe('Ann');
    expect(window.expiresAt - window.openedAt).toBe(10 * 60 * 1000);
    expect(getWindow(CHAT)).toBe(window);
  });

  it('is scoped to one chat', () => {
    open();
    expect(getWindow(OTHER_CHAT)).toBeNull();
    expect(consumeAutoApproval(OTHER_CHAT, 'rm -rf')).toBeNull();
  });

  it('replaces rather than extends an open window', () => {
    // Someone re-running the command has a length in mind; reading back more
    // time than they asked for is the wrong kind of surprise here.
    open({ durationMs: 60 * 60 * 1000 });
    const second = open({ durationMs: 5 * 60 * 1000, openedByName: 'Bo' });
    const live = getWindow(CHAT)!;
    expect(live).toBe(second);
    expect(live.openedByName).toBe('Bo');
    expect(live.expiresAt - live.openedAt).toBe(5 * 60 * 1000);
  });

  it('reports what it approved when closed, and closes only once', () => {
    open();
    consumeAutoApproval(CHAT, 'rm -rf');
    consumeAutoApproval(CHAT, 'sudo');

    const closed = closeWindow(CHAT);
    expect(closed?.approved).toBe(2);
    expect(getWindow(CHAT)).toBeNull();
    expect(closeWindow(CHAT)).toBeNull();
  });

  it('does not announce an expiry for a window somebody closed', () => {
    // The person who ran `/autoapprove off` is already being answered; a
    // second "it lapsed" message would read as though it had reopened.
    const onExpire = vi.fn();
    open({ onExpire });
    closeWindow(CHAT);
    expect(onExpire).not.toHaveBeenCalled();
  });
});

describe('expiry', () => {
  it('stops approving once the clock passes, without waiting for the timer', () => {
    // The timer is a convenience for the announcement. Whether the window is
    // live is decided from the clock, so a timer that never fired can only
    // close a window early — never leave a lapsed one answering prompts.
    const window = open({ durationMs: MIN_WINDOW_MS });
    vi.useFakeTimers();
    vi.setSystemTime(window.expiresAt + 1);

    expect(getWindow(CHAT)).toBeNull();
    expect(consumeAutoApproval(CHAT, 'rm -rf')).toBeNull();
  });

  it('announces the lapse exactly once', () => {
    const onExpire = vi.fn();
    const window = open({ durationMs: MIN_WINDOW_MS, onExpire });
    vi.useFakeTimers();
    vi.setSystemTime(window.expiresAt + 1);

    getWindow(CHAT);
    getWindow(CHAT);
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(onExpire.mock.calls[0]![0].approved).toBe(0);
  });
});

describe('what a window never covers', () => {
  it('keeps prompting for the irreversible patterns', () => {
    open();
    expect(consumeAutoApproval(CHAT, 'destructive disk op')).toBeNull();
    expect(consumeAutoApproval(CHAT, 'DROP DATABASE')).toBeNull();
    expect(consumeAutoApproval(CHAT, 'terraform destroy')).toBeNull();
  });

  it('keeps prompting for a credential read, however the path is spelled', () => {
    // The scope guard appends the offending path, so the match has to be on
    // the prefix rather than the whole reason.
    open();
    expect(
      consumeAutoApproval(CHAT, 'reads a credential or bot-state path — ~/.ssh/id_rsa'),
    ).toBeNull();
  });

  it('approves the recoverable ones', () => {
    open();
    for (const reason of ['rm -rf', 'sudo', 'git push --force', 'git reset --hard', 'DROP TABLE']) {
      expect(consumeAutoApproval(CHAT, reason)).not.toBeNull();
    }
    expect(getWindow(CHAT)!.approved).toBe(5);
  });

  it('does not count a carve-out against the tally', () => {
    open();
    consumeAutoApproval(CHAT, 'DROP DATABASE');
    expect(getWindow(CHAT)!.approved).toBe(0);
  });

  it('never approves a carve-out just because no window is open', () => {
    expect(alwaysPrompts('destructive disk op')).toBe(true);
    expect(alwaysPrompts('rm -rf')).toBe(false);
  });

  it('lists the carve-outs so the command can state them up front', () => {
    // Labels for a reader, not the strings alwaysPrompts() matches on — one
    // entry per carve-out is what has to hold.
    const listed = listAlwaysPrompted();
    expect(listed).toHaveLength(4);
    expect(listed.join(' ')).toContain('DROP DATABASE');
    expect(listed.join(' ')).toMatch(/credential/);
    expect(listed.join(' ')).toMatch(/mkfs/);
  });
});

describe('parsing a duration', () => {
  it('defaults when nothing is given', () => {
    expect(parseWindowDuration('')).toEqual({ ok: true, ms: DEFAULT_WINDOW_MS });
  });

  it('reads minutes, hours and seconds', () => {
    expect(parseWindowDuration('30m')).toEqual({ ok: true, ms: 30 * 60 * 1000 });
    expect(parseWindowDuration('2h')).toEqual({ ok: true, ms: 2 * 60 * 60 * 1000 });
    expect(parseWindowDuration('90s')).toEqual({ ok: true, ms: 90 * 1000 });
  });

  it('reads a bare number as minutes, because that is what a person means', () => {
    expect(parseWindowDuration('45')).toEqual({ ok: true, ms: 45 * 60 * 1000 });
  });

  it('tolerates spacing, case and the longer unit spellings', () => {
    expect(parseWindowDuration(' 15 MIN ')).toEqual({ ok: true, ms: 15 * 60 * 1000 });
    expect(parseWindowDuration('1 hr')).toEqual({ ok: true, ms: 60 * 60 * 1000 });
  });

  it('refuses a window shorter than the tap it replaces', () => {
    const result = parseWindowDuration('10s');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/shortest/i);
  });

  it('refuses one that would outlive the person who opened it', () => {
    const result = parseWindowDuration('9h');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/longest/i);
  });

  it('accepts the boundaries themselves', () => {
    expect(parseWindowDuration(`${MIN_WINDOW_MS / 1000}s`).ok).toBe(true);
    expect(parseWindowDuration(`${MAX_WINDOW_MS / 3600000}h`).ok).toBe(true);
  });

  it('refuses nonsense and zero rather than guessing', () => {
    expect(parseWindowDuration('forever').ok).toBe(false);
    expect(parseWindowDuration('0m').ok).toBe(false);
    expect(parseWindowDuration('-5m').ok).toBe(false);
  });
});

describe('formatting', () => {
  it('reads as a person would say it', () => {
    expect(formatDuration(30 * 60 * 1000)).toBe('30 min');
    expect(formatDuration(2 * 60 * 60 * 1000)).toBe('2 h');
    expect(formatDuration(90 * 60 * 1000)).toBe('1 h 30 min');
  });

  it('never rounds a live window down to nothing', () => {
    // "0 min left" on a window that is still approving would be a lie.
    expect(formatDuration(1000)).toBe('1 min');
  });

  it('counts down from now', () => {
    const window = open({ durationMs: 20 * 60 * 1000 });
    vi.useFakeTimers();
    vi.setSystemTime(window.openedAt + 5 * 60 * 1000);
    expect(formatRemaining(window)).toBe('15 min');
  });
});
