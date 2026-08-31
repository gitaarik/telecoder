import {
  query,
  type SDKUserMessage,
  type SDKResultMessage,
  type SDKCompactBoundaryMessage,
  type SDKStatusMessage,
  type SDKSystemMessage,
  type SDKLocalCommandOutputMessage,
  type SDKTaskStartedMessage,
  type SDKTaskProgressMessage,
  type SDKTaskUpdatedMessage,
  type SDKTaskNotificationMessage,
  type PermissionMode,
  type SettingSource,
  type HookEvent,
  type HookCallbackMatcher,
  type McpServerConfig,
} from '@anthropic-ai/claude-agent-sdk';
import * as fs from 'fs';
import { sessionManager } from './session-manager.js';
import { setActiveQuery, clearActiveQuery, isCancelled } from './request-queue.js';
import type { Context } from 'grammy';
import { config } from '../config.js';
import { AgentWatchdog } from './agent-watchdog.js';
import { hasPendingQuestionForSession } from './ask-user.js';
import { createTeleCoderMcpServer } from './mcp-tools.js';
import { isSubagentTool } from './subagent-tools.js';
import { isNativeCompactCommand } from './command-parser.js';
import { recordAvailableCommands } from './available-commands.js';
import { enabledPluginsSetting } from './enabled-plugins.js';
import { getSessionTopic, getMsSinceTopicSet } from '../bot/handlers/command/topic-store.js';
import {
  createAgentTimer,
  recordMessage,
  formatDuration,
  getElapsedMs,
  getTimingReport,
} from '../utils/agent-timer.js';
import { userPreferences } from '../providers/user-preferences.js';
import { hasForeignThinkingSignatures } from './session-jsonl.js';
import { BoundedMap } from '../utils/bounded-map.js';
import { parseSessionKey } from '../utils/session-key.js';
import { resolveBundledClaudeBin, resolveActiveClaudeExecutable } from '../utils/resolve-claude-bin.js';
import { formatCompactionConfirmation } from '../utils/format.js';

import type { AgentUsage, AgentResponse, AgentOptions, LoopOptions, ImageAttachment, TaskEvent, ToolResultEvent, EditDiffEvent, ThrottleInfo } from '../providers/types.js';
import { taskTracker } from '../telegram/task-tracker.js';
export type { AgentUsage };

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

import { SYSTEM_PROMPT } from './system-prompt.js';

const conversationHistory = new BoundedMap<string, ConversationMessage[]>(1000);

// Track Claude Code session IDs per session for conversation continuity
const chatSessionIds = new BoundedMap<string, string>(1000);

// Plain-text context to prepend to the next turn's prompt, set when a provider
// switch starts a fresh session (the old session can't be resumed on a
// different backend). Consumed and cleared on the next send so the new backend
// keeps continuity of context without inheriting foreign-signed thinking blocks.
const pendingCarryOver = new BoundedMap<string, string>(1000);

/** Queue a one-shot context preamble for the next turn of `sessionKey`. */
export function setPendingCarryOver(sessionKey: string, preamble: string): void {
  pendingCarryOver.set(sessionKey, preamble);
}

// Track current model per session (default: opus)
// chatModels is intentionally unbounded — it's backed by persistent preferences
const chatModels = new Map<string, string>();

// Track effort level per user (default: undefined = SDK default)
const chatEffort = new Map<string, string>();

// Cache latest usage per session for /context and /status commands
const chatUsageCache = new BoundedMap<string, AgentUsage>(1000);

export function getCachedUsage(sessionKey: string): AgentUsage | undefined {
  return chatUsageCache.get(sessionKey);
}

/**
 * Build a multimodal prompt with image content blocks for the Claude SDK.
 * The SDK accepts `prompt: string | AsyncIterable<SDKUserMessage>`.
 * When images are attached, we use the AsyncIterable form to send
 * content blocks (image + text) in a single user message.
 */
async function* buildMultimodalPrompt(
  text: string,
  images: ImageAttachment[],
  sessionId?: string,
): AsyncGenerator<SDKUserMessage> {
  const contentBlocks: Array<
    | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
    | { type: 'text'; text: string }
  > = [];

  for (const img of images) {
    contentBlocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: img.mediaType,
        data: img.data,
      },
    });
  }

  contentBlocks.push({ type: 'text', text });

  yield {
    type: 'user',
    message: { role: 'user', content: contentBlocks },
    parent_tool_use_id: null,
    session_id: sessionId || '',
  } as SDKUserMessage;
}

/**
 * Strip the "Reasoning Summary" section from the end of a response
 * so it doesn't appear in Telegram chat (it's already in logs).
 */
function stripReasoningSummary(text: string): string {
  // Match a trailing reasoning summary block:
  //   ---\n**Reasoning Summary**\n... (to end)
  //   or: **Reasoning Summary**\n... (to end)
  //   or: *Reasoning Summary*\n... (to end)
  return text.replace(/\n*(?:---\n+)?(?:\*{1,2})Reasoning Summary(?:\*{1,2})\n[\s\S]*$/, '').trimEnd();
}

type LogLevel = 'off' | 'basic' | 'verbose' | 'trace';
const LOG_LEVELS: Record<LogLevel, number> = {
  off: 0,
  basic: 1,
  verbose: 2,
  trace: 3,
};

function getLogLevel(): LogLevel {
  return config.CLAUDE_SDK_LOG_LEVEL as LogLevel;
}

function logAt(level: LogLevel, message: string, data?: unknown): void {
  if (LOG_LEVELS[level] <= LOG_LEVELS[getLogLevel()]) {
    if (data !== undefined) {
      console.log(message, data);
    } else {
      console.log(message);
    }
  }
}

function getPermissionMode(command?: string): PermissionMode {
  // If DANGEROUS_MODE is enabled, bypass all permissions
  if (config.DANGEROUS_MODE) {
    return 'bypassPermissions';
  }

  // Otherwise, use command-specific modes
  if (command === 'plan') {
    return 'plan';
  }

  return 'acceptEdits';
}

/**
 * Log operations when DANGEROUS_MODE is enabled for security auditing.
 */
function logDangerousModeOperation(sessionKey: string, operation: string, details?: string): void {
  if (!config.DANGEROUS_MODE) return;
  const timestamp = new Date().toISOString();
  const detailStr = details ? ` — ${details}` : '';
  console.log(`[DANGEROUS_MODE] ${timestamp} session:${sessionKey} ${operation}${detailStr}`);
}

/**
 * Detect a Claude Max usage-limit throttle from upstream error text and
 * extract the reset timestamp when present. Returns undefined for any
 * error that isn't a usage-limit signal.
 */
