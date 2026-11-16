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
  type Query,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'crypto';
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
import { permissionModeInfo, transportDefaultMode } from './permission-mode.js';
import { enabledPluginsSetting } from './enabled-plugins.js';
import { forgetTurnContext, noteTurnContext, permissionGateHook } from './sdk-permission-gate.js';
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
import { withPendingCarryOver } from './carry-over.js';
import { recordTurnCost, clearSessionCost } from './session-cost.js';
import { parseSessionKey, type SettingsScope } from '../utils/session-key.js';
import { resolveBundledClaudeBin, resolveActiveClaudeExecutable } from '../utils/resolve-claude-bin.js';
import { formatCompactionConfirmation } from '../utils/format.js';
import {
  PromptChannel,
  QueryFeed,
  holdQuery,
  takeHeldQuery,
  type FeedReader,
  type HeldQuery,
  type QueryShared,
} from './held-query.js';

import type { AgentUsage, AgentResponse, AgentOptions, ImageAttachment, TaskEvent, ToolResultEvent, EditDiffEvent, ThrottleInfo } from '../providers/types.js';
import { taskTracker } from '../telegram/task-tracker.js';
export type { AgentUsage };

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

import { SYSTEM_PROMPT } from './system-prompt.js';
import { stripReasoningSummary } from '../utils/reasoning-summary.js';
import { findModelUsageKey } from './model-catalog.js';
import { ClaudeNotLoggedInError, CLAUDE_NOT_LOGGED_IN_REPLY, isClaudeAuthError } from './claude-auth.js';

const conversationHistory = new BoundedMap<string, ConversationMessage[]>(1000);

// Track Claude Code session IDs per session for conversation continuity
const chatSessionIds = new BoundedMap<string, string>(1000);

// Cache latest usage per session for /context and /status commands
const chatUsageCache = new BoundedMap<string, AgentUsage>(1000);

export function getCachedUsage(sessionKey: string): AgentUsage | undefined {
  return chatUsageCache.get(sessionKey);
}

/**
 * The turn's prompt as a message for the query's input stream (image blocks
 * first when there are any).
 *
 * The stream is a PromptChannel, held open past the reply while a background
 * task the query started is still live. Given a finished input, the CLI exits
 * about five seconds after the model's last turn and stops any background
 * shell still running — a build or a deploy killed halfway, and the model,
 * whose turn is over, never hears about it. With the input still open it
 * stays up, the shell finishes, and its task-notification starts a sub-turn
 * like a Monitor event does.
 *
 * The uuid is how the prompt's own turn is told apart: the CLI reports it
 * queued, started and completed in `command_lifecycle` messages.
 */
function userMessage(
  text: string,
  images: ImageAttachment[],
  sessionId: string | undefined,
  uuid: string,
): SDKUserMessage {
  const content = images.length === 0
    ? text
    : [
      ...images.map((img) => ({
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: img.mediaType, data: img.data },
      })),
      { type: 'text' as const, text },
    ];
  return {
    type: 'user',
    uuid,
    message: { role: 'user', content },
    parent_tool_use_id: null,
    session_id: sessionId || '',
  } as SDKUserMessage;
}

/** The state a `command_lifecycle` message reports for the given prompt. */
function promptLifecycle(message: SDKMessage, uuid: string): string | undefined {
  const m = message as { type: string; command_uuid?: string; state?: string };
  return m.type === 'command_lifecycle' && m.command_uuid === uuid ? m.state : undefined;
}

/**
 * The query held open for this chat, if this turn can join it: same Claude
 * session, same everything a query is started with but the model and the
 * permission mode, which it can be switched to. The prompt is pushed into its
 * input. A held query this turn can't join is let go, and waited out — two
 * CLIs on one session would each write to its transcript.
 */
