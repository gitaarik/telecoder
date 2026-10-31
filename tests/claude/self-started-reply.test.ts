/**
 * The reply from a turn claude starts on its own, when a background task
 * reports back between TeleCoder's turns.
 *
 * Nothing streams such a turn, so the monitor relay is the only way its prose
 * reaches the chat. It used to put each text record on the background card,
 * cut at 1,200 characters, and the card as a whole at 3,800 — while the
 * answer the background work was for is often longer than either. Over two
 * weeks of session logs, 50 of 119 such turns wrote a text record past the
 * cut, and the rest of it was only in /recap.
 *
 * These drive the real relay off a session log on disk, through its real
 * file watcher, with a stand-in for the message sender.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as realOs from 'os';
import type { Bot } from 'grammy';
import type { Context } from 'grammy';

// The relay watches sessionJsonlPath(), which resolves under os.homedir();
// point it at a scratch dir so the test never touches the real ~/.claude.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: actual, homedir: () => process.env.TELECODER_TEST_HOME ?? actual.homedir() };
});

const fx = vi.hoisted(() => ({
  replies: [] as { sessionKey: string | undefined; text: string }[],
  /** Set to park the next reply until the test releases it. */
  gate: null as Promise<void> | null,
}));

vi.mock('../../src/telegram/message-sender.js', async () => {
  const { getSessionKeyFromCtx } = await import('../../src/utils/session-key.js');
  return {
    messageSender: {
      sendMessage: async (ctx: Context, text: string) => {
        if (fx.gate) {
          const gate = fx.gate;
          fx.gate = null;
          await gate;
        }
        fx.replies.push({ sessionKey: getSessionKeyFromCtx(ctx)?.sessionKey, text });
        return 1;
      },
    },
  };
});

const {
  setMonitorRelayBot,
  onAsyncToolArmed,
  markTurnStart,
  markTurnEnd,
  markSelfTurnInterrupted,
  settleBeforePost,
  teardown,
  hasSelfStartedTurn,
  whenRepliesSent,
} = await import('../../src/claude/monitor-relay.js');
const { _inspectCard } = await import('../../src/telegram/background-activity-card.js');

/** Everything the background card has put in the chat, sent or edited. */
const cardTexts: string[] = [];
/** vi.waitFor's default second is tight for a file watcher under a busy suite. */
const WAIT = { timeout: 3_000 };

const CWD = '/home/someone/dev/telecoder';
const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff';
const SESSION_KEY = '12345';
const TOPIC_KEY = '12345:42';
let home: string;

/** What claude wrote after a subagent finished, on 10-29: 2,176 characters. */
const LONG_ANSWER = `Both reviews are in. ${'The patch holds up under every case they tried. '.repeat(45)}That's the lot.`;

function logPath(): string {
  return path.join(home, '.claude', 'projects', CWD.replace(/\//g, '-'), `${SESSION_ID}.jsonl`);
}

function seedLog(): void {
  fs.mkdirSync(path.dirname(logPath()), { recursive: true });
  fs.writeFileSync(logPath(), '');
}

function append(...recs: object[]): void {
  fs.appendFileSync(logPath(), recs.map((r) => JSON.stringify(r) + '\n').join(''));
}

function completion(toolUseId: string): object {
  const text =
    '<task-notification>' +
    '<task-id>task_1</task-id>' +
    `<tool-use-id>${toolUseId}</tool-use-id>` +
    '<status>completed</status>' +
    '<summary>Agent "review the diff" completed</summary>' +
    '</task-notification>';
  return { type: 'user', origin: { kind: 'task-notification' }, message: { role: 'user', content: [{ type: 'text', text }] } };
}

function monitorEvent(event: string): object {
  const text =
    '<task-notification>' +
    '<task-id>biflh7fuu</task-id>' +
    '<summary>Monitor event: "CI gates"</summary>' +
    `<event>${event}</event>` +
    '</task-notification>';
  return { type: 'user', origin: { kind: 'task-notification' }, message: { role: 'user', content: text } };
}

function prose(text: string): object {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } };
}

