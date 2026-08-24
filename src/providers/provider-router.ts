import type { Context } from 'grammy';
import { config } from '../config.js';
import { claudeProvider } from './claude-provider.js';
import { ccrProvider } from './ccr-provider.js';
import {
  setEffort as claudeSetEffort,
  getEffort as claudeGetEffort,
  clearEffort as claudeClearEffort,
  isValidEffortLevel,
  type EffortLevel,
} from '../claude/agent.js';
import { userPreferences } from './user-preferences.js';
import { parseSessionKey } from '../utils/session-key.js';
import type { Provider, ProviderName, AgentOptions, LoopOptions, AgentResponse, AgentUsage, ModelInfo } from './types.js';

// Re-export types for consumers
export type { AgentUsage, AgentResponse, AgentOptions, LoopOptions, ModelInfo, ProviderName };

// Per-chat provider selection (in-memory cache)
const chatProviders = new Map<number, ProviderName>();

// Load persisted preferences on startup
function loadPersistedProvider(chatId: number): ProviderName | undefined {
  return userPreferences.getProvider(chatId);
}

function savePersistedProvider(chatId: number, provider: ProviderName): void {
  userPreferences.setProvider(chatId, provider);
}

function getProvider(chatId: number): Provider {
  const name = getActiveProviderName(chatId);
  if (name === 'ccr') {
    if (!config.CCR_ENABLED) {
      console.warn('[ProviderRouter] CCR provider selected but CCR_ENABLED=false; falling back to Claude');
      return claudeProvider;
    }
    return ccrProvider;
  }
  return claudeProvider;
}

// --- Public API (identical signatures to agent.ts) ---

export function getActiveProviderName(chatId: number): ProviderName {
  if (!config.CCR_ENABLED) return 'claude';
  // Check in-memory cache first
  const cached = chatProviders.get(chatId);
  if (cached) return cached;
  // Load from persistence
  const persisted = loadPersistedProvider(chatId);
  if (persisted) {
    chatProviders.set(chatId, persisted);
    return persisted;
  }
  return 'claude';
}

export async function setActiveProvider(chatId: number, provider: ProviderName): Promise<void> {
  chatProviders.set(chatId, provider);
  savePersistedProvider(chatId, provider);
}

export function getAvailableProviders(): ProviderName[] {
  const list: ProviderName[] = ['claude'];
  if (config.CCR_ENABLED) list.push('ccr');
  return list;
}

/**
 * The screening point for guest messages.
 *
 * Every user-originated prompt funnels through the two exports below — typed
 * text, a transcribed voice note, a photo caption, a reply, /plan, /explore,
 * /btw — so this is the one place a hold can be applied without having to be
 * remembered at a dozen call sites. Loop iterations and scheduled fires call
 * their provider directly and are deliberately not re-screened: they are
 * continuations of a prompt that was already screened once.
 *
 * A blocked message returns as an ordinary response rather than an error, so
 * the streaming UI already in flight renders the explanation in place.
 */
async function screened(
  sessionKey: string,
  message: string,
  options: { telegramCtx?: unknown } | undefined,
): Promise<AgentResponse | null> {
  const { screenPrompt } = await import('../claude/prompt-hold.js');
  const outcome = await screenPrompt(options?.telegramCtx as Context | undefined, sessionKey, message);
  if (outcome.proceed) return null;
  return { text: outcome.message, toolsUsed: [] };
}

export async function sendToAgent(
  sessionKey: string,
  message: string,
  options?: AgentOptions
): Promise<AgentResponse> {
  const blocked = await screened(sessionKey, message, options);
  if (blocked) return blocked;

  const chatId = parseSessionKey(sessionKey).chatId;
  const providerName = getActiveProviderName(chatId);
  return getProvider(chatId).sendToAgent(sessionKey, message, { ...options, providerName });
}

export async function sendLoopToAgent(
  sessionKey: string,
  message: string,
  options?: LoopOptions
): Promise<AgentResponse> {
  const blocked = await screened(sessionKey, message, options);
  if (blocked) return blocked;

  const chatId = parseSessionKey(sessionKey).chatId;
  const providerName = getActiveProviderName(chatId);
  return getProvider(chatId).sendLoopToAgent(sessionKey, message, { ...options, providerName });
}

export function clearConversation(sessionKey: string): void {
  // Clear all providers to avoid stale state
  claudeProvider.clearConversation(sessionKey);
  ccrProvider.clearConversation(sessionKey);
}

export function setModel(chatId: number, model: string): void {
  getProvider(chatId).setModel(chatId, model);
}

export function getModel(chatId: number): string {
  return getProvider(chatId).getModel(chatId);
}

export function clearModel(chatId: number): void {
  getProvider(chatId).clearModel(chatId);
}

export function getCachedUsage(sessionKey: string): AgentUsage | undefined {
  const chatId = parseSessionKey(sessionKey).chatId;
  return getProvider(chatId).getCachedUsage(sessionKey);
}

export function isDangerousMode(): boolean {
  // Dangerous mode is a Claude-specific concept; always check Claude provider
  return claudeProvider.isDangerousMode();
}

// Effort is Claude-specific; re-export directly from agent.ts
export { isValidEffortLevel };
export type { EffortLevel };

export function setEffort(chatId: number, effort: EffortLevel): void {
  claudeSetEffort(chatId, effort);
}

export function getEffort(chatId: number): EffortLevel | undefined {
  return claudeGetEffort(chatId);
}

export function clearEffort(chatId: number): void {
  claudeClearEffort(chatId);
}

export async function getAvailableModels(chatId: number): Promise<ModelInfo[]> {
  const providerName = getActiveProviderName(chatId);
  if (providerName === 'ccr') {
    return ccrProvider.getAvailableModels(chatId);
  }
  return claudeProvider.getAvailableModels(chatId);
}
