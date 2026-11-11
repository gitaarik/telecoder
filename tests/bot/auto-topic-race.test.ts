import { describe, it, expect, beforeEach, vi } from 'vitest';

const KEY = '42:7';

let haikuAnswer: (topic: string) => void;
const summarize = vi.fn(() => new Promise<string>((resolve) => { haikuAnswer = resolve; }));
let lastSetAt: number | undefined;
const setSessionTopic = vi.fn(() => { lastSetAt = Date.now(); return ''; });

vi.mock('../../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config.js')>();
  return { ...actual, config: { ...actual.config, AUTO_TOPIC_HAIKU: true } };
});
vi.mock('../../src/claude/auto-topic-haiku.js', () => ({ summarizeTopicWithHaiku: summarize }));
vi.mock('../../src/telegram/botname-settings.js', () => ({ isBotNameEnabled: () => true }));
vi.mock('../../src/claude/session-manager.js', () => ({
  sessionManager: { getSession: () => ({ workingDirectory: '/home/rik/dev/telecoder' }) },
}));
vi.mock('../../src/bot/handlers/command.handler.js', () => ({
  getSessionTopic: () => 'TeleCoder · Old task',
  setSessionTopic,
}));
vi.mock('../../src/bot/handlers/command/topic-store.js', () => ({
  getMsSinceTopicSet: () => (lastSetAt === undefined ? undefined : Date.now() - lastSetAt),
}));

const { fireAutoTopic } = await import('../../src/bot/handlers/message/shared.js');

describe('auto topic', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    summarize.mockClear();
    setSessionTopic.mockClear();
    lastSetAt = undefined;
  });

  it("tells Haiku the project, so GENERAL isn't just that", () => {
    fireAutoTopic({} as never, KEY, 'Make thread titles show the project');

    expect(summarize).toHaveBeenCalledWith('Make thread titles show the project', 'TeleCoder · Old task', 'telecoder');
  });

  it('sets the topic Haiku comes back with', async () => {
    fireAutoTopic({} as never, KEY, 'Make thread titles show the project');
    vi.advanceTimersByTime(3000);
    haikuAnswer('Thread titles · Project in front');
    await vi.waitFor(() => expect(setSessionTopic).toHaveBeenCalledWith(KEY, 'Thread titles · Project in front'));
  });

  it('drops its answer when a topic was set while it was thinking', async () => {
    fireAutoTopic({} as never, KEY, 'Can you set a topic for this thread?');
    vi.advanceTimersByTime(1000);
    lastSetAt = Date.now(); // the agent calls telecoder_set_topic
    vi.advanceTimersByTime(3000);
    haikuAnswer('TeleCoder · Project rebuilt');
    await vi.advanceTimersByTimeAsync(0);

    expect(setSessionTopic).not.toHaveBeenCalled();
  });
});
