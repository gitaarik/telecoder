/**
 * The user setup at the spawn itself.
 *
 * user-setup.test.ts covers the decision. This covers what a pty is started
 * with because of it, and the one moment the decision changes under a live
 * pty: the bot gains its first guest. That pty was started with the owner's
 * instructions and connectors, so it can't serve the conversation's next
 * message; it is replaced, and the conversation resumes in the new one.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const fake = vi.hoisted(() => {
  process.env.CLAUDE_BIN = '/bin/true';
  class FakeTerm {
    pid = 4242;
    killed = false;
    onData() { return { dispose() {} }; }
    onExit() { return { dispose() {} }; }
    write() {}
    resize() {}
    kill() { this.killed = true; }
  }
  return {
    FakeTerm,
    spawns: [] as Array<{ args: string[]; term: InstanceType<typeof FakeTerm> }>,
    guests: false,
  };
});

vi.mock('node-pty', () => ({
  spawn: (_file: string, args: string[]) => {
    const term = new fake.FakeTerm();
    fake.spawns.push({ args, term });
    return term;
  },
}));

vi.mock('../../src/utils/admins.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/admins.js')>();
  return { ...actual, hasGuestUsers: () => fake.guests };
});

vi.mock('../../src/claude/session-manager.js', () => ({
  sessionManager: {
    getSession: () => ({ workingDirectory: process.cwd(), claudeSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }),
    setClaudeSessionId: () => {},
    startNewConversation: () => {},
  },
}));

vi.mock('../../src/claude/session-jsonl.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/claude/session-jsonl.js')>();
  return { ...actual, claudeSessionFileExists: () => true, hasForeignThinkingSignatures: () => false };
});

vi.mock('../../src/claude/ipc-server.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/claude/ipc-server.js')>();
  return { ...actual, getIpcPort: () => 45678 };
});

const { PtyProvider } = await import('../../src/claude/pty-provider.js');

type Internals = { _getOrCreateSession(key: string): unknown };
const KEY = '4242';

/** The value that follows `flag` in a spawn's arguments. */
function valueOf(args: string[], flag: string): string {
  return args[args.indexOf(flag) + 1];
}

describe('the user setup at spawn', () => {
  beforeEach(() => {
    fake.spawns.length = 0;
    fake.guests = false;
  });

  it('starts claude as a terminal would on a bot with no guests', () => {
    (new PtyProvider() as unknown as Internals)._getOrCreateSession(KEY);
    const { args } = fake.spawns[0];
    expect(args).not.toContain('--setting-sources');
    expect(args).not.toContain('--strict-mcp-config');
  });

  it('keeps the user settings and the account\'s MCP servers out on a bot with guests', () => {
    fake.guests = true;
    (new PtyProvider() as unknown as Internals)._getOrCreateSession(KEY);
    const { args } = fake.spawns[0];
    expect(valueOf(args, '--setting-sources')).toBe('project,local');
    expect(args).toContain('--strict-mcp-config');
  });

  it.each([false, true])('passes its own settings and MCP server either way (guests: %s)', (guests) => {
    fake.guests = guests;
    (new PtyProvider() as unknown as Internals)._getOrCreateSession(KEY);
    const { args } = fake.spawns[0];
    expect(JSON.parse(valueOf(args, '--settings'))).toMatchObject({ editorMode: 'normal' });
    expect(Object.keys(JSON.parse(valueOf(args, '--mcp-config')).mcpServers)).toContain('telecoder-tools');
  });

  it('keeps the live pty while the roster stays as it was', () => {
    const provider = new PtyProvider() as unknown as Internals;
    const first = provider._getOrCreateSession(KEY);
    expect(provider._getOrCreateSession(KEY)).toBe(first);
    expect(fake.spawns).toHaveLength(1);
  });

  it('replaces a pty started with the setup once the bot has a guest, resuming the conversation', () => {
    const provider = new PtyProvider() as unknown as Internals;
    provider._getOrCreateSession(KEY);
    fake.guests = true;
    provider._getOrCreateSession(KEY);

    expect(fake.spawns).toHaveLength(2);
    expect(fake.spawns[0].term.killed).toBe(true);
    expect(fake.spawns[1].args).toContain('--strict-mcp-config');
    expect(fake.spawns[1].args).toContain('--resume');
  });

  it('gives the setup back at the next message once the last guest is gone', () => {
    fake.guests = true;
    const provider = new PtyProvider() as unknown as Internals;
    provider._getOrCreateSession(KEY);
    fake.guests = false;
    provider._getOrCreateSession(KEY);

    expect(fake.spawns).toHaveLength(2);
    expect(fake.spawns[1].args).not.toContain('--strict-mcp-config');
  });
});
