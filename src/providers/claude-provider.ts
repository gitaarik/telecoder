
import { userPreferences } from './user-preferences.js';
import { sdkProvider } from './sdk-provider.js';
import { PtyProvider } from '../claude/pty-provider.js';
import type { SettingsScope } from '../utils/session-key.js';
import { config } from '../config.js';
import type { Provider, AgentOptions, LoopOptions, AgentResponse, AgentUsage, ModelInfo } from './types.js';

// Instantiate both providers. The router will decide which one to use.
const ptyProvider = new PtyProvider();

export function getPtyProvider(): PtyProvider {
  return ptyProvider;
}

function getMethod(scope: SettingsScope): 'sdk' | 'pty' {
  // The thread's or chat's /method wins; CLAUDE_METHOD_DEFAULT decides for one
  // that has never picked one. A supervised bot sets it to 'pty', where the permission
  // gate's PreToolUse hook actually runs.
  return userPreferences.getMethod(scope) || config.CLAUDE_METHOD_DEFAULT;
}

/**
 * Which transport this chat's turns run through. Exported for the handlers
 * that need to match the transport's behaviour without routing a turn — e.g.
 * inspecting the CLI build that would actually serve the chat.
 */
export function getActiveMethod(scope: SettingsScope): 'sdk' | 'pty' {
  return getMethod(scope);
}

function getInternalProvider(scope: SettingsScope): Provider {
  const method = getMethod(scope);
  if (method === 'pty') {
    return ptyProvider;
  }
  return sdkProvider;
}

// This new claudeProvider is a router that delegates to either the
// SDK or PTY provider based on user preference.
export const claudeProvider: Provider = {
  name: 'claude',

  sendToAgent(sessionKey: string, message: string, options?: AgentOptions): Promise<AgentResponse> {
    return getInternalProvider(sessionKey).sendToAgent(sessionKey, message, options);
  },

  sendLoopToAgent(sessionKey: string, message: string, options?: LoopOptions): Promise<AgentResponse> {
    return getInternalProvider(sessionKey).sendLoopToAgent(sessionKey, message, options);
  },

  clearConversation(sessionKey: string): void {
    getInternalProvider(sessionKey).clearConversation(sessionKey);
  },

  setModel(scope: SettingsScope, model: string): void {
    getInternalProvider(scope).setModel(scope, model);
  },

  getModel(scope: SettingsScope): string {
    return getInternalProvider(scope).getModel(scope);
  },

  clearModel(scope: SettingsScope): void {
    getInternalProvider(scope).clearModel(scope);
  },

  getCachedUsage(sessionKey: string): AgentUsage | undefined {
    return getInternalProvider(sessionKey).getCachedUsage(sessionKey);
  },

  isDangerousMode(): boolean {
    // This is consistent across both methods.
    return sdkProvider.isDangerousMode();
  },

  async getAvailableModels(scope: SettingsScope): Promise<ModelInfo[]> {
    return getInternalProvider(scope).getAvailableModels(scope);
  },
};
