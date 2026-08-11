import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GrammyError } from 'grammy';
import type { Bot } from 'grammy';

import {
  setBackgroundCardBot,
  noteTaskArmed,
  noteTaskFinished,
  noteMonitorEvent,
  sealCard,
  clearCard,
  _inspectCard,
} from '../../src/telegram/background-activity-card.js';

const SESSION_KEY = '12345';
const THREAD_KEY = '12345:42';

/** Mirrors the constants the card is built around. */
const MIN_EDIT_INTERVAL_MS = 5_000;
const REANCHOR_FLOOR_MS = 120_000;

interface Sent {
  chatId: number;
  text: string;
  opts?: { message_thread_id?: number; parse_mode?: string };
}

let sends: Sent[];
let edits: { messageId: number; text: string }[];
let nextMessageId: number;
/** Queued rejections, consumed one per call. */
let sendFailures: (Error | null)[];
let editFailures: (Error | null)[];
/** Set to park the next sendMessage until the test releases it. */
let sendGate: Promise<void> | null;

function makeBot(): Bot {
  return {
    api: {
      sendMessage: vi.fn(async (chatId: number, text: string, opts?: Sent['opts']) => {
        if (sendGate) {
          const gate = sendGate;
          sendGate = null;
          await gate;
        }
        const failure = sendFailures.shift();
        if (failure) throw failure;
        sends.push({ chatId, text, opts });
        return { message_id: nextMessageId++ };
      }),
      editMessageText: vi.fn(async (_chatId: number, messageId: number, text: string) => {
        const failure = editFailures.shift();
        if (failure) throw failure;
        edits.push({ messageId, text });
        return true;
      }),
    },
  } as unknown as Bot;
}

/** Let the in-flight send/edit promises settle without moving the clock. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/** Move past the edit throttle and let the resulting flush finish. */
async function tick(ms = MIN_EDIT_INTERVAL_MS): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

function grammyError(description: string, code: number, parameters: Record<string, unknown> = {}): GrammyError {
  return new GrammyError(
    'Call to method failed',
    { ok: false, error_code: code, description, parameters } as never,
    'editMessageText',
    {} as never,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-11T12:00:00Z'));
  sends = [];
  edits = [];
  sendFailures = [];
  editFailures = [];
  sendGate = null;
  nextMessageId = 100;
  setBackgroundCardBot(makeBot());
});

afterEach(() => {
  clearCard(SESSION_KEY);
  clearCard(THREAD_KEY);
  setBackgroundCardBot(null);
  vi.useRealTimers();
});

describe('posting and consolidation', () => {
  it('posts the card immediately on the first entry', async () => {
    noteTaskArmed(SESSION_KEY, 'monitor', 'watch the deploy', 'toolu_01');
    await settle();

    expect(sends).toHaveLength(1);
    expect(sends[0].chatId).toBe(12345);
    expect(sends[0].text).toContain('Background activity');
    expect(sends[0].text).toContain('watch the deploy');
  });

  it('folds a burst of arms into the one card instead of a message each', async () => {
    noteTaskArmed(SESSION_KEY, 'monitor', 'watch the deploy', 'toolu_01');
    noteTaskArmed(SESSION_KEY, 'subagent', 'review the diff', 'toolu_02');
    noteTaskArmed(SESSION_KEY, 'bash_background', 'npm run build', 'toolu_03');
    await settle();
    await tick();

    // One message on screen, however many tasks landed on it.
    expect(sends).toHaveLength(1);
    const card = _inspectCard(SESSION_KEY)!;
    expect(card.running).toBe(3);
    expect(card.text).toContain('watch the deploy');
    expect(card.text).toContain('review the diff');
    expect(card.text).toContain('npm run build');
  });

  it('folds a burst of monitor events into one message', async () => {
    noteMonitorEvent(SESSION_KEY, 'deploy step 1', 'log line 1', 'first', { notify: true });
    await settle();
    noteMonitorEvent(SESSION_KEY, 'deploy step 2', 'log line 2', 'second', { notify: true });
    noteMonitorEvent(SESSION_KEY, 'deploy step 3', 'log line 3', 'third', { notify: true });
    await tick();

    // Previously this was three separate Telegram messages.
    expect(sends).toHaveLength(1);
    expect(edits.length).toBeGreaterThanOrEqual(1);
    const latest = edits[edits.length - 1].text;
    expect(latest).toContain('deploy step 3');
  });

  it('routes a forum-topic session into its thread', async () => {
    noteTaskArmed(THREAD_KEY, 'monitor', 'watch', 'toolu_t1');
    await settle();

    expect(sends[0].chatId).toBe(12345);
    expect(sends[0].opts?.message_thread_id).toBe(42);
  });
});

