/**
 * Coverage for the live action log.
 *
 * - It showed the last ten entries whatever their size, and ten with a command
 *   and output apiece come to more than a message holds. Every edit past that
 *   point failed with MESSAGE_TOO_LONG — the plain-text fallback too — so a
 *   busy turn's live log froze partway through.
 * - An action that arrived inside the edit throttle was dropped from the live
 *   log until another one came in, which after a burst of quick reads followed
 *   by a long build was the whole build.
 * - It carries the turn's status line at its bottom, so a turn needs no
 *   "typing…" — which Telegram Desktop animates on the CPU — to show it's alive.
 * - Under that it shows the prompt the turn is running. A tall log pushes the
 *   message the prompt came in far up the chat, and with it what the turn is
 *   for, which the user then scrolled back up to find.
 * - Last comes the time it was drawn. Telegram doesn't show when a message was
 *   last edited, so a log that had stopped moving looked like one still going.
 *   Its times are `date_time` entities, which read in the user's timezone; the
 *   server's clock read an hour or more off theirs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GrammyError, type Context } from 'grammy';
import type { MessageEntity } from 'grammy/types';
import type { ToolResultEvent } from '../../src/providers/types.js';
import type { EntityMessage } from '../../src/telegram/entities.js';

// Telegraph off: a finished turn's log stays in the chat, drawn one last time.
vi.mock('../../src/telegram/telegraph-settings.js', () => ({
  isTelegraphEnabled: () => false,
}));

const { ActionLogger } = await import('../../src/telegram/action-logger.js');

const SESSION = '111';

interface Delivered {
  text: string;
  entities: MessageEntity[];
}

/** A chat that turns away over-long text the way Telegram does. */
function fakeChat() {
  const delivered: Delivered[] = [];
  const deliver = (text: string, opts?: { entities?: MessageEntity[] }) => {
    if (text.length > 4096) throw new Error('Bad Request: MESSAGE_TOO_LONG');
    delivered.push({ text, entities: opts?.entities ?? [] });
  };
  const api = {
    sendMessage: vi.fn(async (_chatId: number, text: string, opts?: { entities?: MessageEntity[] }) => {
      deliver(text, opts);
      return { message_id: 100 };
    }),
    editMessageText: vi.fn(async (_chatId: number, _messageId: number, text: string, opts?: { entities?: MessageEntity[] }) => {
      deliver(text, opts);
      return true;
    }),
  };
  const ctx = { chat: { id: 111 }, message: { message_id: 1 }, api } as unknown as Context;
  return { ctx, api, delivered, latest: () => delivered.at(-1)! };
}

const bash = (command: string, content: string): ToolResultEvent => ({
  toolUseId: `t-${command}`,
  toolName: 'Bash',
  input: { command },
  content,
  isError: false,
});

/** The text an entity covers, by the UTF-16 offsets Telegram reads. */
const covered = (d: Delivered, e: MessageEntity) => d.text.slice(e.offset, e.offset + e.length);

/** A Bot API 9.5 `date_time` entity, which grammy's MessageEntity predates. */
interface DateTimeEntity extends Pick<MessageEntity, 'offset' | 'length'> {
  unix_time: number;
  date_time_format: string;
}

const dateTimes = (d: Delivered) =>
  d.entities.filter((e) => (e.type as string) === 'date_time') as unknown as DateTimeEntity[];

/** How the bottom of a live log reads, whatever the server's clock says. */
const UPDATED = String.raw`\n\n🕐 Updated \d\d:\d\d$`;