function parseThrottle(errorText: string | undefined): ThrottleInfo | undefined {
  if (!errorText) return undefined;
  // Patterns observed in Claude Code CLI / Anthropic API throttle messages.
  const isUsageLimit =
    /usage limit/i.test(errorText) ||
    /usage_limit_exceeded/i.test(errorText) ||
    /rate.?limit/i.test(errorText);
  if (!isUsageLimit) return undefined;

  let resetAt: number | undefined;
  // ISO-style "resets at 2026-05-12T14:00:00Z"
  const iso = errorText.match(/(?:reset(?:s)?\s+at[:\s]+)([0-9T:\-+.Z ]{10,})/i);
  if (iso) {
    const t = Date.parse(iso[1].trim());
    if (!Number.isNaN(t)) resetAt = t;
  }
  // Unix-seconds "resetAt: 1731412800"
  if (resetAt === undefined) {
    const ts = errorText.match(/reset(?:At)?[":\s]+(\d{10})\b/i);
    if (ts) resetAt = parseInt(ts[1], 10) * 1000;
  }
  return { message: errorText.trim(), resetAt };
}

export async function sendToAgent(
  sessionKey: string,
  message: string,
  options: AgentOptions = {}
): Promise<AgentResponse> {
  const { onProgress, onToolStart, onToolEnd, onTaskEvent, onSubTurnResponse, onToolResult, onEditDiff, abortController, command, model, images, executableOverride, providerName } = options;

  // Native `/compact` used to be intercepted here and refused as PTY-only.
  // It isn't: the CLI runs local slash commands in headless mode too, so a
  // `/compact` on a resumed session emits `status: compacting`, then a
  // `compact_boundary` carrying the token reduction, and writes the boundary
  // into the session JSONL so the next resume picks up the compacted context.
  // We forward it like any other prompt and report the outcome below — the
  // result message's own text is empty for a manual compact, so the
  // confirmation has to be synthesized from the boundary.
  const manualCompact = isNativeCompactCommand(message);

  async function emitTaskEvent(event: TaskEvent): Promise<void> {
    try {
      await onTaskEvent?.(event);
    } catch (err) {
      console.error('[Claude] onTaskEvent handler threw:', err);
    }
  }

  async function emitSubTurnResponse(text: string): Promise<void> {
    try {
      await onSubTurnResponse?.(text);
    } catch (err) {
      console.error('[Claude] onSubTurnResponse handler threw:', err);
    }
  }

  async function emitToolResult(event: ToolResultEvent): Promise<void> {
    try {
      await onToolResult?.(event);
    } catch (err) {
      console.error('[Claude] onToolResult handler threw:', err);
    }
  }

  async function emitEditDiff(event: EditDiffEvent): Promise<void> {
    try {
      await onEditDiff?.(event);
    } catch (err) {
      console.error('[Claude] onEditDiff handler threw:', err);
    }
  }

  /**
   * Extract a readable string from a tool_result.content payload. The SDK
   * may deliver content as a plain string, an array of typed blocks
   * (text/image/etc.), or rarely something else. Non-text blocks become
   * placeholders so the user knows there was a result but it isn't a text
   * preview we can render.
   */
  function extractToolResultText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    const parts: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as { type?: string; text?: string };
      if (b.type === 'text' && typeof b.text === 'string') {
        parts.push(b.text);
      } else if (b.type === 'image') {
        parts.push('[image]');
      } else if (typeof b.type === 'string') {
        parts.push(`[${b.type}]`);
      }
    }
    return parts.join('\n');
  }

  const session = sessionManager.getSession(sessionKey);

  if (!session) {
    throw new Error('No active session. Use /project to set working directory.');
  }

  sessionManager.updateActivity(sessionKey, message);

  // Clear stale assistant preview from previous query so a mid-task restart
  // doesn't show an old response alongside the new prompt
  sessionManager.clearLastAssistantPreview(sessionKey);

  // Get or initialize conversation history
  let history = conversationHistory.get(sessionKey) || [];

  // Determine the prompt based on command
  let prompt = message;
  if (command === 'explore') {
    prompt = `Explore the codebase and answer: ${message}`;
  }

  // Prepend any one-shot carry-over context queued by a provider switch. This
  // is plain text (no thinking blocks), so it's safe to replay on any backend.
  const carryOver = pendingCarryOver.get(sessionKey);
  if (carryOver) {
    pendingCarryOver.delete(sessionKey);
    prompt = `${carryOver}\n\n${prompt}`;
  }

  // Add user message to history
  history.push({
    role: 'user',
    content: prompt,
  });

  let fullText = '';
  const toolsUsed: string[] = [];
  let gotResult = false;
  let resultUsage: AgentUsage | undefined;
  let compactionEvent: { trigger: 'manual' | 'auto'; preTokens: number } | undefined;
  // Post-compaction size, kept alongside compactionEvent rather than on it:
  // the shared AgentResponse.compaction shape only carries preTokens, and the
  // "before → after" confirmation for a manual /compact needs both.
  let compactionPostTokens: number | undefined;
  // Set when a manual /compact finished without producing a boundary, e.g.
  // "Not enough messages to compact." The CLI reports it on the status
  // message; the result message text is empty.
  let compactError: string | undefined;
  let initEvent: { model: string; sessionId: string } | undefined;
  let throttleInfo: ThrottleInfo | undefined;

  // Background timer that periodically flushes lastAssistantPreview to disk.
  // This runs independently of SDK events so that long tool executions (where
  // the for-await loop is blocked) still get a recent snapshot saved.
  let lastFlushedText = '';
  let firstTextFlushed = false;
  function flushPreview() {
    if (fullText && fullText !== lastFlushedText) {
      lastFlushedText = fullText;
      const preview = stripReasoningSummary(fullText);
      if (preview) {
        sessionManager.updateLastAssistantMessage(sessionKey, preview);
      }
    }
  }
  const previewFlushTimer = setInterval(flushPreview, 5_000);

  // Determine permission mode
  const permissionMode = getPermissionMode(command);

  // Log in dangerous mode for security auditing
  logDangerousModeOperation(sessionKey, 'query', `prompt_length:${message.length} cwd:${session.workingDirectory}`);

  // Determine model to use (default to 'opus' to match getModel() default)
  const effectiveModel = model || chatModels.get(sessionKey) || 'opus';

  // Determine effort level (undefined = SDK default)
  const { chatId: parsedChatId } = parseSessionKey(sessionKey);
  const effectiveEffort = getEffort(parsedChatId);

  // Initialize timer for tracking query duration (watchdog created inside try with controller)
  const timer = createAgentTimer();
  let watchdog: AgentWatchdog | null = null;
  let silenceTimedOut = false;
  let staleToolTimedOut = false;

  try {
    const controller = abortController || new AbortController();

    let existingSessionId = chatSessionIds.get(sessionKey) || session.claudeSessionId;

    // Cross-backend resume guard. A Claude session created by one provider
    // can't be safely resumed by another: DeepSeek-via-CCR mints placeholder
    // thinking-block signatures that the real Anthropic API rejects with
    // `400 Invalid signature in thinking block`. Switch paths normally fork
    // the session for us, but this is the last-resort net for paths that
    // didn't (legacy sessions, post-restart in-memory loss). When a mismatch
    // is detected we abandon the old session id and start fresh instead.
    if (existingSessionId && providerName) {
      const owner = session.ownerProvider;
      const ownerMismatch = owner !== undefined && owner !== providerName;
      // No recorded owner (legacy / restarted): fall back to a content scan,
      // but only when resuming on real Anthropic — CCR/DeepSeek ignore sigs.
      const poisonedForAnthropic =
        owner === undefined &&
        providerName === 'claude' &&
        hasForeignThinkingSignatures(session.workingDirectory, existingSessionId);

      if (ownerMismatch || poisonedForAnthropic) {
        logAt(
          'basic',
          `[Claude] Refusing cross-backend resume of ${existingSessionId} ` +
            `(owner=${owner ?? 'unknown'}, now=${providerName}${poisonedForAnthropic ? ', foreign thinking signatures' : ''}); starting fresh session.`,
        );
        chatSessionIds.delete(sessionKey);
        sessionManager.startNewConversation(sessionKey);
        existingSessionId = undefined;
      }
    }

    // Log session resume if applicable
    if (existingSessionId) {
      if (!chatSessionIds.get(sessionKey)) {
        chatSessionIds.set(sessionKey, existingSessionId);
      }
      logAt('basic', `[Claude] Resuming session ${existingSessionId} for session ${sessionKey}`);
    }

    const toolsOption = config.DANGEROUS_MODE
      ? { type: 'preset' as const, preset: 'claude_code' as const }
      : ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Task', 'Skill', 'TodoWrite', 'WebFetch', 'WebSearch', 'NotebookEdit'];

    const allowedToolsOption = config.DANGEROUS_MODE
      ? undefined
      : ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Task', 'Skill', 'TodoWrite', 'WebFetch', 'WebSearch', 'NotebookEdit'];

    // PreCompact hook always registered (logging only — notification sent from compact_boundary message)
    const preCompactHook: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {
      PreCompact: [{
        hooks: [async (input) => {
          logAt('basic', '[Hook] PreCompact — context is about to be compacted', {
            trigger: (input as Record<string, unknown>).trigger,
            customInstructions: (input as Record<string, unknown>).custom_instructions,
          });
          return { continue: true };
        }],
      }],
    };

    // SDK hook logging: only register the noisy hooks (PreToolUse, PostToolUse, etc.)
    // when LOG_AGENT_HOOKS is true. Session lifecycle hooks are always registered.
    const verboseHooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = config.LOG_AGENT_HOOKS
      ? {
        PreToolUse: [{
          hooks: [async (input) => {
            logAt('verbose', '[Hook] PreToolUse', input);
            return { continue: true };
          }],
        }],
        PostToolUse: [{
          hooks: [async (input) => {
            logAt('verbose', '[Hook] PostToolUse', input);
            return { continue: true };
          }],
        }],
        PostToolUseFailure: [{
          hooks: [async (input) => {
            logAt('verbose', '[Hook] PostToolUseFailure', input);
            return { continue: true };
          }],
        }],
        PermissionRequest: [{
          hooks: [async (input) => {
            logAt('verbose', '[Hook] PermissionRequest', input);
            return { continue: true };
          }],
        }],
        Notification: [{
          hooks: [async (input) => {
            logAt('verbose', '[Hook] Notification', input);
            return { continue: true };
          }],
        }],
      }
      : {};

    // Auto-topic reminder: inject a per-turn nudge so the model considers
    // updating the topic on every user message. Skip when the topic was just
    // set (within the cooldown window) to avoid wasted tokens on follow-ups.
    // Also skipped entirely when AUTO_TOPIC_HAIKU is on — the parallel Haiku
    // side-call owns topic updates, making the model-driven nudge redundant.
    const TOPIC_REMINDER_COOLDOWN_MS = 90_000;
    const autoTopicHook: Partial<Record<HookEvent, HookCallbackMatcher[]>> =
      config.DYNAMIC_BOT_NAME && !config.AUTO_TOPIC_HAIKU
        ? {
          UserPromptSubmit: [{
            hooks: [async () => {
              const sinceMs = getMsSinceTopicSet(sessionKey);
              if (sinceMs !== undefined && sinceMs < TOPIC_REMINDER_COOLDOWN_MS) {
                return { continue: true };
              }
              const currentTopic = getSessionTopic(sessionKey);
              const topicLabel = currentTopic ? `"${currentTopic}"` : 'none';
              return {
                continue: true,
                hookSpecificOutput: {
                  hookEventName: 'UserPromptSubmit' as const,
                  additionalContext:
                    `[Topic: ${topicLabel}] If user shifted focus, call claudegram_set_topic before replying.`,
                },
              };
            }],
          }],
        }
        : {};

    const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> | undefined =
      LOG_LEVELS[getLogLevel()] >= LOG_LEVELS.verbose
        ? {
          ...preCompactHook,
          ...verboseHooks,
          ...autoTopicHook,
          SessionStart: [{
            hooks: [async (input) => {
              logAt('basic', '[Hook] SessionStart', input);
              return { continue: true };
            }],
          }],
          SessionEnd: [{
            hooks: [async (input) => {
              logAt('basic', '[Hook] SessionEnd', input);
              return { continue: true };
            }],
          }],
        }
        : { ...preCompactHook, ...autoTopicHook };

    // Validate cwd exists — stale sessions may reference paths from another OS
    let cwd = session.workingDirectory;
    try {
      if (!fs.existsSync(cwd)) {
        const fallback = process.env.HOME || process.cwd();
        console.warn(`[Claude] Working directory does not exist: ${cwd}, falling back to ${fallback}`);
        cwd = fallback;
      }
    } catch {
      cwd = process.env.HOME || process.cwd();
    }

    // Create MCP server for TeleCoder tools (if telegramCtx is available)
    const mcpServers: Record<string, McpServerConfig> = {};
    if (options.telegramCtx) {
      const server = createTeleCoderMcpServer({
        telegramCtx: options.telegramCtx as Context,
        sessionKey,
      });
      mcpServers['claudegram-tools'] = server;
    }

    // Resolved once, because two things need it: the SDK, and the command
    // cache below — whose entries are only valid for the binary that reported
    // them. Undefined means "let the SDK pick", which is its own auto-detect.
    const sdkExecutable = executableOverride
      ?? (config.CLAUDE_USE_BUNDLED_EXECUTABLE
        ? resolveBundledClaudeBin()
        : config.CLAUDE_EXECUTABLE_PATH);

    const enabledPlugins = enabledPluginsSetting();

    const queryOptions: Parameters<typeof query>[0]['options'] = {
      cwd,
      tools: toolsOption,
      ...(allowedToolsOption ? { allowedTools: allowedToolsOption } : {}),
      permissionMode,
      abortController: controller,
      systemPrompt: {
        type: 'preset' as const,
        preset: 'claude_code' as const,
        append: SYSTEM_PROMPT,
      },
      settingSources: (config.CLAUDE_SDK_LOAD_USER_SETTINGS
        ? ['project', 'user']
        : ['project']) as SettingSource[],
      // The pty's --settings equivalent, and here for the same reason: the
      // sources above skip ~/.claude/settings.json, so CLAUDE_PLUGINS is what
      // carries a marketplace plugin into the session. Flag tier, so it merges
      // with the project's own enabledPlugins rather than replacing them.
      ...(enabledPlugins ? { settings: { enabledPlugins } } : {}),
      model: effectiveModel,
      ...(effectiveEffort ? { effort: effectiveEffort } : {}),
      resume: existingSessionId,
      ...(permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
      ...(sdkExecutable ? { pathToClaudeCodeExecutable: sdkExecutable } : {}),
      includePartialMessages: config.CLAUDE_SDK_INCLUDE_PARTIAL || getLogLevel() === 'trace',
      hooks,
      ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
      stderr: (data: string) => {
        console.error('[Claude stderr]:', data);
      },
    };

    const multimodalPrompt = images?.length
      ? buildMultimodalPrompt(prompt, images, existingSessionId)
      : undefined;

    const response = query({
      prompt: multimodalPrompt || prompt,
      options: queryOptions,
    });

    // Store the Query object so /cancel can call interrupt()
    setActiveQuery(sessionKey, response);

    // Initialize watchdog for long-running query monitoring
    watchdog = config.AGENT_WATCHDOG_ENABLED
      ? new AgentWatchdog({
          chatId: sessionKey,
          warnAfterSeconds: config.AGENT_WATCHDOG_WARN_SECONDS,
          logIntervalSeconds: config.AGENT_WATCHDOG_LOG_SECONDS,
          timeoutMs: config.AGENT_QUERY_TIMEOUT_MS > 0 ? config.AGENT_QUERY_TIMEOUT_MS : undefined,
          onWarning: (sinceMsg, total) => {
            logAt('basic', `[Claude] WATCHDOG: No messages for ${formatDuration(sinceMsg)} (total: ${formatDuration(total)}), session:${sessionKey}`);
          },
          onTimeout: () => {
            logAt('basic', `[Claude] WATCHDOG: Query timeout reached, aborting session:${sessionKey}`);
            controller.abort();
          },
          silenceTimeoutMs: config.AGENT_SILENCE_TIMEOUT_MS > 0 ? config.AGENT_SILENCE_TIMEOUT_MS : undefined,
          onSilenceTimeout: () => {
            logAt('basic', `[Claude] WATCHDOG: Silence timeout — no messages for ${formatDuration(config.AGENT_SILENCE_TIMEOUT_MS)}, force-closing query for session:${sessionKey}`);
            silenceTimedOut = true;
            response.close();
            controller.abort();
          },
          staleToolTimeoutMs: config.AGENT_STALE_TOOL_TIMEOUT_MS > 0 ? config.AGENT_STALE_TOOL_TIMEOUT_MS : undefined,
          onStaleToolTimeout: () => {
            logAt('basic', `[Claude] WATCHDOG: Stale tool timeout — only heartbeats for ${formatDuration(config.AGENT_STALE_TOOL_TIMEOUT_MS)}, force-closing query for session:${sessionKey}`);
            staleToolTimedOut = true;
            silenceTimedOut = true; // preserve session for recovery
            response.close();
            controller.abort();
          },
          shouldPauseTimeouts: () => hasPendingQuestionForSession(sessionKey),
        })
      : null;
    watchdog?.start();

    // Track whether we've captured a plan from spontaneous plan mode
    let planCaptured = false;

    // Track tool_use_ids that were launched with run_in_background:true,
    // so the matching task_started event can be marked as backgrounded.
    // (task_updated.is_backgrounded only fires on transitions, not initial state.)
    const backgroundedToolUseIds = new Set<string>();
    // Track tool_use_id → tool name so we can label tool_result blocks that
    // arrive later on user messages. Tools whose results we never want to
    // surface (TodoWrite has a dedicated UI; topic/ask_user return noise)
    // are kept in `silentToolUseIds` and skipped at emit-time.
    const toolUseIdToName = new Map<string, string>();
    const toolUseIdToInput = new Map<string, Record<string, unknown>>();
    const silentToolUseIds = new Set<string>();
    const SILENT_TOOL_NAMES = new Set([
      'TodoWrite',
      'mcp__claudegram-tools__claudegram_set_topic',
      'mcp__claudegram-tools__claudegram_ask_user',
    ]);
    // For successful Edit/Write tool calls we render a before/after diff
    // instead of the generic "File edited successfully" tool_result. Inputs
    // captured at tool_use time are looked up when the matching tool_result
    // arrives. Failed Edit/Write calls still fall through to onToolResult
    // so the error surfaces.
    interface EditDiffInput {
      toolName: 'Edit' | 'Write';
      filePath: string;
      oldString?: string;
      newString: string;
    }
    const editDiffInputs = new Map<string, EditDiffInput>();
    // Monitor tool calls — same wire shape as other backgrounded tasks but
    // we want to render their lifecycle as "📡 Monitor event/armed/ended"
    // instead of the generic "✅ Background task" wording.
    const monitorToolUseIds = new Set<string>();

    // Per-turn state for surfacing SDK-driven sub-turns as their own
    // Telegram messages:
    //   - The first SDK init corresponds to the user's actual message —
    //     this is the main turn that owns the streaming bubble.
    //   - Subsequent inits are SDK-driven sub-turns: monitor event
    //     deliveries, post-task_notification commentary, etc.
    //   - When the query has launched a backgrounded task, every sub-turn's
    //     text response gets posted as its own ctx.reply rather than
    //     edited into the streaming bubble. Otherwise post-stream
    //     commentary would land at the top of the chat (overwriting the
    //     user-facing reply) instead of chronologically at the bottom.
    let initCount = 0;
    let hadBackgroundedTask = false;
    let inSubTurn = false;
    let subTurnBuffer = '';
    // Insert a visual separator between text blocks that had a tool_use
    // between them, so the streaming bubble preserves the model's natural
    // beats. The TUI gets this for free because tool calls render inline;
    // we send tool calls to the action log, so without this the narration
    // collapses into one wall of text.
    let pendingTextSeparator = false;

    // Process response messages
    for await (const responseMessage of response) {
      // Record activity for watchdog
      recordMessage(timer);
      watchdog?.recordActivity(responseMessage.type);

      // If /cancel was issued but interrupt() failed to stop the stream,
      // force-abort on the next heartbeat so we don't hang forever.
      if (!controller.signal.aborted && isCancelled(sessionKey)) {
        logAt('basic', `[Claude] Cancel flag detected on heartbeat, force-closing query for session:${sessionKey}`);
        response.close();
        controller.abort();
      }

      // Check for abort
      if (controller.signal.aborted) {
        watchdog?.stop();
        fullText = isCancelled(sessionKey)
          ? '🛑 Request cancelled.'
          : staleToolTimedOut
            ? `⏱️ A tool appears stuck (no progress for ${formatDuration(config.AGENT_STALE_TOOL_TIMEOUT_MS)}). Your session has been preserved — send another message to continue.`
            : silenceTimedOut
              ? `⏱️ The query stalled (no activity for ${formatDuration(config.AGENT_SILENCE_TIMEOUT_MS)}). Your session has been preserved — send another message to continue.`
              : '⏱️ Request timed out — the query took too long and was automatically stopped. Try a simpler prompt or break it into smaller steps.';
        break;
      }

      logAt('trace', `[Claude] [${formatDuration(getElapsedMs(timer))}] Message: ${responseMessage.type}`);

      if (responseMessage.type === 'assistant') {
        logAt('verbose', '[Claude] Assistant content blocks:', responseMessage.message.content.length);
        for (const block of responseMessage.message.content) {
          logAt('trace', '[Claude] Block type:', block.type);
          if (block.type === 'text') {
            // Sub-turns (monitor events, post-completion commentary):
            // buffer the model's text and post it as its own chat message
            // at result-time instead of editing it into the main streaming
            // bubble (which would visually overwrite the user-facing reply
            // and surface the new text at the top of the chat instead of
            // chronologically at the bottom).
            if (inSubTurn) {
              subTurnBuffer += block.text;
            } else {
              if (pendingTextSeparator && fullText.length > 0) {
                fullText += '\n\n───\n\n';
              }
              pendingTextSeparator = false;
              fullText += block.text;
              onProgress?.(fullText);
              // Flush immediately on first text so early restarts have something
              if (!firstTextFlushed) {
                firstTextFlushed = true;
                flushPreview();
              }
            }
          } else if (block.type === 'tool_use') {
            pendingTextSeparator = true;
            const toolInput = 'input' in block ? block.input as Record<string, unknown> : {};
            const inputSummary = toolInput.command
              ? String(toolInput.command).substring(0, 150)
              : toolInput.pattern
                ? String(toolInput.pattern)
                : toolInput.file_path
                  ? String(toolInput.file_path)
                  : '';
            logAt('verbose', `[Claude] [${formatDuration(getElapsedMs(timer))}] Tool: ${block.name}${inputSummary ? ` → ${inputSummary}` : ''}`);
            toolsUsed.push(block.name);
            // Remember tool_use_ids launched as background tasks so we can
            // stamp the matching task_started event with isBackgrounded:true.
            // Monitor is inherently a streaming subscription (model isn't
            // blocked on it) so treat it as backgrounded too.
            const isMonitorCall = block.name === 'Monitor';
            const isBackgroundedToolCall = toolInput.run_in_background === true || isMonitorCall;
            if ('id' in block && typeof block.id === 'string') {
              toolUseIdToName.set(block.id, block.name);
              toolUseIdToInput.set(block.id, toolInput);
              if (SILENT_TOOL_NAMES.has(block.name) || isBackgroundedToolCall) {
                // Backgrounded tasks return a "running in the background"
                // placeholder; the real outcome surfaces via task_notification.
                silentToolUseIds.add(block.id);
              }
              if ((block.name === 'Edit' || block.name === 'Write')
                  && typeof toolInput.file_path === 'string') {
                const newString = block.name === 'Edit'
                  ? (typeof toolInput.new_string === 'string' ? toolInput.new_string : undefined)
                  : (typeof toolInput.content === 'string' ? toolInput.content : undefined);
                if (typeof newString === 'string') {
                  editDiffInputs.set(block.id, {
                    toolName: block.name,
                    filePath: toolInput.file_path,
                    oldString: block.name === 'Edit' && typeof toolInput.old_string === 'string'
                      ? toolInput.old_string
                      : undefined,
                    newString,
                  });
                }
              }
            }
            if (isBackgroundedToolCall && 'id' in block && typeof block.id === 'string') {
              backgroundedToolUseIds.add(block.id);
              if (isMonitorCall) monitorToolUseIds.add(block.id);
              logAt('verbose', `[Claude] BACKGROUND TASK LAUNCH: tool=${block.name} tool_use_id=${block.id}`);
            }
            // Special logging for the subagent tool (Task/Agent) - always log at basic level
            if (isSubagentTool(block.name)) {
              const taskDesc = toolInput.description || toolInput.prompt || 'unnamed task';
              const subagentType = toolInput.subagent_type || 'unknown';
              logAt('basic', `[Claude] SUBAGENT START: ${subagentType} — ${String(taskDesc).substring(0, 100)}`);
            }
            // Capture plan content from spontaneous plan mode (Write to ~/.claude/plans/)
            if (!planCaptured && block.name === 'Write'
                && typeof toolInput.file_path === 'string'
                && toolInput.file_path.includes('/.claude/plans/')
                && typeof toolInput.content === 'string') {
              planCaptured = true;
              const planSection = '📋 **Plan**\n\n' + toolInput.content + '\n\n---\n\n';
              fullText = planSection + fullText;
              onProgress?.(fullText);
              logAt('basic', `[Claude] Captured plan from ${toolInput.file_path}`);
            }
            // Notify tool start for terminal UI — but skip backgrounded
            // tool calls. Their placeholder result returns immediately, so
            // showing them as the active foreground operation is misleading.
            // The streaming UI's footer represents them instead.
            if (!isBackgroundedToolCall) {
              onToolStart?.(block.name, toolInput);
            }
          }
        }
      } else if (responseMessage.type === 'system') {
        if (responseMessage.subtype === 'compact_boundary') {
          const cbMsg = responseMessage as SDKCompactBoundaryMessage;
          compactionEvent = {
            trigger: cbMsg.compact_metadata.trigger,
            preTokens: cbMsg.compact_metadata.pre_tokens,
          };
          compactionPostTokens = cbMsg.compact_metadata.post_tokens;
          logAt('basic', `[Claude] COMPACTION: trigger=${cbMsg.compact_metadata.trigger}, pre_tokens=${cbMsg.compact_metadata.pre_tokens}, post_tokens=${cbMsg.compact_metadata.post_tokens ?? '?'}`);
        } else if (responseMessage.subtype === 'init') {
          const sysMsg = responseMessage as SDKSystemMessage;
          initEvent = {
            model: sysMsg.model,
            sessionId: sysMsg.session_id,
          };
          // Store session ID early so it's available for recovery if the query hangs
          chatSessionIds.set(sessionKey, sysMsg.session_id);
          sessionManager.setClaudeSessionId(sessionKey, sysMsg.session_id, providerName);
          logAt('basic', `[Claude] SESSION INIT: model=${sysMsg.model}, session=${sysMsg.session_id}`);

          // The init message is the only in-band source for what slash
          // commands and skills this working directory actually has —
          // built-ins, plugin commands and `.claude/commands/` alike. Cache
          // it so /projectcommands can list them without paying for a probe.
          recordAvailableCommands(
            sysMsg.cwd,
            sdkExecutable ?? resolveActiveClaudeExecutable(),
            sysMsg.slash_commands,
            sysMsg.skills,
          );

          // Detect SDK-driven sub-turns. The first init in a query is the
          // user's own turn (owns the streaming bubble). Subsequent inits
          // are sub-turns (monitor events, post-completion commentary).
          // We only redirect sub-turn text to a fresh ctx.reply when this
          // query actually launched a backgrounded task — otherwise normal
          // foreground subagent inits would be wrongly suppressed.
          initCount++;
          inSubTurn = initCount > 1 && hadBackgroundedTask;
          subTurnBuffer = '';
        } else if (responseMessage.subtype === 'status') {
          const statusMsg = responseMessage as SDKStatusMessage;
          if (statusMsg.status === 'compacting') {
            logAt('basic', '[Claude] STATUS: compacting in progress');
          }
          // A finished compaction reports its outcome on a second status
          // message with status: null. On failure the reason lives here and
          // nowhere else — the boundary is never written and the result text
          // is empty, so without this a failed /compact answers with silence.
          if (statusMsg.compact_result === 'failed') {
            compactError = statusMsg.compact_error || 'compaction failed';
            logAt('basic', `[Claude] COMPACTION FAILED: ${compactError}`);
          }
        } else if (responseMessage.subtype === 'local_command_output') {
          // Output from a slash command the CLI ran locally rather than
          // sending to the model. Most locally-handled commands answer with a
          // synthetic assistant message (which the assistant branch above
          // already collects); this subtype is the other shape they can take,
          // and dropping it would answer the user with an empty turn.
          const localMsg = responseMessage as SDKLocalCommandOutputMessage;
          if (localMsg.content) {
            if (pendingTextSeparator && fullText.length > 0) fullText += '\n\n───\n\n';
            pendingTextSeparator = false;
            fullText += localMsg.content;
            onProgress?.(fullText);
            logAt('verbose', `[Claude] LOCAL COMMAND OUTPUT: ${localMsg.content.length} chars`);
          }
        } else if (responseMessage.subtype === 'task_started') {
          const m = responseMessage as SDKTaskStartedMessage;
          const isBackgrounded = m.tool_use_id ? backgroundedToolUseIds.has(m.tool_use_id) : false;
          const isMonitor = m.tool_use_id ? monitorToolUseIds.has(m.tool_use_id) : false;
          // Override task_type with 'monitor_mcp' for Monitor tool calls.
          // The SDK's actual task_type value isn't part of the public type
          // contract, so we tag based on the launching tool name instead.
          const taskType = isMonitor ? 'monitor_mcp' : m.task_type;
          if (isBackgrounded) hadBackgroundedTask = true;
          logAt('verbose', `[Claude] TASK STARTED: ${m.task_id} — ${m.description} backgrounded=${isBackgrounded} taskType=${taskType ?? '?'}`);
          await emitTaskEvent({
            type: 'started',
            taskId: m.task_id,
            description: m.description,
            toolUseId: m.tool_use_id,
            taskType,
            workflowName: m.workflow_name,
            skipTranscript: m.skip_transcript,
            isBackgrounded,
          });
        } else if (responseMessage.subtype === 'task_progress') {
          const m = responseMessage as SDKTaskProgressMessage;
          logAt('trace', `[Claude] TASK PROGRESS: ${m.task_id} — ${m.last_tool_name ?? '?'}`);
          await emitTaskEvent({
            type: 'progress',
            taskId: m.task_id,
            description: m.description,
            lastToolName: m.last_tool_name,
            summary: m.summary,
            usage: m.usage ? {
              totalTokens: m.usage.total_tokens,
              toolUses: m.usage.tool_uses,
              durationMs: m.usage.duration_ms,
            } : undefined,
          });
        } else if (responseMessage.subtype === 'task_updated') {
          const m = responseMessage as SDKTaskUpdatedMessage;
          logAt('verbose', `[Claude] TASK UPDATED: ${m.task_id} — status=${m.patch.status ?? '?'} backgrounded=${m.patch.is_backgrounded ?? '?'}`);
          await emitTaskEvent({
            type: 'updated',
            taskId: m.task_id,
            status: m.patch.status,
            description: m.patch.description,
            isBackgrounded: m.patch.is_backgrounded,
            error: m.patch.error,
            endTime: m.patch.end_time,
          });
        } else if (responseMessage.subtype === 'task_notification') {
          const m = responseMessage as SDKTaskNotificationMessage;
          logAt('basic', `[Claude] TASK NOTIFICATION: ${m.task_id} — ${m.status}`);
          await emitTaskEvent({
            type: 'notification',
            taskId: m.task_id,
            status: m.status,
            outputFile: m.output_file,
            summary: m.summary,
            usage: m.usage ? {
              totalTokens: m.usage.total_tokens,
              toolUses: m.usage.tool_uses,
              durationMs: m.usage.duration_ms,
            } : undefined,
          });
        } else {
          logAt('verbose', `[Claude] System: ${responseMessage.subtype ?? 'unknown'}`, responseMessage);
        }
      } else if (responseMessage.type === 'user') {
        // User messages carry tool_result blocks for tools the agent just ran.
        // Surface them via onToolResult so the bot can show truncated previews
        // when verbosity is verbose or higher. Synthetic/replay messages are
        // ignored to avoid duplicating results during resumed sessions.
        const isSynthetic = (responseMessage as { isSynthetic?: boolean }).isSynthetic === true;
        const msgContent = (responseMessage as { message?: { content?: unknown } }).message?.content;
        if (!isSynthetic && Array.isArray(msgContent)) {
          for (const block of msgContent) {
            if (!block || typeof block !== 'object') continue;
            const b = block as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean };
            if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
            if (silentToolUseIds.has(b.tool_use_id)) continue;
            const isError = b.is_error === true;
            // Successful Edit/Write: render the captured before/after content
            // as a diff instead of the generic "File edited successfully" reply.
            // Errors still fall through to the normal tool_result path so the
            // failure reason surfaces to the user.
            const diffInput = editDiffInputs.get(b.tool_use_id);
            if (diffInput && !isError) {
              await emitEditDiff({
                toolUseId: b.tool_use_id,
                toolName: diffInput.toolName,
                filePath: diffInput.filePath,
                oldString: diffInput.oldString,
                newString: diffInput.newString,
              });
              continue;
            }
            const text = extractToolResultText(b.content);
            await emitToolResult({
              toolUseId: b.tool_use_id,
              toolName: toolUseIdToName.get(b.tool_use_id),
              input: toolUseIdToInput.get(b.tool_use_id),
              content: text,
              isError,
            });
          }
        }
      } else if (responseMessage.type === 'tool_progress') {
        logAt('verbose', `[Claude] Tool progress: ${responseMessage.tool_name}`, responseMessage);
      } else if (responseMessage.type === 'tool_use_summary') {
        logAt('verbose', '[Claude] Tool use summary', responseMessage);
        // Notify tool end for terminal UI (summary doesn't include tool name)
        onToolEnd?.();
      } else if (responseMessage.type === 'auth_status') {
        logAt('basic', '[Claude] Auth status', responseMessage);
      } else if (responseMessage.type === 'stream_event') {
        logAt('trace', '[Claude] Stream event', responseMessage.event);
      } else if (responseMessage.type === 'result') {
        watchdog?.stop();
        // SDK ≥ v0.2.91 exposes terminal_reason on result messages; surface it
        // at basic log level when non-`completed` so post-mortem grep can
        // distinguish e.g. `aborted_streaming` / `aborted_tools` / `max_turns`
        // / `model_error` from a normal completion. See
        // docs/debugging/interrupted-by-user-misattribution.md.
        const terminalReason = (responseMessage as SDKResultMessage & { terminal_reason?: string }).terminal_reason;
        if (terminalReason && terminalReason !== 'completed') {
          logAt('basic', `[Claude] TERMINAL_REASON: ${terminalReason} (session:${sessionKey}, ${getTimingReport(timer)})`);
        } else {
          logAt('basic', `[Claude] Query completed: ${getTimingReport(timer)}`);
        }
        logAt('verbose', '[Claude] Result:', JSON.stringify(responseMessage, null, 2).substring(0, 500));
        gotResult = true;

        // Flush any sub-turn text accumulated during this turn as its own
        // chat message (monitor events, post-completion commentary, etc.).
        if (inSubTurn) {
          const subTurnText = subTurnBuffer.trim();
          if (subTurnText) {
            await emitSubTurnResponse(subTurnText);
          }
          inSubTurn = false;
          subTurnBuffer = '';
        }

        // Extract usage data from result
        const resultMsg = responseMessage as SDKResultMessage;
        if (resultMsg.modelUsage) {
          const modelKey = Object.keys(resultMsg.modelUsage)[0];
          if (modelKey && resultMsg.modelUsage[modelKey]) {
            const mu = resultMsg.modelUsage[modelKey];
            resultUsage = {
              inputTokens: mu.inputTokens,
              outputTokens: mu.outputTokens,
              cacheReadTokens: mu.cacheReadInputTokens,
              cacheWriteTokens: mu.cacheCreationInputTokens,
              totalCostUsd: resultMsg.total_cost_usd,
              contextWindow: mu.contextWindow,
              numTurns: resultMsg.num_turns,
              model: modelKey,
            };
          }
        }

        if (responseMessage.subtype === 'success') {
          // Only store session_id on successful results (not on error_during_execution)
          if ('session_id' in responseMessage && responseMessage.session_id) {
            chatSessionIds.set(sessionKey, responseMessage.session_id);
            sessionManager.setClaudeSessionId(sessionKey, responseMessage.session_id, providerName);
            logAt('basic', `[Claude] Stored session ${responseMessage.session_id} for session ${sessionKey}`);
          }

          // Append final result text if different from accumulated
          if (responseMessage.result && !fullText.includes(responseMessage.result)) {
            if (fullText.length > 0) {
              fullText += '\n\n';
            }
            fullText += responseMessage.result;
            onProgress?.(fullText);
          }
        } else if (responseMessage.subtype === 'error_during_execution' && isCancelled(sessionKey)) {
          // Interrupted via /cancel - show clean cancellation message
          fullText = '✅ Successfully cancelled - no tools or agents in process.';
          onProgress?.(fullText);
        } else if (!silenceTimedOut) {
          // error_max_turns or unexpected error_during_execution
          // Try to extract a Max usage-limit signal from the upstream text so
          // the bot can offer a CCR fallback prompt. The SDK surfaces the raw
          // error in `result` even on error subtypes.
          const upstreamText =
            'result' in responseMessage && typeof responseMessage.result === 'string'
              ? responseMessage.result
              : undefined;
          throttleInfo = parseThrottle(upstreamText);

          // Preserve the session on a throttle (so a retry via the same chat
          // resumes properly), otherwise clear it — stale session_ids cause
          // hard failures on subsequent attempts.
          if (!throttleInfo) {
            chatSessionIds.delete(sessionKey);
            const session = sessionManager.getSession(sessionKey);
            if (session) {
              session.claudeSessionId = undefined;
            }
            logAt('basic', `[Claude] Cleared stale session for session ${sessionKey} due to ${responseMessage.subtype}`);
          } else {
            logAt('basic', `[Claude] Throttle detected for session ${sessionKey}: ${throttleInfo.message.substring(0, 120)}`);
          }

          fullText = throttleInfo
            ? `⚠️ ${throttleInfo.message}`
            : `Error: ${responseMessage.subtype}`;
          onProgress?.(fullText);
        }
      }
    }
  } catch (error) {
    watchdog?.stop();
    // If cancelled via /cancel or /reset, return clean message
    if (isCancelled(sessionKey)) {
      return {
        text: '✅ Successfully cancelled - no tools or agents in process.',
        toolsUsed,
      };
    }
    // Stale tool timeout — preserve session for recovery
    if (staleToolTimedOut) {
      return {
        text: `⏱️ A tool appears stuck (no progress for ${formatDuration(config.AGENT_STALE_TOOL_TIMEOUT_MS)}). Your session has been preserved — send another message to continue.`,
        toolsUsed,
      };
    }
    // Silence timeout — preserve session for recovery
    if (silenceTimedOut) {
      return {
        text: `⏱️ The query stalled (no activity for ${formatDuration(config.AGENT_SILENCE_TIMEOUT_MS)}). Your session has been preserved — send another message to continue.`,
        toolsUsed,
      };
    }
    // Watchdog timeout (not user-initiated)
    if (abortController?.signal.aborted) {
      return {
        text: '⏱️ Request timed out — the query took too long and was automatically stopped. Try a simpler prompt or break it into smaller steps.',
        toolsUsed,
      };
    }

    // If we got a result, ignore process exit errors (SDK quirk)
    if (gotResult && error instanceof Error && error.message.includes('exited with code')) {
      console.log('[Claude] Ignoring exit code error after successful result');
    } else {
      console.error('[Claude] Full error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Claude error: ${errorMessage}`);
    }
  } finally {
    clearInterval(previewFlushTimer);
    watchdog?.stop();
    clearActiveQuery(sessionKey);
  }

  // Report a manual /compact. The CLI answers it with an empty result and,
  // on success, a compact_boundary carrying the numbers — so the confirmation
  // is synthesized here rather than relayed. Mirrors what the PTY provider
  // reports for the same command, down to the wording.
  if (manualCompact && !abortController?.signal.aborted) {
    if (compactionEvent) {
      fullText = formatCompactionConfirmation({
        preTokens: compactionEvent.preTokens,
        postTokens: compactionPostTokens,
      });
      // The confirmation already carries the token detail; drop the separate
      // generic notification so the user gets one clean message.
      compactionEvent = undefined;
    } else if (compactError) {
      // The CLI's reason is already a complete user-facing sentence
      // ("Not enough messages to compact."), so relay it rather than wrapping
      // it in a prefix that repeats it.
      fullText = `ℹ️ ${compactError.endsWith('.') ? compactError : compactError + '.'}`;
    }
  }

  // Add assistant response to history
  if (fullText && !abortController?.signal.aborted) {
    history.push({
      role: 'assistant',
      content: fullText,
    });
  }

  conversationHistory.set(sessionKey, history);

  // Update session history with Claude's response for restore preview
  if (fullText && !isCancelled(sessionKey)) {
    const preview = stripReasoningSummary(fullText);
    if (preview) {
      sessionManager.updateLastAssistantMessage(sessionKey, preview);
    }
  }

  // Cache usage for /context and /status commands
  if (resultUsage) {
    chatUsageCache.set(sessionKey, resultUsage);
  }

  return {
    text: stripReasoningSummary(fullText) || 'No response from Claude.',
    toolsUsed,
    usage: resultUsage,
    compaction: compactionEvent,
    sessionInit: initEvent,
    throttle: throttleInfo,
  };
}

export async function sendLoopToAgent(
  sessionKey: string,
  message: string,
  options: LoopOptions = {}
): Promise<AgentResponse> {
  const {
    onProgress,
    abortController,
    maxIterations = config.MAX_LOOP_ITERATIONS,
    onIterationComplete,
  } = options;

  const session = sessionManager.getSession(sessionKey);

  if (!session) {
    throw new Error('No active session. Use /project to set working directory.');
  }

  // Wrap the prompt with loop instructions
  const loopPrompt = `${message}

IMPORTANT: When you have fully completed this task, respond with the word "DONE" on its own line at the end of your response. If you need to continue working, do not say "DONE".`;

  let iteration = 0;
  let combinedText = '';
  const allToolsUsed: string[] = [];
  let isComplete = false;
  let throttleInfo: ThrottleInfo | undefined;

  while (iteration < maxIterations && !isComplete) {
    iteration++;

    // Check for abort
    if (abortController?.signal.aborted) {
      return {
        text: '🛑 Loop cancelled.',
        toolsUsed: allToolsUsed,
      };
    }

    const iterationPrefix = `\n\n--- Iteration ${iteration}/${maxIterations} ---\n\n`;
    combinedText += iterationPrefix;
    onProgress?.(combinedText);

    // For subsequent iterations, prompt Claude to continue
    const currentPrompt = iteration === 1 ? loopPrompt : 'Continue the task. Say "DONE" when complete.';

    try {
      const response = await sendToAgent(sessionKey, currentPrompt, {
        onProgress: (text) => {
          onProgress?.(combinedText + text);
        },
        onToolResult: options.onToolResult,
        onEditDiff: options.onEditDiff,
        abortController,
        model: options.model,
        telegramCtx: options.telegramCtx,
        executableOverride: options.executableOverride,
        providerName: options.providerName,
      });

      combinedText += response.text;
      allToolsUsed.push(...response.toolsUsed);

      onIterationComplete?.(iteration, response.text);

      // Surface throttle from any iteration so the caller can prompt the
      // user. Abort the loop — continuing would just hit the same wall.
      if (response.throttle) {
        throttleInfo = response.throttle;
        break;
      }

      // Check if Claude said DONE
      if (response.text.includes('DONE')) {
        isComplete = true;
        combinedText += '\n\n✅ Loop completed.';
      } else if (iteration >= maxIterations) {
        combinedText += `\n\n⚠️ Max iterations (${maxIterations}) reached.`;
      }

      onProgress?.(combinedText);
    } catch (error) {
      if (abortController?.signal.aborted) {
        return {
          text: combinedText + '\n\n🛑 Loop cancelled.',
          toolsUsed: allToolsUsed,
        };
      }
      throw error;
    }
  }

  return {
    text: stripReasoningSummary(combinedText),
    toolsUsed: allToolsUsed,
    throttle: throttleInfo,
  };
}

export function clearConversation(sessionKey: string): void {
  conversationHistory.delete(sessionKey);
  chatSessionIds.delete(sessionKey);
  chatUsageCache.delete(sessionKey);
  taskTracker.clear(sessionKey);
}

export function setModel(chatId: number, model: string): void {
  chatModels.set(String(chatId), model);
  userPreferences.setModel(chatId, model);
}

export function getModel(chatId: number): string {
  // Check in-memory cache first, then persistence
  let model = chatModels.get(String(chatId));
  if (!model) {
    model = userPreferences.getModel(chatId);
    if (model) {
      chatModels.set(String(chatId), model);
    }
  }
  return model || 'opus';
}

export function clearModel(chatId: number): void {
  chatModels.delete(String(chatId));
  userPreferences.clearModel(chatId);
}

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const VALID_EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export function setEffort(chatId: number, effort: EffortLevel): void {
  chatEffort.set(String(chatId), effort);
  userPreferences.setEffort(chatId, effort);
}

export function getEffort(chatId: number): EffortLevel | undefined {
  let effort = chatEffort.get(String(chatId));
  if (!effort) {
    effort = userPreferences.getEffort(chatId);
    if (effort) {
      chatEffort.set(String(chatId), effort);
    }
  }
  return effort as EffortLevel | undefined;
}

export function clearEffort(chatId: number): void {
  chatEffort.delete(String(chatId));
  userPreferences.clearEffort(chatId);
}

export function isValidEffortLevel(level: string): level is EffortLevel {
  return VALID_EFFORT_LEVELS.includes(level as EffortLevel);
}

export function isDangerousMode(): boolean {
  return config.DANGEROUS_MODE;
}
