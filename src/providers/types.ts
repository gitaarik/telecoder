export type ProviderName = 'claude' | 'ccr' | 'opencode';
export type ClaudeMethod = 'sdk' | 'pty';

export interface ThrottleInfo {
  /** Original error text from the upstream as surfaced by the SDK. */
  message: string;
  /** Reset time parsed from the error (epoch ms), if discoverable. */
  resetAt?: number;
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCostUsd: number;
  contextWindow: number;
  numTurns: number;
  model: string;
}

export interface AgentResponse {
  text: string;
  toolsUsed: string[];
  usage?: AgentUsage;
  compaction?: { trigger: 'manual' | 'auto'; preTokens: number };
  sessionInit?: { model: string; sessionId: string };
  /** Present when the upstream signalled a Max usage-limit throttle. */
  throttle?: ThrottleInfo;
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
}

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'killed' | 'stopped';

export interface TaskUsage {
  totalTokens: number;
  toolUses: number;
  durationMs: number;
}

export interface TaskStartedEvent {
  type: 'started';
  taskId: string;
  description: string;
  toolUseId?: string;
  taskType?: string;
  workflowName?: string;
  skipTranscript?: boolean;
  /**
   * True when the launching tool input had `run_in_background: true`.
   * Tasks born backgrounded never emit a task_updated patch for this field,
   * so we have to derive it at task_started time.
   */
  isBackgrounded?: boolean;
}

export interface TaskProgressEvent {
  type: 'progress';
  taskId: string;
  description: string;
  lastToolName?: string;
  summary?: string;
  usage?: TaskUsage;
}

export interface TaskUpdatedEvent {
  type: 'updated';
  taskId: string;
  status?: TaskStatus;
  description?: string;
  isBackgrounded?: boolean;
  error?: string;
  endTime?: number;
}

export interface TaskNotificationEvent {
  type: 'notification';
  taskId: string;
  status: 'completed' | 'failed' | 'stopped';
  outputFile: string;
  summary: string;
  usage?: TaskUsage;
}

export type TaskEvent = TaskStartedEvent | TaskProgressEvent | TaskUpdatedEvent | TaskNotificationEvent;

export interface ToolResultEvent {
  toolUseId: string;
  /** Tool name (e.g. "Bash", "Read") if known from the matching tool_use block. */
  toolName?: string;
  /** Raw input from the matching tool_use block (e.g. {command} for Bash). */
  input?: Record<string, unknown>;
  /** Best-effort string extraction of the tool result content. */
  content: string;
  /** True when the SDK marked the result as an error. */
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
  onToolStart?: (toolName: string, input?: Record<string, unknown>) => void;
  onToolEnd?: () => void;
  /** Lifecycle events for SDK background tasks (task_started/progress/updated/notification) */
  onTaskEvent?: (event: TaskEvent) => void | Promise<void>;
  /**
   * Called when the model produces text in an SDK-driven sub-turn while
   * a backgrounded task was launched in this query (e.g. Monitor event
   * echoes, post-task_notification commentary). The bot surfaces this as
   * a separate Telegram message instead of editing it into the main
   * streaming bubble — otherwise post-stream commentary would land at
   * the top of the chat (overwriting the user-facing reply) instead of
   * chronologically at the bottom.
   */
  onSubTurnResponse?: (text: string) => void | Promise<void>;
  /**
   * Called when the SDK reports a tool_result for a tool the agent just used.
   * The bot surfaces a truncated preview when verbosity is verbose or higher.
   */
  onToolResult?: (event: ToolResultEvent) => void | Promise<void>;
  /**
   * Called when an Edit or Write tool call succeeds. Renders a unified
   * before/after preview at verbose+ verbosity.
   */
  onEditDiff?: (event: EditDiffEvent) => void | Promise<void>;
  abortController?: AbortController;
  command?: string;
  model?: string;
  /** Telegram context passed through for MCP tools (Claude provider only) */
  telegramCtx?: unknown;
  /** Optional image attachments to send as multimodal vision input */
  images?: ImageAttachment[];
  /**
   * Override the path to the `claude` executable spawned by the SDK.
   * Used by the CCR provider to point at a wrapper script that exports
   * ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN before exec'ing real claude.
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

export interface LoopOptions extends AgentOptions {
  maxIterations?: number;
  onIterationComplete?: (iteration: number, response: string) => void;
}

export interface ModelInfo {
  id: string;
  label: string;
  description?: string;
}

export interface Provider {
  readonly name: ProviderName;
  sendToAgent(sessionKey: string, message: string, options?: AgentOptions): Promise<AgentResponse>;
  sendLoopToAgent(sessionKey: string, message: string, options?: LoopOptions): Promise<AgentResponse>;
  clearConversation(sessionKey: string): void;
  setModel(chatId: number, model: string): void;
  getModel(chatId: number): string;
  clearModel(chatId: number): void;
  getCachedUsage(sessionKey: string): AgentUsage | undefined;
  isDangerousMode(): boolean;
  getAvailableModels(chatId: number): Promise<ModelInfo[]>;
}