/** A tool call and its result, between two stretches of prose. */
function toolRoundTrip(id: string): object[] {
  return [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } },
  ];
}

/** The record Claude Code closes every turn with. */
const TURN_CLOSED = { type: 'system', subtype: 'turn_duration', durationMs: 22789 };

/** Arm a subagent in a turn of TeleCoder's, then end that turn. */
function armAndEndTurn(kind: 'subagent' | 'monitor' = 'subagent', sessionKey = SESSION_KEY): void {
  onAsyncToolArmed(kind, sessionKey, CWD, SESSION_ID, kind === 'monitor' ? 'CI gates' : 'review the diff', 'toolu_01');
  markTurnEnd(sessionKey);
}

/**
 * Until the card has put `text` in the chat. The watcher reads a chunk at a
 * time, so by then it has read whatever was appended with it.
 */
async function cardShows(text: string): Promise<void> {
  await vi.waitFor(() => expect(cardTexts.some((t) => t.includes(text))).toBe(true), WAIT);
}

function makeBot(): Bot {
  let nextId = 100;
  return {
    api: {
      sendMessage: vi.fn(async (_chatId: number, text: string) => {
        cardTexts.push(text);
        return { message_id: nextId++ };
      }),
      editMessageText: vi.fn(async (_chatId: number, _messageId: number, text: string) => {
        cardTexts.push(text);
        return true;
      }),
    },
  } as unknown as Bot;
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(realOs.tmpdir(), 'telecoder-reply-'));
  process.env.TELECODER_TEST_HOME = home;
});

afterAll(() => {
  delete process.env.TELECODER_TEST_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  seedLog();
  fx.replies.length = 0;
  fx.gate = null;
  cardTexts.length = 0;
  setMonitorRelayBot(makeBot());
});

afterEach(async () => {
  teardown(SESSION_KEY);
  teardown(TOPIC_KEY);
  // Let a reply teardown sent land here rather than in the next test.
  await new Promise((resolve) => setTimeout(resolve, 20));
});

describe('a turn claude started itself', () => {
  it('sends its reply whole, once the turn closes', async () => {
    armAndEndTurn();
    append(
      completion('toolu_01'),
      prose('The review is back. Checking its one finding:'),
      ...toolRoundTrip('toolu_02'),
      prose(LONG_ANSWER),
      TURN_CLOSED,
    );

    await vi.waitFor(() => expect(fx.replies).toHaveLength(1), WAIT);
    // Joined the way a turn of TeleCoder's is, and not a character short.
    expect(fx.replies[0]!.text).toBe(`The review is back. Checking its one finding:\n\n${LONG_ANSWER}`);
    expect(fx.replies[0]!.sessionKey).toBe(SESSION_KEY);
  });

  it('leaves the reply off the card, which keeps the task', async () => {
    armAndEndTurn();
    append(completion('toolu_01'), prose(LONG_ANSWER), TURN_CLOSED);

    await vi.waitFor(() => expect(fx.replies).toHaveLength(1), WAIT);
    await cardShows('Subagent done');
    expect(cardTexts.some((t) => t.includes('The patch holds up'))).toBe(false);
  });

  it('holds the reply while the turn is still running', async () => {
    armAndEndTurn();
    append(completion('toolu_01'), prose('Running the tests on it now.'), ...toolRoundTrip('toolu_02'));
    await cardShows('Subagent done');
    expect(fx.replies).toHaveLength(0);

    append(prose('They pass.'), TURN_CLOSED);
    await vi.waitFor(() => expect(fx.replies).toHaveLength(1), WAIT);
    expect(fx.replies[0]!.text).toBe('Running the tests on it now.\n\nThey pass.');
  });

  it("sends each turn's reply separately, and in order", async () => {
    armAndEndTurn();
    // The first reply is slow to go out — a Telegraph page to publish, say.
    let release!: () => void;
    fx.gate = new Promise((resolve) => { release = resolve; });

    append(completion('toolu_01'), prose('First.'), TURN_CLOSED);
    await cardShows('Subagent done');
    append(monitorEvent('gate 3 passed'), prose('Second.'), TURN_CLOSED);
    await cardShows('gate 3 passed');
    expect(fx.replies).toHaveLength(0);

    release();
    await vi.waitFor(() => expect(fx.replies).toHaveLength(2), WAIT);
    expect(fx.replies.map((r) => r.text)).toEqual(['First.', 'Second.']);
  });

  it("goes to the session's forum topic", async () => {
    armAndEndTurn('subagent', TOPIC_KEY);
    append(completion('toolu_01'), prose('Done.'), TURN_CLOSED);

    await vi.waitFor(() => expect(fx.replies).toHaveLength(1), WAIT);
    expect(fx.replies[0]!.sessionKey).toBe(TOPIC_KEY);
  });
});

