import { describe, it, expect, vi } from 'vitest';

const HOME = '/w/sjs';
let workingDirectory = HOME;

const syncThreadTitle = vi.fn();
vi.mock('../../src/telegram/thread-titles.js', () => ({ syncThreadTitle }));
vi.mock('../../src/utils/home-project.js', () => ({ isHomeProject: (dir?: string) => dir === HOME }));
vi.mock('../../src/claude/session-history.js', () => ({ sessionHistory: { updateTopic: vi.fn() } }));
vi.mock('../../src/claude/session-manager.js', () => ({
  sessionManager: { getSession: () => ({ workingDirectory }) },
}));
vi.mock('../../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config.js')>();
  return { ...actual, config: { ...actual.config, BOT_NAME: 'TeleCoder — sjs' } };
});

const { setSessionTopic, buildBotDisplayName } = await import('../../src/bot/handlers/command/topic-store.js');

describe('a bot with a home project', () => {
  it("names its threads and itself without the project while it's home", () => {
    workingDirectory = HOME;

    setSessionTopic('1:2', 'Scraper · Fixing the login');

    expect(syncThreadTitle).toHaveBeenLastCalledWith('1:2', 'Scraper · Fixing the login', undefined);
    expect(buildBotDisplayName('1:2')).toBe('TeleCoder — sjs');
  });

  it('puts the project back in front once a thread is somewhere else', () => {
    workingDirectory = '/w/telecoder';

    setSessionTopic('1:2', 'Thread titles · Testing');

    expect(syncThreadTitle).toHaveBeenLastCalledWith('1:2', 'Thread titles · Testing', 'telecoder');
    expect(buildBotDisplayName('1:2')).toBe('TeleCoder — sjs — telecoder');
  });
});
