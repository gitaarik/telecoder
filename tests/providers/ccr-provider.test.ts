/**
 * The CCR provider is the pty provider with CCR's wrapper script in claude's
 * place. It owns nothing else: no session, no model state of its own.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const pty = vi.hoisted(() => ({
  sendToAgent: vi.fn(async () => ({ text: 'from the pty', toolsUsed: [] })),
  clearConversation: vi.fn(),
  setModel: vi.fn(),
  getModel: vi.fn(() => 'sonnet'),
  clearModel: vi.fn(),
  getCachedUsage: vi.fn(() => ({ inputTokens: 1 })),
}));
const health = vi.hoisted(() => ({ result: { status: 'ok', message: '' } as { status: string; message: string } }));

vi.mock('../../src/providers/claude-provider.js', () => ({ getPtyProvider: () => pty }));
vi.mock('../../src/claude/ccr-shim.js', () => ({ getCcrShimPath: () => '/state/claude-via-ccr.sh' }));
vi.mock('../../src/providers/ccr-health.js', () => ({ ensureCcrRunning: async () => health.result }));

const { ccrProvider } = await import('../../src/providers/ccr-provider.js');

describe('ccrProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    health.result = { status: 'ok', message: '' };
  });

  it('runs the turn in the pty with the wrapper script as the executable', async () => {
    const abortController = new AbortController();
    const response = await ccrProvider.sendToAgent('chat1', 'hello', { providerName: 'ccr', abortController });
    expect(response.text).toBe('from the pty');
    expect(pty.sendToAgent).toHaveBeenCalledWith('chat1', 'hello', {
      providerName: 'ccr',
      abortController,
      executableOverride: '/state/claude-via-ccr.sh',
    });
  });

  it('does not reach the pty when the proxy is down and cannot be started', async () => {
    health.result = { status: 'down', message: 'CCR is not reachable at http://localhost:3456' };
    const response = await ccrProvider.sendToAgent('chat1', 'hello');
    expect(response.text).toBe('⚠️ CCR is not reachable at http://localhost:3456');
    expect(pty.sendToAgent).not.toHaveBeenCalled();
  });

  it('keeps model and session state in the pty provider', () => {
    ccrProvider.setModel('chat1', 'opus');
    expect(pty.setModel).toHaveBeenCalledWith('chat1', 'opus');
    expect(ccrProvider.getModel('chat1')).toBe('sonnet');
    ccrProvider.clearModel('chat1');
    expect(pty.clearModel).toHaveBeenCalledWith('chat1');
    ccrProvider.clearConversation('chat1');
    expect(pty.clearConversation).toHaveBeenCalledWith('chat1');
    expect(ccrProvider.getCachedUsage('chat1')).toEqual({ inputTokens: 1 });
  });

  it('offers the three tiers CCR routes on', async () => {
    const models = await ccrProvider.getAvailableModels('chat1');
    expect(models.map((m) => m.id)).toEqual(['opus', 'sonnet', 'haiku']);
  });
});
