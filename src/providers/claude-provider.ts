
import { userPreferences } from './user-preferences.js';
import { sdkProvider } from './sdk-provider.js';
import { PtyProvider } from '../claude/pty-provider.js';
import { parseSessionKey } from '../utils/session-key.js';
import type { Provider, AgentOptions, LoopOptions, AgentResponse, AgentUsage, ModelInfo } from './types.js';

// Instantiate both providers. The router will decide which one to use.
const ptyProvider = new PtyProvider();

export function getPtyProvider(): PtyProvider {
  return ptyProvider;
}

function getMethod(chatId: number): 'sdk' | 'pty' {
  return userPreferences.getMethod(chatId) || 'sdk'; // Default to SDK
}

function getInternalProvider(chatId: number): Provider {
  const method = getMethod(chatId);
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
    const chatId = parseSessionKey(sessionKey).chatId;
    return getInternalProvider(chatId).sendToAgent(sessionKey, message, options);
  },

  sendLoopToAgent(sessionKey: string, message: string, options?: LoopOptions): Promise<AgentResponse> {
    const chatId = parseSessionKey(sessionKey).chatId;
    return getInternalProvider(chatId).sendLoopToAgent(sessionKey, message, options);
  },

  clearConversation(sessionKey: string): void {
    const chatId = parseSessionKey(sessionKey).chatId;
    getInternalProvider(chatId).clearConversation(sessionKey);
  },

  setModel(chatId: number, model: string): void {
    getInternalProvider(chatId).setModel(chatId, model);
  },

  getModel(chatId: number): string {
    return getInternalProvider(chatId).getModel(chatId);
  },

  clearModel(chatId: number): void {
    getInternalProvider(chatId).clearModel(chatId);
  },

  getCachedUsage(sessionKey: string): AgentUsage | undefined {
    const chatId = parseSessionKey(sessionKey).chatId;
    return getInternalProvider(chatId).getCachedUsage(sessionKey);
  },

  isDangerousMode(): boolean {
    // This is consistent across both methods.
    return sdkProvider.isDangerousMode();
  },

  async getAvailableModels(chatId: number): Promise<ModelInfo[]> {
    return getInternalProvider(chatId).getAvailableModels(chatId);
  },
};