describe('a monitor firing', () => {
  it('lands on the card at once, and what claude says about it follows as a reply', async () => {
    armAndEndTurn('monitor');
    append(monitorEvent('gate 3 failed'));

    // On the card before claude has said anything, rather than held for it.
    await cardShows('gate 3 failed');
    expect(_inspectCard(SESSION_KEY)!.text).toContain('Monitor — CI gates');
    expect(fx.replies).toHaveLength(0);

    append(prose(LONG_ANSWER), TURN_CLOSED);
    await vi.waitFor(() => expect(fx.replies).toHaveLength(1), WAIT);
    expect(fx.replies[0]!.text).toBe(LONG_ANSWER);
  });
});

describe('prose that is not the relay\'s', () => {
  it("leaves a turn of TeleCoder's own to the turn pipeline", async () => {
    onAsyncToolArmed('subagent', SESSION_KEY, CWD, SESSION_ID, 'review the diff', 'toolu_01');
    append(prose('I started a reviewer in the background.'), TURN_CLOSED);
    markTurnEnd(SESSION_KEY);

    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(fx.replies).toHaveLength(0);
  });
});

describe('a turn that has not closed', () => {
  it('goes out ahead of the next turn of TeleCoder\'s', async () => {
    armAndEndTurn();
    append(completion('toolu_01'), prose('Halfway through the fix.'));

    // Read synchronously: the watcher's coalesce window hasn't run yet.
    markTurnStart(SESSION_KEY);
    await vi.waitFor(() => expect(fx.replies).toHaveLength(1), WAIT);
    expect(fx.replies[0]!.text).toBe('Halfway through the fix.');

    // What claude writes from here on belongs to the turn that just started.
    append(prose('Now to your question.'), TURN_CLOSED);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(fx.replies).toHaveLength(1);
  });

  it('is in the chat before a tool posts below it', async () => {
    armAndEndTurn();
    append(completion('toolu_01'), prose('One thing to settle before I go on.'));

    await settleBeforePost(SESSION_KEY);
    expect(fx.replies.map((r) => r.text)).toEqual(['One thing to settle before I go on.']);
  });

  it('is sent when the session goes down under it', async () => {
    armAndEndTurn();
    append(completion('toolu_01'), prose('Committing the fix.'));

    teardown(SESSION_KEY);
    await vi.waitFor(() => expect(fx.replies).toHaveLength(1), WAIT);
    expect(fx.replies[0]!.text).toBe('Committing the fix.');
  });
});

