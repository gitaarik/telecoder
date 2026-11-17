import type { SettingsScope } from '../utils/session-key.js';

export type ProviderName = 'claude' | 'ccr';

/**
 * What the session log says about the last reply. There is no cost in it:
 * Claude Code writes no pricing into the log, so what a conversation cost is
 * a question for `/cost`, which asks Claude Code itself.
 */
export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  contextWindow: number;
  numTurns: number;
  model: string;
  /**
   * The reasoning effort the request went out with ('low' … 'max'), read from
   * the session log. Unset when the log has not recorded one: a chat before its
   * first reply, or a log written by a CLI older than 2.1.316.
   */
  effort?: string;
}

/**
 * Tokens the context holds: the whole prompt of the last call — uncached,
 * cache-read and cache-written alike — plus the reply it produced.
 */
export function contextTokens(usage: AgentUsage): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens;
}

export interface AgentResponse {
  text: string;
  toolsUsed: string[];
  usage?: AgentUsage;
  compaction?: { trigger: 'manual' | 'auto'; preTokens: number };
  /**
   * Speculative next-prompt suggestion scraped from claude's TUI ghost text
   * at end-of-turn. Only populated when the chat has /suggestions enabled
   * and Claude Code's growthbook flag for the feature is on. Surfaced to the
   * UI layer as an inline button on the response message.
   */
  nextPromptSuggestion?: string;
}

export interface ImageAttachment {
  /** Base64-encoded image data (no data URL prefix) */
  data: string;
  /** MIME type, e.g. "image/jpeg", "image/png" */
  mediaType: string;
  /**
   * Where the caller already wrote this image, when it saved one before
   * sending. Pty mode attaches an image by naming its path in the prompt, so a
   * caller that supplies the path it already named saves the provider from
   * staging a second copy — which claude would attach a second time.
   */
  path?: string;
}

export interface ToolResultEvent {
  toolUseId: string;
  /** Tool name (e.g. "Bash", "Read") if known from the matching tool_use block. */
  toolName?: string;
  /** Raw input from the matching tool_use block (e.g. {command} for Bash). */
  input?: Record<string, unknown>;
  /** Best-effort string extraction of the tool result content. */
  content: string;
  /** True when the tool call failed. */
  isError: boolean;
}

/**
 * Emitted on a successful Edit/Write call so the bot can show the actual
 * before/after content instead of just the file path. Failed edits go
 * through the generic ToolResultEvent path so the error surfaces.
 */
export interface EditDiffEvent {
  toolUseId: string;
  toolName: 'Edit' | 'Write';
  filePath: string;
  /** Present for Edit (the snippet being replaced). Undefined for Write (new content). */
  oldString?: string;
  /** New content. For Edit: the replacement snippet. For Write: full file content. */
  newString: string;
}

export interface AgentOptions {
  onProgress?: (text: string) => void;
  /**
   * Called when Claude Code's live spinner tip changes. The tip text is
   * scraped from the rendered TUI and mirrored under the Telegram status
   * indicator; null clears it when no tip is on screen.
   */
  onTip?: (tip: string | null) => void;
  onToolStart?: (toolName: string, input?: Record<string, unknown>) => void;
  onToolEnd?: () => void;
  /**
   * Called with the result of a tool the agent just used.
   * The bot surfaces a truncated preview when verbosity is verbose or higher.
   */
  onToolResult?: (event: ToolResultEvent) => void | Promise<void>;
  /**
   * Called when an Edit or Write tool call succeeds. Renders a unified
   * before/after preview at verbose+ verbosity.
   */
  onEditDiff?: (event: EditDiffEvent) => void | Promise<void>;
  abortController?: AbortController;
  model?: string;
  /** Telegram context passed through for MCP tools (Claude provider only) */
  telegramCtx?: unknown;
  /** Optional image attachments to send as multimodal vision input */
  images?: ImageAttachment[];
  /**
   * The executable the pty spawns in place of `claude`. The CCR provider
   * points it at a wrapper script that exports ANTHROPIC_BASE_URL /
   * ANTHROPIC_AUTH_TOKEN before exec'ing real claude. A live pty running the
   * other one is respawned.
   */
  executableOverride?: string;
  /**
   * Name of the provider issuing this turn. Set by the provider router so the
   * agent can (a) record which backend owns the resumed Claude session and
   * (b) refuse to resume a session created by a different backend — replaying
   * DeepSeek-via-CCR thinking blocks against the real Anthropic API trips a
   * `400 Invalid signature in thinking block`.
   */
  providerName?: ProviderName;
}

export interface ModelInfo {
  id: string;
  label: string;
  description?: string;
}

export interface Provider {
  readonly name: ProviderName;
  sendToAgent(sessionKey: string, message: string, options?: AgentOptions): Promise<AgentResponse>;
  clearConversation(sessionKey: string): void;
  setModel(scope: SettingsScope, model: string): void;
  getModel(scope: SettingsScope): string;
  clearModel(scope: SettingsScope): void;
  getCachedUsage(sessionKey: string): AgentUsage | undefined;
  getAvailableModels(scope: SettingsScope): Promise<ModelInfo[]>;
}