describe('edit throttling', () => {
  it('holds edits back to the throttle interval but never drops the last one', async () => {
    noteMonitorEvent(SESSION_KEY, 'first', '', '', { notify: true });
    await settle();
    expect(edits).toHaveLength(0);

    // Straight after the post, an edit is inside the throttle window.
    noteMonitorEvent(SESSION_KEY, 'second', '', '', { notify: true });
    await settle();
    expect(edits).toHaveLength(0);

    // The trailing flush still lands once the window passes — the point of
    // difference from ActionLogger, which drops the update entirely.
    await tick();
    expect(edits).toHaveLength(1);
    expect(edits[0].text).toContain('second');
  });

  it('skips an edit when the render is unchanged', async () => {
    noteTaskArmed(SESSION_KEY, 'monitor', 'watch', 'toolu_01');
    await settle();
    await tick();
    const before = edits.length;

    // Nothing changed and no time passed, so there is nothing to redraw.
    noteTaskArmed(SESSION_KEY, 'monitor', 'watch', 'toolu_01');
    await tick();

    expect(edits.length).toBe(before);
  });
});

describe('re-anchoring', () => {
  it('starts a fresh card after a turn boundary seals the old one', async () => {
    noteMonitorEvent(SESSION_KEY, 'before the turn', '', '', { notify: true });
    await settle();
    expect(sends).toHaveLength(1);

    sealCard(SESSION_KEY);
    await settle();

    noteMonitorEvent(SESSION_KEY, 'after the turn', '', '', { notify: true });
    await settle();

    expect(sends).toHaveLength(2);
    // The sealed card is history; the new one is not a replay of it.
    expect(sends[1].text).toContain('after the turn');
    expect(sends[1].text).not.toContain('before the turn');
  });

  it('carries running tasks onto the new card but not old events', async () => {
    noteTaskArmed(SESSION_KEY, 'subagent', 'long review', 'toolu_01');
    noteMonitorEvent(SESSION_KEY, 'an event', '', '', { notify: true });
    await settle();

    sealCard(SESSION_KEY);
    await settle();
    noteMonitorEvent(SESSION_KEY, 'later event', '', '', { notify: true });
    await settle();

    const card = _inspectCard(SESSION_KEY)!;
    expect(card.running).toBe(1);
    expect(card.text).toContain('long review');
    expect(card.text).toContain('later event');
    expect(card.text).not.toContain('an event');
  });

  it('edits rather than re-posts while the card is inside the re-anchor floor', async () => {
    noteMonitorEvent(SESSION_KEY, 'first', '', '', { notify: true });
    await settle();

    await tick(REANCHOR_FLOOR_MS - 1_000);
    noteMonitorEvent(SESSION_KEY, 'second', '', '', { notify: true });
    await settle();

    expect(sends).toHaveLength(1);
    expect(edits[edits.length - 1].text).toContain('second');
  });

  it('re-posts once the card has been on screen past the floor', async () => {
    noteMonitorEvent(SESSION_KEY, 'first', '', '', { notify: true });
    await settle();

    await tick(REANCHOR_FLOOR_MS + 1_000);
    noteMonitorEvent(SESSION_KEY, 'second', '', '', { notify: true });
    await settle();

    // A fresh message is what raises a Telegram notification; an edit does not.
    expect(sends).toHaveLength(2);
    expect(sends[1].text).toContain('second');
  });

  it('keeps a non-notifying entry on the existing card past the floor', async () => {
    noteMonitorEvent(SESSION_KEY, 'first', '', '', { notify: true });
    await settle();

    await tick(REANCHOR_FLOOR_MS + 1_000);
    noteTaskArmed(SESSION_KEY, 'bash_background', 'npm run build', 'toolu_09');
    await settle();

    expect(sends).toHaveLength(1);
  });

  it('re-posts a failure immediately, floor or no floor', async () => {
    noteTaskArmed(SESSION_KEY, 'bash_background', 'npm test', 'toolu_01');
    await settle();
    expect(sends).toHaveLength(1);

    await tick(1_000);
    noteTaskFinished(
      SESSION_KEY,
      'toolu_01',
      { kind: 'bash_background', description: 'npm test', status: 'failed', elapsedMs: 1_000 },
      { notify: true, urgent: true },
    );
    await settle();

    expect(sends).toHaveLength(2);
    expect(sends[1].text).toContain('failed');
    expect(sends[1].text).toContain('npm test');
  });
});