describe('whether a turn claude started itself is still going', () => {
  it('is, from the record that starts it until the one that closes it', async () => {
    armAndEndTurn();
    expect(hasSelfStartedTurn()).toBe(false);

    append(completion('toolu_01'), prose('The review is back.'));
    await cardShows('review the diff');
    await vi.waitFor(() => expect(hasSelfStartedTurn()).toBe(true), WAIT);

    append(TURN_CLOSED);
    await vi.waitFor(() => expect(hasSelfStartedTurn()).toBe(false), WAIT);
  });

  it('is not, once it has been interrupted, and what it had written still goes out', async () => {
    // An Esc leaves this record and no turn_duration. It is filed as a user
    // record, the very thing that opens a self-started turn.
    armAndEndTurn();
    append(completion('toolu_01'), prose('Halfway through the review.'));
    await vi.waitFor(() => expect(hasSelfStartedTurn()).toBe(true), WAIT);

    append({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });

    await vi.waitFor(() => expect(hasSelfStartedTurn()).toBe(false), WAIT);
    await vi.waitFor(() => expect(fx.replies.map((r) => r.text)).toEqual(['Halfway through the review.']), WAIT);
  });

  it('is not, once told it was interrupted, when the log says nothing about it', async () => {
    // An Esc before any output writes no record: not this one, not turn_duration.
    armAndEndTurn();
    append(completion('toolu_01'));
    await vi.waitFor(() => expect(hasSelfStartedTurn()).toBe(true), WAIT);

    markSelfTurnInterrupted(SESSION_KEY);

    expect(hasSelfStartedTurn()).toBe(false);
  });

  it('sends what it had written when told it was interrupted, even if not yet read', async () => {
    armAndEndTurn();
    append(completion('toolu_01'));
    await vi.waitFor(() => expect(hasSelfStartedTurn()).toBe(true), WAIT);

    append(prose('Halfway through the review.'));
    markSelfTurnInterrupted(SESSION_KEY);

    expect(hasSelfStartedTurn()).toBe(false);
    await vi.waitFor(() => expect(fx.replies.map((r) => r.text)).toEqual(['Halfway through the review.']), WAIT);
  });

  it("isn't touched by an interrupt meant for a turn of TeleCoder's", async () => {
    armAndEndTurn();
    markTurnStart(SESSION_KEY);
    append(prose('This belongs to the running turn.'));

    markSelfTurnInterrupted(SESSION_KEY);
    await whenRepliesSent();

    expect(fx.replies).toEqual([]);
    markTurnEnd(SESSION_KEY);
  });

  it('is not opened by an interrupt on its own', async () => {
    const { taskTracker } = await import('../../src/telegram/task-tracker.js');
    armAndEndTurn();
    const running = taskTracker.getBackgroundedTotal();

    append(
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } },
      // A completion folded into a turn opens nothing and retires the task, so
      // once the task has gone, the interrupt ahead of it has been read.
      {
        type: 'attachment',
        attachment: {
          type: 'queued_command',
          origin: { kind: 'task-notification' },
          prompt: '<task-notification><tool-use-id>toolu_01</tool-use-id><status>completed</status></task-notification>',
        },
      },
    );

    await vi.waitFor(() => expect(taskTracker.getBackgroundedTotal()).toBe(running - 1), WAIT);
    expect(hasSelfStartedTurn()).toBe(false);
    expect(fx.replies).toEqual([]);
  });

  it("is not, once a turn of TeleCoder's takes over", async () => {
    armAndEndTurn();
    append(completion('toolu_01'));
    await vi.waitFor(() => expect(hasSelfStartedTurn()).toBe(true), WAIT);

    markTurnStart(SESSION_KEY);
    expect(hasSelfStartedTurn()).toBe(false);
    markTurnEnd(SESSION_KEY);
  });

  it('lets a caller wait until its reply is in the chat', async () => {
    let release!: () => void;
    fx.gate = new Promise<void>((resolve) => { release = resolve; });
    armAndEndTurn();
    append(completion('toolu_01'), prose(LONG_ANSWER), TURN_CLOSED);
    // The sender has taken the reply and is parked on the gate.
    await vi.waitFor(() => expect(fx.gate).toBeNull(), WAIT);
    expect(hasSelfStartedTurn()).toBe(false);

    let sent = false;
    const waiting = whenRepliesSent().then(() => { sent = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toBe(false);

    release();
    await waiting;
    expect(fx.replies).toHaveLength(1);
  });
});
