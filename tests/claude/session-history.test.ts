/**
 * Session history is kept most-recently-used first: whatever conversation a
 * chat is in sits at index 0, because that is where the topic, the startup
 * prompt and the restore after a restart all look for it.
 *
 * Drives the real session manager and history store, with home redirected to
 * a scratch dir so nothing here touches the real ~/.claudegram.
 */

import { describe, it, expect, vi, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const mocked = { ...actual, homedir: () => process.env.TELECODER_TEST_HOME ?? actual.homedir() };
  return { ...mocked, default: mocked };
});

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-history-'));
process.env.TELECODER_TEST_HOME = home;

const { sessionManager } = await import('../../src/claude/session-manager.js');
const { sessionHistory } = await import('../../src/claude/session-history.js');

afterAll(() => {
  delete process.env.TELECODER_TEST_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

/** A conversation in `key` that got as far as a Claude session. */
function converse(key: string, claudeSessionId: string, topic?: string): string {
  const session = sessionManager.getSession(key)
    ? sessionManager.startNewConversation(key)!
    : sessionManager.createSession(key, home);
  sessionManager.setClaudeSessionId(key, claudeSessionId);
  if (topic) sessionHistory.updateTopic(key, topic);
  return session.conversationId;
}

const idsIn = (key: string) => sessionHistory.getHistory(key, 50).map((e) => e.claudeSessionId);

describe('going back to an older conversation', () => {
  it('puts it first, where a restart looks for it', () => {
    const key = 'chat-restore';
    const older = converse(key, 'older');
    converse(key, 'newer');

    sessionManager.resumeSession(key, older);

    expect(idsIn(key)).toEqual(['older', 'newer']);
    expect(sessionHistory.getLastSession(key)?.claudeSessionId).toBe('older');
    expect(sessionHistory.getLastResumableSession(key)?.claudeSessionId).toBe('older');
  });

  it('keeps its topic on its own entry, not the newest one', () => {
    const key = 'chat-topic';
    const older = converse(key, 'older', 'Parser split');
    converse(key, 'newer', 'Release notes');

    sessionManager.resumeSession(key, older);
    sessionHistory.updateTopic(key, 'Parser split · adding tests');

    const byId = Object.fromEntries(sessionHistory.getHistory(key, 50).map((e) => [e.claudeSessionId, e.topic]));
    expect(byId).toEqual({ older: 'Parser split · adding tests', newer: 'Release notes' });
  });
});

describe('the history cap', () => {
  it('drops the conversation used longest ago, not the one started first', () => {
    const key = 'chat-cap';
    const first = converse(key, 's0');
    for (let i = 1; i < 20; i++) converse(key, `s${i}`);

    // Back to the first one, then one more conversation pushes the list past 20.
    sessionManager.resumeSession(key, first);
    converse(key, 's20');

    const ids = idsIn(key);
    expect(ids).toHaveLength(20);
    expect(ids).toContain('s0');
    expect(ids).not.toContain('s1');
  });
});

describe('a history file written in creation order', () => {
  it('is read back most recently used first', () => {
    const botId = 'legacy-bot';
    const entry = (claudeSessionId: string, createdAt: string, lastActivity: string) => ({
      conversationId: `conv-${claudeSessionId}`,
      claudeSessionId,
      projectPath: home,
      projectName: path.basename(home),
      lastMessagePreview: '',
      createdAt,
      lastActivity,
    });
    const stateDir = path.join(home, '.claudegram');
    fs.mkdirSync(stateDir, { recursive: true });
    // The newest-created conversation first, though the chat went back to the
    // older one after it and was last active there.
    fs.writeFileSync(path.join(stateDir, `sessions-${botId}.json`), JSON.stringify({
      sessions: {
        'chat-legacy': [
          entry('newer', '2026-09-29T10:00:00.000Z', '2026-09-29T10:05:00.000Z'),
          entry('older', '2026-09-28T10:00:00.000Z', '2026-09-29T11:00:00.000Z'),
        ],
      },
    }));

    sessionHistory.initForBot(botId);

    expect(idsIn('chat-legacy')).toEqual(['older', 'newer']);
  });
});
