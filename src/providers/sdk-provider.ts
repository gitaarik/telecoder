import {
  sendToAgent as claudeSendToAgent,
  clearConversation as claudeClearConversation,
  setModel as claudeSetModel,
  getModel as claudeGetModel,
  clearModel as claudeClearModel,
  getCachedUsage as claudeGetCachedUsage,
} from '../claude/agent.js';
import { getModelsForBinary } from '../claude/model-catalog.js';
import type { SettingsScope } from '../utils/session-key.js';
import { resolveActiveClaudeExecutable } from '../utils/resolve-claude-bin.js';
import type { Provider, AgentOptions, AgentResponse, AgentUsage, ModelInfo } from './types.js';

export const sdkProvider: Provider = {
  name: 'claude',

  sendToAgent(sessionKey: string, message: string, options?: AgentOptions): Promise<AgentResponse> {
    return claudeSendToAgent(sessionKey, message, options);
  },

  clearConversation(sessionKey: string): void {
    claudeClearConversation(sessionKey);
  },

  setModel(scope: SettingsScope, model: string): void {
    claudeSetModel(scope, model);
  },

  getModel(scope: SettingsScope): string {
    return claudeGetModel(scope);
  },

  clearModel(scope: SettingsScope): void {
    claudeClearModel(scope);
  },

  getCachedUsage(sessionKey: string): AgentUsage | undefined {
    return claudeGetCachedUsage(sessionKey);
  },

  async getAvailableModels(): Promise<ModelInfo[]> {
    // The SDK forwards `model` to whichever binary it spawns — usually the one
    // bundled with claude-agent-sdk, which lags the CLI on PATH. Ask that
    // binary rather than assuming it matches PTY mode's.
    return getModelsForBinary(resolveActiveClaudeExecutable());
  },
};
