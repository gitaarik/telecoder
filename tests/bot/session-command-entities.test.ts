/**
 * The session, project and topic commands send entities, never a parse mode:
 * a project path, a topic or a session name goes out verbatim, however many
 * underscores, dots or brackets it has.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'grammy';

const state: {
  session?: { workingDirectory: string; conversationId: string; claudeSessionId?: string; lastActivity: Date };
  history: Array<{ conversationId: string; projectName: string; topic?: string; claudeSessionId?: string; lastActivity: string }>;
} = { history: [] };

vi.mock('../../src/claude/session-manager.js', () => ({
  sessionManager: {
    getSession: () => state.session,
    getOrRestoreSession: () => state.session,
    getSessionHistory: () => state.history,
  },
}));

const setSessionTopic = vi.fn();
vi.mock('../../src/bot/handlers/command/topic-store.js', () => ({
  setSessionTopic,
  clearTopic: vi.fn(),
  restoreTopic: vi.fn(),
  getSessionTopic: vi.fn(),
  getMsSinceTopicSet: vi.fn(),
}));

const { handleTopic } = await import('../../src/bot/handlers/command/topic.js');
const { handleClear, handleSessions, handleTeleport } = await import('../../src/bot/handlers/command/session.js');

function chat(command: string) {
  const reply = vi.fn(async (_text: string, _opts?: Record<string, unknown>) => ({}));
  const ctx = { chat: { id: 77, type: 'private' }, message: { text: command }, reply } as unknown as Context;
  return { ctx, reply };
}

/** The text covered by each entity, keyed by type, to read a message's formatting at a glance. */
function spans(text: string, opts?: Record<string, unknown>): Array<[string, string]> {
  expect(opts).not.toHaveProperty('parse_mode');
  const entities = (opts?.entities ?? []) as Array<{ type: string; offset: number; length: number }>;
  return entities.map((e) => [e.type, text.slice(e.offset, e.offset + e.length)]);
}

beforeEach(() => {
  state.session = undefined;
  state.history = [];
});

describe('/topic', () => {
  it('names the topic in bold, verbatim', async () => {
    const { ctx, reply } = chat('/topic fix_the (parser).');
    await handleTopic(ctx);
    const [text, opts] = reply.mock.calls[0];
    expect(text).toBe('✅ Topic: fix_the (parser).');
    expect(spans(text, opts)).toEqual([['bold', 'fix_the (parser).']]);
  });
});

describe('/clear', () => {
  it('asks before clearing, naming the project as typed', async () => {
    state.session = { workingDirectory: '/work/my_app.v2', conversationId: 'c1', lastActivity: new Date() };
    const { ctx, reply } = chat('/clear');
    await handleClear(ctx);
    const [text, opts] = reply.mock.calls[0];
    expect(text).toBe(
      '⚠️ Clear conversation?\n\nThis wipes the conversation history for my_app.v2. The project stays selected.\n\n' +
      'This cannot be undone.\n\n💡 Tip: /clear -y skips this confirmation.',
    );
    expect(spans(text, opts)).toEqual([
      ['bold', 'Clear conversation?'],
      ['bold', 'my_app.v2'],
      ['italic', 'This cannot be undone.'],
      ['code', '/clear -y'],
    ]);
    expect(opts?.reply_markup).toBeDefined();
  });
});

describe('/sessions', () => {
  it('lists projects as code and topics in italics', async () => {
    state.history = [
      { conversationId: 'c1', projectName: 'my_app', topic: 'a *bold* idea', lastActivity: new Date().toISOString() },
    ];
    const { ctx, reply } = chat('/sessions');
    await handleSessions(ctx);
    const [text, opts] = reply.mock.calls[0];
    expect(text).toContain('• my_app (');
    expect(text).toContain(' — a *bold* idea');
    expect(spans(text, opts)).toEqual(expect.arrayContaining([
      ['bold', 'Sessions'],
      ['code', 'my_app'],
      ['italic', 'a *bold* idea'],
      ['code', '/resume'],
    ]));
  });
});

describe('/teleport', () => {
  it('puts the command in a pre block, quotes and all', async () => {
    state.session = {
      workingDirectory: '/work/my app',
      conversationId: 'c1',
      claudeSessionId: 'abcdef12-3456',
      lastActivity: new Date(),
    };
    const { ctx, reply } = chat('/teleport');
    await handleTeleport(ctx);
    const [text, opts] = reply.mock.calls[0];
    expect(spans(text, opts)).toEqual(expect.arrayContaining([
      ['code', 'my app'],
      ['code', 'abcdef12...'],
      ['pre', expect.stringMatching(/^cd "\/work\/my app" && .+ --resume abcdef12-3456$/)],
    ]));
  });
});