async function joinHeldQuery(
  sessionKey: string,
  sessionId: string | undefined,
  fingerprint: string,
  model: string,
  permissionMode: PermissionMode,
  message: SDKUserMessage,
): Promise<HeldQuery | undefined> {
  const held = takeHeldQuery(sessionKey);
  if (!held) return undefined;
  if (held.input.isOpen && held.sessionId === sessionId && held.fingerprint === fingerprint) {
    try {
      if (held.model !== model) {
        await held.query.setModel(model);
        held.model = model;
      }
      if (held.permissionMode !== permissionMode) {
        await held.query.setPermissionMode(permissionMode);
        held.permissionMode = permissionMode;
      }
      if (held.input.push(message)) return held;
    } catch (err) {
      console.error('[Claude] Could not join the held query:', err);
    }
  }
  logAt('basic', `[Claude] Letting go of the query held for ${[...held.shared.liveTasks].join(', ') || 'nothing'}, which this turn can't join`);
  held.input.end();
  await Promise.race([held.feed.closed, new Promise((resolve) => setTimeout(resolve, 15_000))]);
  return undefined;
}

/** How long an interrupt gets to stop a cancelled turn before the query is closed. */
const CANCEL_GRACE_MS = 10_000;

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

/**
 * Which mode this turn runs in: the one the chat chose with /mode, else
 * `transportDefaultMode`, which is also what /mode reads to name the default
 * in the chat — one rule, so the menu cannot describe a mode this returns.
 */
