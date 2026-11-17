import type { Context } from 'grammy';
import { config } from '../config.js';
import { claudeProvider } from './claude-provider.js';
import { ccrProvider } from './ccr-provider.js';
import { isValidEffortLevel, type EffortLevel } from '../claude/effort-level.js';
import { userPreferences } from './user-preferences.js';
import { isPremiumModel } from '../claude/model-catalog.js';
import type { SettingsScope } from '../utils/session-key.js';
import type { Provider, ProviderName, AgentOptions, AgentResponse, AgentUsage, ModelInfo } from './types.js';

// Re-export types for consumers
export type { AgentUsage, AgentResponse, AgentOptions, ModelInfo, ProviderName };

function getProvider(scope: SettingsScope): Provider {
  const name = getActiveProviderName(scope);
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

/**
 * The backend a chat or thread runs on. Read straight from the preferences,
 * which are in memory already: a cache of its own here would go stale for the
 * threads that fall back to a chat-wide value when that value changes.
 */
export function getActiveProviderName(scope: SettingsScope): ProviderName {
  if (!config.CCR_ENABLED) return 'claude';
  return userPreferences.getProvider(scope) ?? 'claude';
}

export async function setActiveProvider(scope: SettingsScope, provider: ProviderName): Promise<void> {
  userPreferences.setProvider(scope, provider);
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
 * text, a transcribed voice note, a photo caption, a reply, /btw — so this is
 * the one place a hold can be applied without having to be remembered at a
 * dozen call sites. A scheduled prompt comes through here as well, each time
 * it fires.
 *
 * Two checks. A `!command` runs in Claude Code's shell mode without a tool
 * call, so the permission gate's hook never sees it and it is put to the gate
 * here (shell-mode-gate.ts). Then the charter judge reads a guest's message.
 * A command an approver has just allowed skips the judge: they read exactly
 * what will run, and a hold would ask them the same thing again.
 *
 * A blocked message returns as an ordinary response rather than an error, so
 * the streaming UI already in flight renders the explanation in place.
 */
async function screened(
  sessionKey: string,
  message: string,
  options: { telegramCtx?: unknown } | undefined,
): Promise<AgentResponse | null> {
  const ctx = options?.telegramCtx as Context | undefined;

  const { screenShellCommand } = await import('../claude/shell-mode-gate.js');
  const shell = await screenShellCommand(ctx, sessionKey, message);
  if (!shell.proceed) return { text: shell.message, toolsUsed: [] };
  if (shell.approved) return null;

  const { screenPrompt } = await import('../claude/prompt-hold.js');
  const outcome = await screenPrompt(ctx, sessionKey, message);
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

  const providerName = getActiveProviderName(sessionKey);
  return getProvider(sessionKey).sendToAgent(sessionKey, message, { ...options, providerName });
}

export function clearConversation(sessionKey: string): void {
  // Clear all providers to avoid stale state
  claudeProvider.clearConversation(sessionKey);
  ccrProvider.clearConversation(sessionKey);
}

export function setModel(scope: SettingsScope, model: string): void {
  getProvider(scope).setModel(scope, model);
}

export function getModel(scope: SettingsScope): string {
  return getProvider(scope).getModel(scope);
}

/**
 * The premium model this session runs on, or undefined when it's on an
 * ordinary one. `best` counts once a turn has shown it resolving to one. CCR
 * is left out: its aliases map onto other backends, so the name says nothing
 * about the cost.
 */
export function getPremiumModel(sessionKey: string): string | undefined {
  if (getActiveProviderName(sessionKey) === 'ccr') return undefined;
  const model = getModel(sessionKey);
  if (isPremiumModel(model)) return model;
  if (model === 'best' && isPremiumModel(getCachedUsage(sessionKey)?.model)) return model;
  return undefined;
}

export function clearModel(scope: SettingsScope): void {
  getProvider(scope).clearModel(scope);
}

export function getCachedUsage(sessionKey: string): AgentUsage | undefined {
  return getProvider(sessionKey).getCachedUsage(sessionKey);
}

// Effort is Claude-specific; re-export directly from agent.ts
export { isValidEffortLevel };
export type { EffortLevel };

export function setEffort(scope: SettingsScope, effort: EffortLevel): void {
  userPreferences.setEffort(scope, effort);
}

export function getEffort(scope: SettingsScope): EffortLevel | undefined {
  return userPreferences.getEffort(scope) as EffortLevel | undefined;
}

export function clearEffort(scope: SettingsScope): void {
  userPreferences.clearEffort(scope);
}

export async function getAvailableModels(scope: SettingsScope): Promise<ModelInfo[]> {
  const providerName = getActiveProviderName(scope);
  if (providerName === 'ccr') {
    return ccrProvider.getAvailableModels(scope);
  }
  return claudeProvider.getAvailableModels(scope);
}
