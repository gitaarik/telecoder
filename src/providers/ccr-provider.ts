import { getPtyProvider } from './claude-provider.js';
import { getCcrShimPath } from '../claude/ccr-shim.js';
import type { SettingsScope } from '../utils/session-key.js';
import { ensureCcrRunning } from './ccr-health.js';
import type { AgentOptions, AgentResponse, AgentUsage, ModelInfo, Provider } from './types.js';

// CCR's router config decides the actual backend model per request — the
// model name claude is started with is largely advisory. Deliberately just the
// three tiers CCR configs actually route on, rather than the Claude provider's
// full alias list: aliases like `opusplan` or `fable[1m]` mean nothing to a
// router whose rules key off opus/sonnet/haiku.
const CCR_MODELS: ModelInfo[] = [
  { id: 'opus', label: 'opus', description: 'Routed via CCR' },
  { id: 'sonnet', label: 'sonnet', description: 'Routed via CCR' },
  { id: 'haiku', label: 'haiku', description: 'Routed via CCR' },
];

/**
 * The same pty as the Claude provider's, spawning CCR's wrapper script in
 * place of `claude`: it exports the proxy's address and token and execs the
 * real binary, so nothing about the session changes but where its requests
 * go. The pty respawns when a chat switches backend, and the provider switch
 * forks the session first (see provider-switch.ts), since one backend's
 * thinking blocks can't be replayed against another.
 */
function withShim<T extends AgentOptions>(options?: T): T {
  const shim = getCcrShimPath();
  return { ...(options ?? {}), executableOverride: shim } as T;
}

async function preflightOrFailure(): Promise<AgentResponse | undefined> {
  const result = await ensureCcrRunning();
  if (result.status === 'ok' || result.status === 'started') return undefined;
  return { text: `⚠️ ${result.message}`, toolsUsed: [] };
}

export const ccrProvider: Provider = {
  name: 'ccr',

  async sendToAgent(sessionKey: string, message: string, options?: AgentOptions): Promise<AgentResponse> {
    const failure = await preflightOrFailure();
    if (failure) return failure;
    return getPtyProvider().sendToAgent(sessionKey, message, withShim(options));
  },

  clearConversation(sessionKey: string): void {
    getPtyProvider().clearConversation(sessionKey);
  },

  setModel(scope: SettingsScope, model: string): void {
    getPtyProvider().setModel(scope, model);
  },

  getModel(scope: SettingsScope): string {
    return getPtyProvider().getModel(scope);
  },

  clearModel(scope: SettingsScope): void {
    getPtyProvider().clearModel(scope);
  },

  getCachedUsage(sessionKey: string): AgentUsage | undefined {
    return getPtyProvider().getCachedUsage(sessionKey);
  },

  async getAvailableModels(): Promise<ModelInfo[]> {
    return CCR_MODELS;
  },
};
