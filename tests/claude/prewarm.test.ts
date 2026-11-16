/**
 * The early start is a guess: it happens when the chat has a project, no
 * claude and room in memory, on the backend the first message will use, and
 * every other case is a quiet no.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  session: { workingDirectory: '/w/p' } as { workingDirectory: string } | undefined,
  live: false,
  processing: false,
  provider: 'claude' as 'claude' | 'ccr',
  ccr: { status: 'ok' } as { status: string; message?: string },
  /** Runs when the CCR check is awaited, to stand in for a message arriving meanwhile. */
  duringCcrCheck: () => {},
  roomInMemory: true,
  guardAsked: [] as string[],
  started: [] as Array<{ key: string; options: Record<string, unknown> }>,
  startThrows: null as Error | null,
}));

vi.mock('../../src/claude/session-manager.js', () => ({
  sessionManager: { getSession: () => fake.session },
}));
vi.mock('../../src/providers/claude-provider.js', () => ({
  getPtyProvider: () => ({
    hasLiveSession: () => fake.live,
    prewarm: (key: string, options: Record<string, unknown>) => {
      if (fake.startThrows) throw fake.startThrows;
      fake.started.push({ key, options });
      return true;
    },
  }),
}));
vi.mock('../../src/providers/provider-router.js', () => ({
  getActiveProviderName: () => fake.provider,
}));
vi.mock('../../src/providers/ccr-health.js', () => ({
  ensureCcrRunning: async () => { fake.duringCcrCheck(); return fake.ccr; },
}));
vi.mock('../../src/claude/ccr-shim.js', () => ({
  getCcrShimPath: () => '/state/claude-via-ccr.sh',
}));
vi.mock('../../src/claude/memory-guard.js', () => ({
  allowPrewarm: (key: string) => { fake.guardAsked.push(key); return fake.roomInMemory; },
}));
vi.mock('../../src/claude/request-queue.js', () => ({
  isProcessing: () => fake.processing,
}));

const { prewarmClaude } = await import('../../src/claude/prewarm.js');
const { config } = await import('../../src/config.js');

const KEY = '4242';
const ctx = { chat: { id: 4242 } } as never;

describe('prewarmClaude', () => {
  beforeEach(() => {
    fake.session = { workingDirectory: '/w/p' };
    fake.live = false;
    fake.processing = false;
    fake.provider = 'claude';
    fake.ccr = { status: 'ok' };
    fake.duringCcrCheck = () => {};
    fake.roomInMemory = true;
    fake.guardAsked = [];
    fake.started = [];
    fake.startThrows = null;
    (config as { PREWARM_CLAUDE: boolean }).PREWARM_CLAUDE = true;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('starts claude for a chat with a project and none running', async () => {
    expect(await prewarmClaude(ctx, KEY)).toBe(true);
    expect(fake.started).toEqual([{ key: KEY, options: { providerName: 'claude', telegramCtx: ctx } }]);
  });

  it('starts it before returning to the caller on the Claude backend', () => {
    void prewarmClaude(ctx, KEY);
    expect(fake.started).toHaveLength(1);
  });

  it('does nothing when the setting is off', async () => {
    (config as { PREWARM_CLAUDE: boolean }).PREWARM_CLAUDE = false;
    expect(await prewarmClaude(ctx, KEY)).toBe(false);
    expect(fake.started).toEqual([]);
    expect(fake.guardAsked).toEqual([]);
  });

  it('does nothing without a project, with a claude already running, or mid-turn', async () => {
    fake.session = undefined;
    expect(await prewarmClaude(ctx, KEY)).toBe(false);
    fake.session = { workingDirectory: '/w/p' };
    fake.live = true;
    expect(await prewarmClaude(ctx, KEY)).toBe(false);
    fake.live = false;
    fake.processing = true;
    expect(await prewarmClaude(ctx, KEY)).toBe(false);
    expect(fake.started).toEqual([]);
    // None of them got as far as counting a spawn against memory.
    expect(fake.guardAsked).toEqual([]);
  });

  it('skips quietly when memory is short', async () => {
    fake.roomInMemory = false;
    expect(await prewarmClaude(ctx, KEY)).toBe(false);
    expect(fake.guardAsked).toEqual([KEY]);
    expect(fake.started).toEqual([]);
  });

  it('starts a CCR chat through the wrapper, once the proxy is up', async () => {
    fake.provider = 'ccr';
    fake.ccr = { status: 'started' };
    expect(await prewarmClaude(undefined, KEY)).toBe(true);
    expect(fake.started).toEqual([
      { key: KEY, options: { providerName: 'ccr', executableOverride: '/state/claude-via-ccr.sh' } },
    ]);
  });

  it('leaves a CCR chat for its first message when the proxy is down', async () => {
    fake.provider = 'ccr';
    fake.ccr = { status: 'not_running', message: 'down' };
    expect(await prewarmClaude(ctx, KEY)).toBe(false);
    expect(fake.started).toEqual([]);
    expect(fake.guardAsked).toEqual([]);
  });

  it('gives way to a message that arrived while the proxy was being checked', async () => {
    fake.provider = 'ccr';
    fake.duringCcrCheck = () => { fake.processing = true; };
    expect(await prewarmClaude(ctx, KEY)).toBe(false);
    expect(fake.started).toEqual([]);
  });

  it('turns a failed start into a log line with the secrets taken out', async () => {
    fake.startThrows = new Error('spawn failed for 123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(await prewarmClaude(ctx, KEY)).toBe(false);
    const logged = vi.mocked(console.warn).mock.calls.flat().join(' ');
    expect(logged).toContain("couldn't start claude early");
    expect(logged).not.toContain('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  });
});