/** A status line whose text the test can change, with a command block like the bubble's. */
function statusLine(initial: string) {
  let line = initial;
  const source = vi.fn((): EntityMessage => {
    const head = `${line}\n`;
    return {
      text: `${head}npm test`,
      entities: [{ type: 'pre', offset: head.length, length: 'npm test'.length, language: 'bash' }],
    };
  });
  return { source, set: (next: string) => { line = next; } };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ActionLogger live log', () => {
  it('drops the oldest of its ten entries when they would overflow a message', async () => {
    const logger = new ActionLogger();
    const { ctx, latest } = fakeChat();
    await logger.initialize(ctx, SESSION);
    for (let i = 1; i <= 12; i++) {
      await logger.addToolResult(SESSION, bash(`cat file${i} ${'some/long/path/'.repeat(15)}`, 'x'.repeat(2000)), 20, 2000);
    }
    await vi.advanceTimersByTimeAsync(10_000);

    expect(latest().text).toContain('cat file12 ');
    expect(latest().text).toMatch(/^⏳ Action Log\n\nShowing last [1-9] of 12 actions\n/);
  });

  it('still shows ten when they fit', async () => {
    const logger = new ActionLogger();
    const { ctx, latest } = fakeChat();
    await logger.initialize(ctx, SESSION);
    for (let i = 1; i <= 12; i++) {
      await logger.addToolResult(SESSION, bash(`echo ${i}`, `${i}`), 20, 2000);
    }
    await vi.advanceTimersByTimeAsync(10_000);

    expect(latest().text).toMatch(/^⏳ Action Log\n\nShowing last 10 of 12 actions\n/);
  });

  it('draws an action that arrives inside the edit throttle once the throttle runs out', async () => {
    const logger = new ActionLogger();
    const { ctx, delivered, latest } = fakeChat();
    await logger.initialize(ctx, SESSION);
    await logger.addToolResult(SESSION, bash('cat a', 'a'), 20, 2000);
    await logger.addToolResult(SESSION, bash('cat b', 'b'), 20, 2000);
    expect(delivered).toHaveLength(1);

    // No third action needed to bring the second one in.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(delivered).toHaveLength(2);
    expect(latest().text).toContain('$ cat b');
  });

  it('sends commands and output verbatim, with the formatting as entities', async () => {
    const logger = new ActionLogger();
    const { ctx, latest } = fakeChat();
    await logger.initialize(ctx, SESSION);
    await logger.addToolResult(SESSION, bash('echo `date` > my_file.txt', 'a_b *c* [d]'), 20, 2000);

    const sent = latest();
    const byType = (type: string) => sent.entities.filter((e) => e.type === type).map((e) => covered(sent, e));
    expect(byType('bold')).toEqual(['Action Log']);
    expect(byType('code')).toEqual(['$ echo `date` > my_file.txt']);
    expect(byType('pre')).toEqual(['a_b *c* [d]']);
  });

  it('draws the status line under the newest action, and redraws it on refresh', async () => {
    const logger = new ActionLogger();
    const { ctx, delivered, latest } = fakeChat();
    const status = statusLine('⏳ 💻 Running [12s]');
    await logger.initialize(ctx, SESSION, status.source);
    expect(logger.showsStatus(SESSION)).toBe(false); // nothing posted yet

    await logger.addToolResult(SESSION, bash('ls', 'src'), 20, 2000);
    expect(logger.showsStatus(SESSION)).toBe(true);
    expect(latest().text).toMatch(new RegExp(String.raw`\n\n⏳ 💻 Running \[12s\]\nnpm test${UPDATED}`));
    const block = latest().entities.find((e) => e.type === 'pre' && e.language === 'bash')!;
    expect(covered(latest(), block)).toBe('npm test');

    // A refresh waits its slot behind the edit throttle...
    status.set('⏳ 💻 Running [22s]');
    await logger.refreshStatus(SESSION);
    expect(delivered).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(latest().text).toContain('⏳ 💻 Running [22s]');

    // ...unless it can't wait.
    status.set('⏸️ Waiting for your answer — see the question below ↓');
    await logger.refreshStatus(SESSION, true);
    expect(latest().text).toContain('⏸️ Waiting for your answer');
  });

  it('draws the prompt the turn is running under its status line, until the turn ends', async () => {
    const logger = new ActionLogger();
    const { ctx, latest } = fakeChat();
    const status = statusLine('⏳ 💻 Running [12s]');
    await logger.initialize(ctx, SESSION, status.source, 'run the\ntests and fix what fails');
    await logger.addToolResult(SESSION, bash('ls', 'src'), 20, 2000);

    expect(latest().text).toMatch(
      new RegExp(String.raw`\n\n⏳ 💻 Running \[12s\]\nnpm test\n\n▸ run the tests and fix what fails${UPDATED}`),
    );
    const italic = latest().entities.filter((e) => e.type === 'italic').map((e) => covered(latest(), e));
    expect(italic).toEqual(['▸ run the tests and fix what fails']);

    logger.endTurn(SESSION);
    await vi.advanceTimersByTimeAsync(5000);
    expect(latest().text).toMatch(/^📋 Action Log\n/);
    expect(latest().text).not.toContain('▸');
  });

  it('shows the prompt as it was sent, with the terminal UI off too', async () => {
    /** The prompt line at the bottom of a log for a turn sent `prompt`, with the terminal UI off. */
    const bottomLine = async (prompt: string) => {
      const logger = new ActionLogger();
      const { ctx, latest } = fakeChat();
      await logger.initialize(ctx, SESSION, undefined, prompt);
      await logger.addToolResult(SESSION, bash('ls', 'src'), 20, 2000);
      return latest().text.match(new RegExp(String.raw`\n([^\n]*)${UPDATED}`))?.[1];
    };

    // A skill is what the turn is running, though /tree and the status line
    // leave commands out of their lists.
    expect(await bottomLine('/code-review high')).toBe('▸ /code-review high');
    // An upload as what was uploaded, not the note it reached claude in.
    expect(await bottomLine('User uploaded an image to the project.\nSaved at: /x.png\nCaption: "what is this"'))
      .toBe('▸ 📷 Image — what is this');
    // A paragraph whole, and a longer prompt by its start and its end.
    expect(await bottomLine('run the tests '.repeat(21))).toBe(`▸ ${'run the tests '.repeat(20)}run the tests`);
    expect(await bottomLine(`${'word '.repeat(80)}what do you think?`))
      .toBe(`▸ ${'word '.repeat(38)}word … ${'word '.repeat(16)}what do you think?`);
  });

  it('stamps each action with a time that reads in the user’s timezone', async () => {
    const start = Date.UTC(2026, 10, 3, 17, 20, 0);
    vi.setSystemTime(start);
    const logger = new ActionLogger();
    const { ctx, latest } = fakeChat();
    await logger.initialize(ctx, SESSION);
    await logger.addToolResult(SESSION, bash('ls', 'src'), 20, 2000);
    await vi.advanceTimersByTimeAsync(65_000);
    await logger.addToolResult(SESSION, bash('cat a', 'a'), 20, 2000);

    const [first, second] = dateTimes(latest());
    expect(latest().text).toMatch(/^⏳ Action Log\n\n💻 ✅ \[\d\d:\d\d\] Bash result\n/);
    expect(covered(latest(), first as unknown as MessageEntity)).toMatch(/^\d\d:\d\d$/);
    expect(first).toMatchObject({ unix_time: start / 1000, date_time_format: 't' });
    expect(second).toMatchObject({ unix_time: start / 1000 + 65, date_time_format: 't' });
  });

  it('ends with the time it was drawn, which a quiet stretch still moves on, until the turn ends', async () => {
    const start = Date.UTC(2026, 10, 3, 17, 20, 0);
    vi.setSystemTime(start);
    const logger = new ActionLogger();
    const { ctx, delivered, latest } = fakeChat();
    const status = statusLine('⏳ 💻 Running [12s]');
    await logger.initialize(ctx, SESSION, status.source, 'run the tests');
    await logger.addToolResult(SESSION, bash('ls', 'src'), 20, 2000);

    const drawnAt = () => {
      const time = dateTimes(latest()).at(-1)!;
      expect(latest().text.slice(0, time.offset)).toMatch(/\n\n▸ run the tests\n\n🕐 Updated $/);
      expect(time.offset + time.length).toBe(latest().text.length);
      return time.unix_time;
    };
    expect(drawnAt()).toBe(start / 1000);

    // The status line reads the same, as it does through a long build with the
    // timer off; the refresh that comes every ten seconds still redraws.
    await logger.refreshStatus(SESSION);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(delivered).toHaveLength(2);
    expect(drawnAt()).toBe(start / 1000 + 10);

    logger.endTurn(SESSION);
    await vi.advanceTimersByTimeAsync(5000);
    expect(latest().text).toMatch(/^📋 Action Log\n/);
    expect(latest().text).not.toContain('🕐 Updated');
    expect(dateTimes(latest())).toHaveLength(1); // the action's own time
  });

  it("drops the live marker and status line as soon as the turn ends", async () => {
    const logger = new ActionLogger();
    const { ctx, latest } = fakeChat();
    const status = statusLine('⏳ 💻 Running [12s]');
    await logger.initialize(ctx, SESSION, status.source);
    await logger.addToolResult(SESSION, bash('ls', 'src'), 20, 2000);

    logger.endTurn(SESSION);
    expect(logger.showsStatus(SESSION)).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);

    expect(latest().text).toMatch(/^📋 Action Log\n/);
    expect(latest().text).not.toContain('Running');
    expect(latest().entities.some((e) => e.type === 'pre' && e.language === 'bash')).toBe(false);
  });

  it('draws again once a rate limit has passed, rather than dropping the change', async () => {
    const logger = new ActionLogger();
    const { ctx, api, latest } = fakeChat();
    await logger.initialize(ctx, SESSION);
    await logger.addToolResult(SESSION, bash('cat a', 'a'), 20, 2000);

    api.editMessageText.mockRejectedValueOnce(new GrammyError(
      'Too Many Requests',
      { ok: false, error_code: 429, description: 'Too Many Requests: retry after 30', parameters: { retry_after: 30 } },
      'editMessageText',
      {},
    ));
    await logger.addToolResult(SESSION, bash('cat b', 'b'), 20, 2000);
    await vi.advanceTimersByTimeAsync(10_000); // refused: 429
    expect(latest().text).not.toContain('$ cat b');

    await vi.advanceTimersByTimeAsync(30_000);
    expect(latest().text).toContain('$ cat b');
  });
});