describe('task lifecycle', () => {
  it('moves a finished task out of the running list', async () => {
    noteTaskArmed(SESSION_KEY, 'bash_background', 'npm test', 'toolu_01');
    await settle();
    expect(_inspectCard(SESSION_KEY)!.running).toBe(1);

    noteTaskFinished(
      SESSION_KEY,
      'toolu_01',
      { kind: 'bash_background', description: 'npm test', status: 'completed', elapsedMs: 62_000 },
      { notify: false },
    );
    await tick();

    const card = _inspectCard(SESSION_KEY)!;
    expect(card.running).toBe(0);
    expect(card.text).toContain('npm test');
    expect(card.text).toContain('1m 2s');
  });

  it('records an arm with no tool_use_id as an event, not a running ghost', async () => {
    noteTaskArmed(SESSION_KEY, 'subagent', 'untrackable', undefined);
    await settle();

    const card = _inspectCard(SESSION_KEY)!;
    // Nothing can ever retire it, so it must not sit in the running list.
    expect(card.running).toBe(0);
    expect(card.events).toBe(1);
    expect(card.text).toContain('untrackable');
  });

  it('shows how long each running task has been going', async () => {
    noteTaskArmed(SESSION_KEY, 'subagent', 'long review', 'toolu_01');
    await settle();

    await tick(134_000);
    noteMonitorEvent(SESSION_KEY, 'nudge', '', '', { notify: false });
    await settle();

    expect(_inspectCard(SESSION_KEY)!.text).toContain('running 2m 14s');
  });
});

describe('size limits', () => {
  it('keeps the card under the Telegram message ceiling', async () => {
    for (let i = 0; i < 12; i++) {
      noteMonitorEvent(SESSION_KEY, `event ${i}`, 'x'.repeat(2_000), 'y'.repeat(4_000), { notify: false });
      await tick();
    }

    const card = _inspectCard(SESSION_KEY)!;
    expect(card.text.length).toBeLessThanOrEqual(3_800);
    for (const send of sends) expect(send.text.length).toBeLessThanOrEqual(4_096);
    for (const edit of edits) expect(edit.text.length).toBeLessThanOrEqual(4_096);
  });

  it('drops the oldest events rather than growing without bound', async () => {
    for (let i = 0; i < 12; i++) {
      noteMonitorEvent(SESSION_KEY, `event ${i}`, '', '', { notify: false });
      await tick();
    }

    const card = _inspectCard(SESSION_KEY)!;
    expect(card.events).toBeLessThanOrEqual(8);
    expect(card.text).toContain('event 11');
    expect(card.text).not.toContain('event 0');
  });
});

