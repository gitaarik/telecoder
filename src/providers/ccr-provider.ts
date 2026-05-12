import {
  sendToAgent as claudeSendToAgent,
  sendLoopToAgent as claudeSendLoopToAgent,
  clearConversation as claudeClearConversation,
  setModel as claudeSetModel,
  getModel as claudeGetModel,
  clearModel as claudeClearModel,
  getCachedUsage as claudeGetCachedUsage,
  isDangerousMode as claudeIsDangerousMode,
} from '../claude/agent.js';
import { getCcrShimPath } from '../claude/ccr-shim.js';
import type { Provider, AgentOptions, LoopOptions, AgentResponse, AgentUsage, ModelInfo } from './types.js';

// CCR's router config decides the actual backend model per request — the
// SDK-level model name is largely advisory. We expose the same labels the
// Claude provider does so the /model UI keeps working.
const CCR_MODELS: ModelInfo[] = [
  { id: 'opus', label: 'opus', description: 'Routed via CCR' },
  { id: 'sonnet', label: 'sonnet', description: 'Routed via CCR' },
  { id: 'haiku', label: 'haiku', description: 'Routed via CCR' },
];

function withShim<T extends AgentOptions | LoopOptions>(options?: T): T {
  const shim = getCcrShimPath();
  return { ...(options ?? {}), executableOverride: shim } as T;
}

export const ccrProvider: Provider = {
  name: 'ccr',

  sendToAgent(sessionKey: string, message: string, options?: AgentOptions): Promise<AgentResponse> {
    return claudeSendToAgent(sessionKey, message, withShim(options));
  },

  sendLoopToAgent(sessionKey: string, message: string, options?: LoopOptions): Promise<AgentResponse> {
    return claudeSendLoopToAgent(sessionKey, message, withShim(options));
  },

  clearConversation(sessionKey: string): void {
    claudeClearConversation(sessionKey);
  },

  setModel(chatId: number, model: string): void {
    claudeSetModel(chatId, model);
  },

  getModel(chatId: number): string {
    return claudeGetModel(chatId);
  },

  clearModel(chatId: number): void {
    claudeClearModel(chatId);
  },

  getCachedUsage(sessionKey: string): AgentUsage | undefined {
    return claudeGetCachedUsage(sessionKey);
  },

  isDangerousMode(): boolean {
    return claudeIsDangerousMode();
  },

  async getAvailableModels(): Promise<ModelInfo[]> {
    return CCR_MODELS;
  },
};
