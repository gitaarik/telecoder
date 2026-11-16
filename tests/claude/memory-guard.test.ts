/**
 * A message that would start a new claude on a machine short of memory reaps
 * the idle claudes first, and asks the chat only when that isn't enough. A
 * message to a running claude never asks.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  availableMB: [] as number[], // successive readMemory() answers
  live: false,
  sessions: [] as { sessionKey: string; pid: number; idleMs: number; generating: boolean }[],
  reaped: [] as string[],
  reapCalls: [] as number[],
  endedLongest: null as string | null,
  answer: null as number | null, // index tapped, or null for a timeout
  answers: [] as (number | null | 'hold')[], // one per question when set: index, timeout, or never answered
  asked: [] as string[][],
  sent: [] as string[],
  edited: [] as string[],
  withdrawn: 0,
}));

vi.mock('../../src/utils/memory-pressure.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/memory-pressure.js')>()),
  readMemory: () => {
    const availableMB = fake.availableMB.length > 1 ? fake.availableMB.shift()! : fake.availableMB[0]!;
    return { totalMB: 7751, availableMB, swapTotalMB: 8191, swapUsedMB: 4880 };
  },
}));

vi.mock('../../src/providers/claude-provider.js', () => ({
  getPtyProvider: () => ({
    hasLiveSession: () => fake.live,
    describeSessions: () => fake.sessions,
    endLongestIdleSession: () => {
      fake.endedLongest = fake.sessions.find((s) => !s.generating)?.sessionKey ?? null;
      return fake.endedLongest;
    },
  }),
}));

vi.mock('../../src/claude/pty-idle-reaper.js', () => ({
  endIdlePtySessions: (maxIdleMs: number) => {
    fake.reapCalls.push(maxIdleMs);
    return fake.reaped;
  },
  sessionHasWork: () => false,
}));

vi.mock('../../src/claude/ask-user.js', () => ({
  questionTimeoutMs: () => 600_000,
  closeExpiredQuestion: async () => {},
  withdrawPendingQuestion: () => { fake.withdrawn++; },
  createPendingQuestion: (labels: string[]) => {
    fake.asked.push(labels);
    const answer = fake.answers.length > 0 ? fake.answers.shift()! : fake.answer;
    return {
      id: 'abcd1234',
      promise: answer === 'hold'
        ? new Promise(() => {})
        : Promise.resolve(answer === null ? null : { index: answer, label: labels[answer] }),
    };
  },
}));

const { guardSpawn, allowPrewarm, buildMemoryGuardMessage, buildWaitingMessage, formatIdle, resolveMinAvailableMB, clearStartingClaudes, SPAWN_RESERVE_MB, WAIT_POLL_MS } = await import('../../src/claude/memory-guard.js');
const { parseMeminfo } = await import('../../src/utils/memory-pressure.js');
const { config } = await import('../../src/config.js');

const KEY = '37620077:4242';

function ctx() {
  return {
    from: { id: 1 },
    api: {
      sendMessage: async (_chat: number, text: string) => {
        fake.sent.push(text);
        return { message_id: 7, chat: { id: 37620077 } };
      },
      editMessageText: async (_chat: number, _id: number, text: string) => {
        fake.edited.push(text);
        return true;
      },
      editMessageReplyMarkup: async () => true,
    },
  } as never;
}

const START = '▶️ Start anyway';
const END_IDLE = '♻️ End the longest-idle claude first';
const CHECK = '🔄 Check again';
const WAIT = '⏳ Wait for room';
const DROP = '✗ Drop this message';

beforeEach(() => {
  fake.availableMB = [2048];
  fake.method = 'pty';
  fake.live = false;
  fake.sessions = [];
  fake.reaped = [];
  fake.reapCalls = [];
  fake.endedLongest = null;
  fake.answer = null;
  fake.answers = [];
  fake.asked = [];
  fake.sent = [];
  fake.edited = [];
  fake.withdrawn = 0;
  (config as { MEMORY_GUARD_MIN_AVAILABLE_MB: number | 'auto' }).MEMORY_GUARD_MIN_AVAILABLE_MB = 1024;
  (config as { MEMORY_GUARD_MAX_SWAP_USED_MB: number }).MEMORY_GUARD_MAX_SWAP_USED_MB = 0;
  (config as { MEMORY_GUARD_REAP_IDLE_MS: number }).MEMORY_GUARD_REAP_IDLE_MS = 300_000;
  clearStartingClaudes();
});

describe('guardSpawn', () => {
  it('passes when memory is fine, without reading the room', async () => {
    expect(await guardSpawn(ctx(), KEY)).toEqual({ proceed: true, message: '' });
    expect(fake.reapCalls).toEqual([]);
    expect(fake.asked).toEqual([]);
  });

  it('passes a chat whose claude is already running, however tight memory is', async () => {
    fake.live = true;
    fake.availableMB = [100];
    expect((await guardSpawn(ctx(), KEY)).proceed).toBe(true);
    expect(fake.reapCalls).toEqual([]);
  });

  it('passes a disabled guard', async () => {
    fake.availableMB = [100];
    (config as { MEMORY_GUARD_MIN_AVAILABLE_MB: number }).MEMORY_GUARD_MIN_AVAILABLE_MB = 0;
    expect((await guardSpawn(ctx(), KEY)).proceed).toBe(true);
    expect(fake.reapCalls).toEqual([]);
  });

  it('reaps with the short window and passes when that frees enough', async () => {
    fake.availableMB = [700, 1400];
    fake.reaped = ['37620077:1'];
    expect((await guardSpawn(ctx(), KEY)).proceed).toBe(true);
    expect(fake.reapCalls).toEqual([300_000]);
    expect(fake.asked).toEqual([]);
  });

  it('asks when reaping is not enough, and starts on "Start anyway"', async () => {
    fake.availableMB = [700];
    fake.sessions = [{ sessionKey: '37620077:1', pid: 1, idleMs: 120_000, generating: true }];
    fake.answer = 0;
    expect((await guardSpawn(ctx(), KEY)).proceed).toBe(true);
    expect(fake.asked).toEqual([[START, CHECK, WAIT, DROP]]);
    expect(fake.sent[0]).toContain('700 MB available of 7,751 MB');
    expect(fake.sent[0]).toContain('1 other Claude is running: 1 busy.');
    // The exchange is closed by the guard, not the tap handler.
    expect(fake.edited).toEqual([expect.stringContaining(`✅ Answered: ${START}`)]);
  });

  it('offers to end the longest-idle claude when one exists, and does so', async () => {
    fake.availableMB = [700];
    fake.sessions = [
      { sessionKey: '37620077:1', pid: 1, idleMs: 120_000, generating: true },
      { sessionKey: '37620077:2', pid: 2, idleMs: 90_000, generating: false },
    ];
    fake.answer = 1;
    expect((await guardSpawn(ctx(), KEY)).proceed).toBe(true);
    expect(fake.asked[0]).toEqual([START, END_IDLE, CHECK, WAIT, DROP]);
    expect(fake.endedLongest).toBe('37620077:2');
    expect(fake.sent[0]).toContain('2 other Claudes are running: 1 busy, 1 idle for 2 min.');
  });

  it('drops the message on "Drop" and on a timeout, and says so', async () => {
    fake.availableMB = [700];
    fake.answer = 3;
    const dropped = await guardSpawn(ctx(), KEY);
    expect(dropped.proceed).toBe(false);
    expect(dropped.message).toContain('Dropped');

    fake.answer = null;
    const expired = await guardSpawn(ctx(), KEY);
    expect(expired.proceed).toBe(false);
    expect(expired.message).toContain('nobody answered in 10 min');
  });

  it('"Check again" re-asks over the same message with fresh numbers, and starts once it fits', async () => {
    fake.availableMB = [700, 700, 900, 1500]; // first look, after the reap, check one, check two
    fake.answers = [1, 1]; // Check again, twice
    expect((await guardSpawn(ctx(), KEY)).proceed).toBe(true);
    expect(fake.sent).toHaveLength(1);
    expect(fake.asked).toHaveLength(2);
    expect(fake.reapCalls).toEqual([300_000, 300_000, 300_000]);
    expect(fake.edited[0]).toContain('900 MB available of 7,751 MB');
    expect(fake.asked[1]).toContain(START); // the re-ask keeps the full keyboard
    expect(fake.edited[1]).toContain('✅ Checked again: it fits now, so Claude is starting.');
  });

  it('"Wait for room" checks on a timer, reaping each time, and starts the moment it fits', async () => {
    vi.useFakeTimers();
    try {
      fake.availableMB = [700, 700, 800, 1500]; // first look, after the reap, tick one, tick two
      fake.answers = [2, 'hold']; // Wait for room; nobody taps while it waits
      const outcome = guardSpawn(ctx(), KEY);
      await vi.advanceTimersByTimeAsync(10); // the question is up and the wait has begun
      expect(fake.edited[0]).toContain('Waiting for room');
      expect(fake.edited[0]).toContain("700 MB available of 7,751 MB; this chat's Claude starts at 1,024 MB.");
      expect(fake.asked[1]).toEqual([START, DROP]); // the buttons that stay up meanwhile

      await vi.advanceTimersByTimeAsync(WAIT_POLL_MS);
      expect(fake.edited[1]).toContain('800 MB available');
      expect(fake.reapCalls).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(WAIT_POLL_MS);
      expect((await outcome).proceed).toBe(true);
      expect(fake.reapCalls).toHaveLength(3);
      expect(fake.edited[2]).toContain('✅ Room came free after 1 min, so Claude is starting.');
      expect(fake.withdrawn).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a tap while waiting still counts', async () => {
    fake.availableMB = [700];
    fake.answers = [2, 0]; // Wait for room, then Start anyway
    expect((await guardSpawn(ctx(), KEY)).proceed).toBe(true);
    expect(fake.edited.at(-1)).toContain(`✅ Answered: ${START}`);
  });

  it('a wait that runs out asks again instead of dropping, and says it waited', async () => {
    fake.availableMB = [700];
    fake.answers = [2, null, 3]; // Wait for room; the wait times out; Drop on the re-ask
    const outcome = await guardSpawn(ctx(), KEY);
    expect(outcome.proceed).toBe(false);
    expect(fake.asked).toHaveLength(3);
    expect(fake.edited[1]).toContain("Memory is tight");
    expect(fake.edited[1]).toContain("Waited 10 min for room and it didn't come.");
    expect(fake.edited[2]).toContain(`✅ Answered: ${DROP}`);
  });

  it('starts anyway when there is no chat to ask', async () => {
    fake.availableMB = [700];
    expect((await guardSpawn(undefined, KEY)).proceed).toBe(true);
    expect(fake.asked).toEqual([]);
  });

  it('counts a claude it just let through, so two threads started together cannot both slip past', async () => {
    // Room for one more, not two: the first spawn hasn't shown up in MemAvailable yet.
    fake.availableMB = [1024 + SPAWN_RESERVE_MB - 1];
    expect((await guardSpawn(ctx(), KEY)).proceed).toBe(true);
    expect(fake.asked).toEqual([]);

    fake.answer = null;
    const second = await guardSpawn(ctx(), '37620077:4343');
    expect(second.proceed).toBe(false);
    expect(fake.asked).toHaveLength(1);
    expect(fake.sent[0]).toContain('1 more Claude was started just now and isn\'t in that figure yet.');
  });

  it('does not count a chat\'s own spawn against it', async () => {
    fake.availableMB = [1024 + SPAWN_RESERVE_MB - 1];
    expect((await guardSpawn(ctx(), KEY)).proceed).toBe(true);
    // The same chat again before its claude is live (the queue normally keeps this from happening).
    expect((await guardSpawn(ctx(), KEY)).proceed).toBe(true);
    expect(fake.asked).toEqual([]);
  });

  it('treats swap past MEMORY_GUARD_MAX_SWAP_USED_MB as tight, and says so', async () => {
    (config as { MEMORY_GUARD_MAX_SWAP_USED_MB: number }).MEMORY_GUARD_MAX_SWAP_USED_MB = 2000;
    fake.availableMB = [5000]; // the mock reports 4,880 MB of swap in use
    fake.answer = 0;
    expect((await guardSpawn(ctx(), KEY)).proceed).toBe(true);
    expect(fake.asked).toHaveLength(1);
    expect(fake.sent[0]).toContain('swap 4,880 MB in use. Swap is past the 2,000 MB limit.');
  });
});

describe('the floor', () => {
  it('"auto" is a quarter of RAM, never under 1 GB; a number is itself', () => {
    (config as { MEMORY_GUARD_MIN_AVAILABLE_MB: number | 'auto' }).MEMORY_GUARD_MIN_AVAILABLE_MB = 'auto';
    expect(resolveMinAvailableMB(7751)).toBe(1938);
    expect(resolveMinAvailableMB(2048)).toBe(1024);
    expect(resolveMinAvailableMB(32_000)).toBe(8000);
    (config as { MEMORY_GUARD_MIN_AVAILABLE_MB: number | 'auto' }).MEMORY_GUARD_MIN_AVAILABLE_MB = 1500;
    expect(resolveMinAvailableMB(7751)).toBe(1500);
  });

  it('applies the auto floor to the machine it runs on', async () => {
    (config as { MEMORY_GUARD_MIN_AVAILABLE_MB: number | 'auto' }).MEMORY_GUARD_MIN_AVAILABLE_MB = 'auto';
    fake.availableMB = [1800]; // under 1,938 on a 7,751 MB box
    fake.answer = null;
    expect((await guardSpawn(ctx(), KEY)).proceed).toBe(false);
    expect(fake.asked).toHaveLength(1);
  });
});

describe('the question', () => {
  it('says what has the memory when no other claude is running', () => {
    const { text } = buildMemoryGuardMessage({
      mem: { totalMB: 7751, availableMB: 600, swapTotalMB: 0, swapUsedMB: 0 },
      others: { busy: 0, idle: [] },
      timeoutMin: 10,
    });
    expect(text).toContain('600 MB available of 7,751 MB.');
    expect(text).not.toContain('swap');
    expect(text).toContain('No other Claude is running here; something else has the memory.');
    expect(text).toContain('Times out in 10 min → dropped.');
  });

  it('counts the claudes started a moment ago', () => {
    const { text } = buildMemoryGuardMessage({
      mem: { totalMB: 7751, availableMB: 1200, swapTotalMB: 0, swapUsedMB: 0 },
      others: { busy: 1, idle: [] },
      starting: 2,
      timeoutMin: 10,
    });
    expect(text).toContain('1,200 MB available of 7,751 MB. 2 more Claudes were started just now and aren\'t in that figure yet.');
  });

  it('says what the wait is for, and what it needs', () => {
    (config as { MEMORY_GUARD_MIN_AVAILABLE_MB: number | 'auto' }).MEMORY_GUARD_MIN_AVAILABLE_MB = 'auto';
    const { text } = buildWaitingMessage({
      mem: { totalMB: 7751, availableMB: 1500, swapTotalMB: 0, swapUsedMB: 0 },
      starting: 1,
      waitedMs: 150_000,
      timeoutMin: 10,
    });
    expect(text).toContain("1,500 MB available of 7,751 MB; this chat's Claude starts at 2,288 MB. Waited 3 min so far.");
    expect(text).toContain('Checked every 30 s; claudes that go idle meanwhile are ended as they pass 5 min.');
    expect(text).toContain('Gives up in 10 min → asks again.');
  });

  it('formats idle times the way a person reads them', () => {
    expect(formatIdle(45_000)).toBe('45 s');
    expect(formatIdle(150_000)).toBe('3 min');
    expect(formatIdle(3_900_000)).toBe('1 h 5 min');
    expect(formatIdle(7_200_000)).toBe('2 h');
  });
});

describe('allowPrewarm', () => {
  beforeEach(() => {
    fake.availableMB = [2048];
    fake.live = false;
    fake.reaped = [];
    fake.reapCalls = [];
    fake.asked = [];
    fake.sent = [];
    (config as { MEMORY_GUARD_MIN_AVAILABLE_MB: number | 'auto' }).MEMORY_GUARD_MIN_AVAILABLE_MB = 1024;
    (config as { MEMORY_GUARD_MAX_SWAP_USED_MB: number }).MEMORY_GUARD_MAX_SWAP_USED_MB = 0;
    clearStartingClaudes();
  });

  it('allows an early start with room in memory, and counts it like any spawn', async () => {
    // 1300 MB clears the 1024 floor once; a second chat sees it less the first one's reservation.
    fake.availableMB = [1300];
    expect(allowPrewarm('1:1')).toBe(true);
    expect(allowPrewarm('1:2')).toBe(false);
    // The message that follows the early start is that chat's own spawn.
    expect((await guardSpawn(ctx(), '1:1')).proceed).toBe(true);
    expect(fake.asked).toEqual([]);
  });

  it('refuses under the floor without reaping anything or asking anyone', () => {
    fake.availableMB = [600];
    fake.reaped = ['9:9'];
    expect(allowPrewarm(KEY)).toBe(false);
    expect(fake.reapCalls).toEqual([]);
    expect(fake.asked).toEqual([]);
    expect(fake.sent).toEqual([]);
  });

  it('always allows it with the guard off', () => {
    (config as { MEMORY_GUARD_MIN_AVAILABLE_MB: number | 'auto' }).MEMORY_GUARD_MIN_AVAILABLE_MB = 0;
    fake.availableMB = [100];
    expect(allowPrewarm(KEY)).toBe(true);
  });
});

describe('parseMeminfo', () => {
  it('reads MemAvailable, not MemFree, and swap in use', () => {
      const mem = parseMeminfo([
        'MemTotal:        7937020 kB',
        'MemFree:          150000 kB',
        'MemAvailable:    1081344 kB',
        'Buffers:          100000 kB',
        'SwapTotal:       8388604 kB',
        'SwapFree:        3391488 kB',
      ].join('\n'));
      expect(mem).toEqual({ totalMB: 7751, availableMB: 1056, swapTotalMB: 8192, swapUsedMB: 4880 });
      expect(parseMeminfo('MemTotal: 1 kB\n')).toBeNull();
  });
});