describe('Telegram failures', () => {
  it('falls back to plain text when MarkdownV2 is rejected', async () => {
    sendFailures = [grammyError('Bad Request: can\'t parse entities', 400)];
    noteMonitorEvent(SESSION_KEY, 'weird *formatting*', '', '', { notify: true });
    await settle();

    expect(sends).toHaveLength(1);
    expect(sends[0].opts?.parse_mode).toBeUndefined();
    expect(sends[0].text).toContain('weird *formatting*');
  });

  it('backs off instead of hammering after a 429', async () => {
    noteMonitorEvent(SESSION_KEY, 'first', '', '', { notify: true });
    await settle();

    editFailures = [grammyError('Too Many Requests', 429, { retry_after: 30 })];
    noteMonitorEvent(SESSION_KEY, 'second', '', '', { notify: false });
    await tick();
    expect(edits).toHaveLength(0);

    // Still inside the 30s penalty box.
    await tick(10_000);
    expect(edits).toHaveLength(0);

    // Past it, the held-back update goes out.
    await tick(30_000);
    expect(edits.length).toBeGreaterThanOrEqual(1);
    expect(edits[edits.length - 1].text).toContain('second');
  });

  it('posts a new card when the old one was deleted out from under it', async () => {
    noteMonitorEvent(SESSION_KEY, 'first', '', '', { notify: true });
    await settle();
    expect(sends).toHaveLength(1);

    editFailures = [grammyError('Bad Request: message to edit not found', 400)];
    noteMonitorEvent(SESSION_KEY, 'second', '', '', { notify: false });
    await tick();
    expect(edits).toHaveLength(0);

    noteMonitorEvent(SESSION_KEY, 'third', '', '', { notify: false });
    await tick();
    expect(sends).toHaveLength(2);
    expect(sends[1].text).toContain('third');
  });

  it('keeps accumulating when no bot is configured', async () => {
    setBackgroundCardBot(null);
    noteTaskArmed(SESSION_KEY, 'monitor', 'watch', 'toolu_01');
    await settle();

    expect(sends).toHaveLength(0);
    expect(_inspectCard(SESSION_KEY)!.running).toBe(1);
  });
});

describe('teardown', () => {
  it('forgets the card so a respawned session starts clean', async () => {
    noteTaskArmed(SESSION_KEY, 'monitor', 'watch', 'toolu_01');
    await settle();
    expect(_inspectCard(SESSION_KEY)).not.toBeNull();

    clearCard(SESSION_KEY);
    expect(_inspectCard(SESSION_KEY)).toBeNull();
  });

  it('stops editing a card sealed while its send was in flight', async () => {
    noteMonitorEvent(SESSION_KEY, 'first', '', '', { notify: true });
    sealCard(SESSION_KEY);
    await settle();

    // Anything the next quiet window produces belongs on a fresh card, not
    // on one the user has already scrolled past.
    expect(_inspectCard(SESSION_KEY)!.messageId).toBeNull();
  });

  it('finishes the send before sealing, so the card is never orphaned', async () => {
    let release!: () => void;
    sendGate = new Promise<void>((resolve) => { release = resolve; });

    noteMonitorEvent(SESSION_KEY, 'first', '', '', { notify: true });
    await settle();
    expect(sends).toHaveLength(0); // parked inside sendMessage

    // A second event and a turn boundary both land while the send is open.
    noteMonitorEvent(SESSION_KEY, 'second', '', '', { notify: false });
    sealCard(SESSION_KEY);

    release();
    await settle();

    // Sealing straight away would have thrown away message 100 while it was
    // still in the air, leaving a card in the chat stuck on its first state.
    expect(sends).toHaveLength(1);
    expect(edits).toHaveLength(1);
    expect(edits[0].messageId).toBe(100);
    expect(edits[0].text).toContain('second');
    expect(_inspectCard(SESSION_KEY)!.messageId).toBeNull();
  });
});