function getPermissionMode(scope?: SettingsScope): PermissionMode {
  const chosen = scope !== undefined ? userPreferences.getPermissionMode(scope) : undefined;
  // The SDK and the CLI spell the ask-every-time mode differently; the table
  // holds both, and this transport needs `sdk`.
  const mode = chosen ?? transportDefaultMode('sdk');
  return permissionModeInfo(mode).sdk as PermissionMode;
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
  const { onProgress, onToolStart, onToolEnd, onTaskEvent, onSubTurnResponse, onToolResult, onEditDiff, abortController, model, images, executableOverride, providerName } = options;

  // Native `/compact` used to be intercepted here and refused as PTY-only.
  // It isn't: the CLI runs local slash commands in headless mode too, so a
  // `/compact` on a resumed session emits `status: compacting`, then a
  // `compact_boundary` carrying the token reduction, and writes the boundary
  // into the session JSONL so the next resume picks up the compacted context.
  // We forward it like any other prompt and report the outcome below — the
  // result message's own text is empty for a manual compact, so the
  // confirmation has to be synthesized from the boundary.
  const manualCompact = isNativeCompactCommand(message);
  // Whoever's turn this is answers for the tool calls the permission gate
  // stops from here on, in this query or a held one this turn joins.
  noteTurnContext(sessionKey, options.telegramCtx as Context | undefined);

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

  // Prepend any one-shot carry-over context queued by a provider switch or a
  // cross-backend /resume. Plain text, so it's safe to replay on any backend.
  const prompt = withPendingCarryOver(sessionKey, message);

  // Add user message to history
  history.push({
    role: 'user',
    content: prompt,
  });

  let fullText = '';
  const toolsUsed: string[] = [];
  let gotResult = false;
  let resultUsage: AgentUsage | undefined;
  // The main thread's latest API call: its usage is the context as it now
  // stands, and its model is the one answering. The result's modelUsage can't
  // say either — it adds every call of the query together and lists the CLI's
  // own Haiku side calls alongside, sometimes first.
  let lastMainCall: { model: string; usage: Record<string, unknown> } | undefined;
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
  const permissionMode = getPermissionMode(sessionKey);

  // Determine model to use (default to 'opus' to match getModel() default)
  const effectiveModel = model || getModel(sessionKey);

  // Determine effort level (undefined = SDK default)
  const effectiveEffort = getEffort(sessionKey);

  // Initialize timer for tracking query duration (watchdog created inside try with controller)
  const timer = createAgentTimer();
  let watchdog: AgentWatchdog | null = null;
  let silenceTimedOut = false;
  let staleToolTimedOut = false;

  // The prompt stream stays open while a task this query started is still
  // live, and ends once none is — see userMessage. Tasks are counted from
  // their task_started to their task_notification, foreground ones included:
  // one that is still live when a result arrives is running in the
  // background, however it got there. A turn that joins a held query takes
  // this over from the turn before.
  let shared: QueryShared = { liveTasks: new Set(), waitingOnTasks: false, costSoFar: 0 };
  let releaseInput: () => void = () => {};
  // Set once the reply has gone out while the query stays open: from then on
  // this call only reads the query's sub-turns, until the next turn joins it.
  let detached = false;
  let replied: () => void = () => {};
  const replyReady = new Promise<void>((resolve) => { replied = resolve; });
  // Messages for an already delivered reply have nowhere to go.
  const progress = (text: string) => { if (!detached) onProgress?.(text); };
  const toolStart = (name: string, input: Record<string, unknown>) => { if (!detached) onToolStart?.(name, input); };
  const toolEnd = () => { if (!detached) onToolEnd?.(); };
  // Cache usage for /context and /status commands. A turn's totalCostUsd is
  // its own part of the query's total, and the conversation's total is only
  // ever the sum kept here.
  const recordUsage = (usage: AgentUsage) => {
    const running = recordTurnCost(sessionKey, usage.totalCostUsd);
    usage.sessionCostUsd = running.usd;
    usage.sessionCostTurns = running.turns;
    chatUsageCache.set(sessionKey, usage);
  };
  // Foreground shell commands still running. The CLI ends each one at its
  // own timeout, so a quiet one is not stuck.
  const runningShells = new Set<string>();

  // Runs until the query's stream ends, or until the next turn joins it. The
  // reply is ready earlier when the query is kept open: see replyReady.
  const consume = (async (): Promise<AgentResponse | undefined> => {
    let reader: FeedReader | undefined;
    try {
      let controller = abortController || new AbortController();

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

      // The tools this transport allows. The Task* tools keep Claude Code's
      // task list, which the chat mirrors (telegram/task-list.ts).
      const toolsOption = [
        'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Task', 'Skill',
        'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate',
        'WebFetch', 'WebSearch', 'NotebookEdit',
      ];

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

      // The permission gate, as the PTY transport runs it — see
      // sdk-permission-gate.ts. Always registered, and first: the verbose
      // logging below adds its own PreToolUse matcher after it.
      const gateHook = permissionGateHook(sessionKey);
      const gateHooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {
        PreToolUse: [gateHook],
      };

      // SDK hook logging: only register the noisy hooks (PreToolUse, PostToolUse, etc.)
      // when LOG_AGENT_HOOKS is true. Session lifecycle hooks are always registered.
      const verboseHooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = config.LOG_AGENT_HOOKS
        ? {
          PreToolUse: [gateHook, {
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
        !config.AUTO_TOPIC_HAIKU
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
                      `[Topic: ${topicLabel}] If user shifted focus, call telecoder_set_topic before replying.`,
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
            ...gateHooks,
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
          : { ...preCompactHook, ...gateHooks, ...autoTopicHook };

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
        mcpServers['telecoder-tools'] = server;
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
        allowedTools: toolsOption,
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
        // Text deltas, so the reply can be shown while it is being written.
        includePartialMessages: true,
        hooks,
        ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
        stderr: (data: string) => {
          console.error('[Claude stderr]:', data);
        },
      };

      const promptUuid = randomUUID();
      const promptMessage = userMessage(prompt, images ?? [], existingSessionId, promptUuid);
      // What a turn has to agree on with a held query to join it.
      const fingerprint = JSON.stringify([
        cwd, sdkExecutable ?? null, providerName ?? null, effectiveEffort ?? null, enabledPlugins ?? null,
        queryOptions.settingSources, Object.keys(mcpServers), Object.keys(hooks ?? {}), toolsOption,
      ]);

      let response: Query;
      let input: PromptChannel;
      let feed: QueryFeed;
      const held = await joinHeldQuery(sessionKey, existingSessionId, fingerprint, effectiveModel, permissionMode, promptMessage);
      if (held) {
        ({ query: response, input, feed, shared, controller } = held);
        const heldController = held.controller;
        abortController?.signal.addEventListener('abort', () => heldController.abort(), { once: true });
        // The turn before may still be answering a task's notification; this
        // one's messages start where its prompt does.
        reader = feed.attach((m) => {
          const state = promptLifecycle(m, promptUuid);
          return state !== undefined && state !== 'queued';
        });
        logAt('basic', `[Claude] Joining the query kept open for ${[...shared.liveTasks].join(', ') || 'background work'}`);
      } else {
        input = new PromptChannel(promptMessage);
        const sdkQuery = query({ prompt: input, options: queryOptions });
        response = sdkQuery;
        feed = new QueryFeed(sdkQuery, () => sdkQuery.close());
        reader = feed.attach();
      }
      releaseInput = () => input.end();
      const heldModel = held?.model ?? effectiveModel;

      // The reply goes out now; the query stays open for its background work,
      // for the next turn to join.
      const detach = () => {
        detached = true;
        clearInterval(previewFlushTimer);
        holdQuery(sessionKey, {
          query: response, controller, input, feed, shared,
          sessionId: chatSessionIds.get(sessionKey),
          model: heldModel,
          permissionMode,
          fingerprint,
        });
        replied();
      };

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
            // Waiting on a quiet background shell is no stall: nothing is
            // expected until it ends.
            shouldPauseTimeouts: () => hasPendingQuestionForSession(sessionKey) || shared.waitingOnTasks,
            shouldPauseStaleTool: () => runningShells.size > 0,
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
      // surface (the Task* list tools have a dedicated card; topic/ask_user
      // return noise)
      // are kept in `silentToolUseIds` and skipped at emit-time.
      const toolUseIdToName = new Map<string, string>();
      const toolUseIdToInput = new Map<string, Record<string, unknown>>();
      const silentToolUseIds = new Set<string>();
      const SILENT_TOOL_NAMES = new Set([
        'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet',
        'mcp__telecoder-tools__telecoder_set_topic',
        'mcp__telecoder-tools__telecoder_ask_user',
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
      // The text block being streamed right now, from its deltas. The finished
      // block arrives in the assistant message and replaces it in fullText.
      let partialText = '';
      // Whether the CLI has reported on this prompt's own turn yet. On resume it
      // can answer something queued ahead of the prompt first — the notice for
      // a task the session's previous process left behind — with a result of
      // its own. That result isn't this turn's: ending the input at it, as
      // nothing seemed to be running, ended it before the prompt was even read,
      // and the CLI stopped this turn's background work five seconds after its
      // reply.
      let promptQueued = false;
      let promptStarted = false;
      // Set at a result after which the query is kept open, and acted on once
      // the result is fully handled.
      let holdAfterResult = false;
      // When this turn's message loop first saw the /cancel flag.
      let cancelSeenAt: number | undefined;

      // Process response messages
      for await (const responseMessage of reader.messages) {
        // Record activity for watchdog
        recordMessage(timer);
        watchdog?.recordActivity(responseMessage.type);

        const lifecycle = promptLifecycle(responseMessage, promptUuid);
        if (lifecycle !== undefined) {
          promptQueued = true;
          if (lifecycle !== 'queued') promptStarted = true;
          continue;
        }

        // If /cancel was issued but interrupt() failed to stop the turn,
        // force-abort on a later heartbeat so we don't hang forever. The
        // interrupt gets a grace period first: closing the query at the first
        // message after it — usually the interrupted turn's own result — would
        // also stop the background tasks it is being kept open for.
        if (!controller.signal.aborted && !gotResult && !detached && isCancelled(sessionKey)) {
          cancelSeenAt ??= Date.now();
          if (Date.now() - cancelSeenAt >= CANCEL_GRACE_MS) {
            logAt('basic', `[Claude] Cancel flag detected on heartbeat, force-closing query for session:${sessionKey}`);
            response.close();
            controller.abort();
          }
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
          // The CLI's answer when it has no credentials is a synthetic
          // assistant message, "Not logged in · Please run /login". Stop here
          // rather than stream that into the chat as if it were the reply.
          if (responseMessage.error === 'authentication_failed') {
            throw new ClaudeNotLoggedInError();
          }
          logAt('verbose', '[Claude] Assistant content blocks:', responseMessage.message.content.length);
          if (responseMessage.parent_tool_use_id === null && responseMessage.message.usage) {
            lastMainCall = {
              model: responseMessage.message.model,
              usage: responseMessage.message.usage as unknown as Record<string, unknown>,
            };
          }
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
                partialText = '';
                fullText += block.text;
                progress(fullText);
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
                if ((block.name === 'Bash' || block.name === 'PowerShell') && !isBackgroundedToolCall) {
                  runningShells.add(block.id);
                }
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
                progress(fullText);
                logAt('basic', `[Claude] Captured plan from ${toolInput.file_path}`);
              }
              // Notify tool start for terminal UI — but skip backgrounded
              // tool calls. Their placeholder result returns immediately, so
              // showing them as the active foreground operation is misleading.
              // The streaming UI's footer represents them instead.
              if (!isBackgroundedToolCall) {
                toolStart(block.name, toolInput);
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
            shared.waitingOnTasks = false;
            inSubTurn = detached || (initCount > 1 && hadBackgroundedTask);
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
              progress(fullText);
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
            shared.liveTasks.add(m.task_id);
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
            // A shell moved to the background partway through only says so here.
            if (m.patch.is_backgrounded) hadBackgroundedTask = true;
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
            shared.liveTasks.delete(m.task_id);
            // Nothing left to wait for. The CLI still answers this notification
            // before it exits, the way it did with a string prompt.
            if (shared.waitingOnTasks && shared.liveTasks.size === 0) releaseInput();
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
              runningShells.delete(b.tool_use_id);
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
          toolEnd();
        } else if (responseMessage.type === 'auth_status') {
          logAt('basic', '[Claude] Auth status', responseMessage);
        } else if (responseMessage.type === 'stream_event') {
          logAt('trace', '[Claude] Stream event', responseMessage.event);
          // The main thread's text as it is typed; a sub-agent's and a sub-turn's
          // are not part of the reply.
          const event = responseMessage.event;
          if (!inSubTurn && responseMessage.parent_tool_use_id === null) {
            if (event.type === 'content_block_start') {
              partialText = '';
            } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
              partialText += event.delta.text;
              const separator = pendingTextSeparator && fullText.length > 0 ? '\n\n───\n\n' : '';
              progress(fullText + separator + partialText);
            }
          }
        } else if (responseMessage.type === 'result') {
          if (promptQueued && !promptStarted) {
            shared.costSoFar = (responseMessage as SDKResultMessage).total_cost_usd ?? shared.costSoFar;
            logAt('verbose', `[Claude] Result of a turn queued ahead of this prompt, session:${sessionKey}`);
            continue;
          }
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

          // A /cancel stops the turn, not the background work it started: a
          // second /cancel, with no turn running, stops that.
          if (shared.liveTasks.size === 0 || controller.signal.aborted) {
            releaseInput();
          } else {
            shared.waitingOnTasks = true;
            holdAfterResult = !detached;
            logAt('basic', `[Claude] Keeping the query open for ${shared.liveTasks.size} background task(s): ${[...shared.liveTasks].join(', ')}`);
          }

          // Flush any sub-turn text accumulated during this turn as its own
          // chat message (monitor events, post-completion commentary, etc.).
          // Its result text is that same reply, so it stays out of fullText.
          const subTurnResult = inSubTurn;
          if (inSubTurn) {
            const subTurnText = subTurnBuffer.trim();
            if (subTurnText) {
              await emitSubTurnResponse(subTurnText);
            }
            inSubTurn = false;
            subTurnBuffer = '';
          }

          // Extract usage data from result. The query's total_cost_usd counts
          // every turn it has answered; this turn's spend is what it added.
          const resultMsg = responseMessage as SDKResultMessage;
          const turnCostUsd = Math.max(0, (resultMsg.total_cost_usd ?? 0) - shared.costSoFar);
          shared.costSoFar = resultMsg.total_cost_usd ?? shared.costSoFar;
          if (resultMsg.modelUsage) {
            const modelKey = lastMainCall
              ? findModelUsageKey(resultMsg.modelUsage, lastMainCall.model)
              : Object.keys(resultMsg.modelUsage)[0];
            if (modelKey && resultMsg.modelUsage[modelKey]) {
              const mu = resultMsg.modelUsage[modelKey];
              const call = lastMainCall?.usage;
              const tokens = (key: string, fallback: number): number =>
                call ? (typeof call[key] === 'number' ? call[key] as number : 0) : fallback;
              const usage: AgentUsage = {
                inputTokens: tokens('input_tokens', mu.inputTokens),
                outputTokens: tokens('output_tokens', mu.outputTokens),
                cacheReadTokens: tokens('cache_read_input_tokens', mu.cacheReadInputTokens),
                cacheWriteTokens: tokens('cache_creation_input_tokens', mu.cacheCreationInputTokens),
                totalCostUsd: turnCostUsd,
                // Filled in below, once the turn is known to have completed.
                sessionCostUsd: 0,
                sessionCostTurns: 0,
                contextWindow: mu.contextWindow,
                numTurns: resultMsg.num_turns,
                model: modelKey,
              };
              // A sub-turn after the reply went out is spend of its own.
              if (detached) recordUsage(usage);
              else resultUsage = usage;
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
            if (!subTurnResult && responseMessage.result && !fullText.includes(responseMessage.result)) {
              if (fullText.length > 0) {
                fullText += '\n\n';
              }
              fullText += responseMessage.result;
              progress(fullText);
            }
          } else if (responseMessage.subtype === 'error_during_execution' && isCancelled(sessionKey)) {
            // Interrupted via /cancel - show clean cancellation message
            fullText = '✅ Successfully cancelled - no tools or agents in process.';
            progress(fullText);
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
              : isClaudeAuthError(upstreamText)
                ? `🔑 ${CLAUDE_NOT_LOGGED_IN_REPLY}`
                : `Error: ${responseMessage.subtype}`;
            progress(fullText);
          }
        }

        if (holdAfterResult) {
          holdAfterResult = false;
          detach();
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

      if (error instanceof ClaudeNotLoggedInError) throw error;

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
      // A detached call's turn has ended already, and the query may be the next
      // turn's now.
      if (!detached) {
        releaseInput();
        clearActiveQuery(sessionKey);
      }
    }
    return undefined;
  })();

  const outcome = await Promise.race([consume, replyReady.then(() => 'held' as const)]);
  if (outcome === 'held') {
    consume.catch((err) => console.error('[Claude] Query kept open for background work failed:', err));
  } else if (outcome) {
    return outcome;
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

  if (resultUsage) recordUsage(resultUsage);

  return {
    text: stripReasoningSummary(fullText) || 'No response from Claude.',
    toolsUsed,
    usage: resultUsage,
    compaction: compactionEvent,
    sessionInit: initEvent,
    throttle: throttleInfo,
  };
}

export function clearConversation(sessionKey: string): void {
  conversationHistory.delete(sessionKey);
  chatSessionIds.delete(sessionKey);
  chatUsageCache.delete(sessionKey);
  clearSessionCost(sessionKey);
  forgetTurnContext(sessionKey);
  taskTracker.clear(sessionKey);
}

// Model and effort are read from the preferences on every call: they are held
// in memory already, and a cache here would go stale for the threads that fall
// back to a chat-wide value when that value changes.
export function setModel(scope: SettingsScope, model: string): void {
  userPreferences.setModel(scope, model);
}

export function getModel(scope: SettingsScope): string {
  return userPreferences.getModel(scope) || 'opus';
}

export function clearModel(scope: SettingsScope): void {
  userPreferences.clearModel(scope);
}

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const VALID_EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export function setEffort(scope: SettingsScope, effort: EffortLevel): void {
  userPreferences.setEffort(scope, effort);
}

export function getEffort(scope: SettingsScope): EffortLevel | undefined {
  return userPreferences.getEffort(scope) as EffortLevel | undefined;
}

export function clearEffort(scope: SettingsScope): void {
  userPreferences.clearEffort(scope);
}

export function isValidEffortLevel(level: string): level is EffortLevel {
  return VALID_EFFORT_LEVELS.includes(level as EffortLevel);
}

