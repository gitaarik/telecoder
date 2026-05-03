import {
  query,
  type SDKMessage,
  type SDKUserMessage,
  type SDKResultMessage,
  type SDKCompactBoundaryMessage,
  type SDKStatusMessage,
  type SDKSystemMessage,
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
import { createClaudegramMcpServer } from './mcp-tools.js';
import { getSessionTopic, getMsSinceTopicSet } from '../bot/handlers/command.handler.js';
import {
  createAgentTimer,
  recordMessage,
  formatDuration,
  getElapsedMs,
  getTimingReport,
  type AgentTimer,
} from '../utils/agent-timer.js';
import { userPreferences } from '../providers/user-preferences.js';
import { BoundedMap } from '../utils/bounded-map.js';
import { parseSessionKey } from '../utils/session-key.js';
import { resolveBundledClaudeBin } from '../utils/resolve-claude-bin.js';

import type { AgentUsage, AgentResponse, AgentOptions, LoopOptions, ImageAttachment, TaskEvent } from '../providers/types.js';
import { taskTracker } from '../telegram/task-tracker.js';
export type { AgentUsage };

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

const conversationHistory = new BoundedMap<string, ConversationMessage[]>(1000);

// Track Claude Code session IDs per session for conversation continuity
const chatSessionIds = new BoundedMap<string, string>(1000);

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

const CORE_GUIDELINES = `You are ${config.BOT_NAME}, an AI assistant helping via Telegram.

Guidelines:
- Show relevant code snippets when helpful, but keep them short
- If a task requires multiple steps, execute them and summarize what you did
- When you can't do something, explain why briefly`;

const TELEGRAPH_FORMATTING = `

Response Formatting — Telegraph-Aware Writing:
Your responses are displayed via Telegram. Short responses render inline as MarkdownV2.
Longer responses (2500+ chars) are published as Telegraph (telegra.ph) Instant View pages.
You MUST write with Telegraph's rendering constraints in mind at all times.

Telegraph supports ONLY these elements:
- Headings: h3 (from # and ##) and h4 (from ### and ####). No h1, h2, h5, h6.
- Text formatting: **bold**, *italic*, ~~strikethrough~~, \`inline code\`
- Links: [text](url)
- Lists: unordered (- item) and ordered (1. item). Nested lists are supported (indent sub-items).
- Code blocks: \`\`\`code\`\`\` — rendered as monospace preformatted text. No syntax highlighting.
- Blockquotes: > text
- Horizontal rules: ---

Telegraph does NOT support:
- TABLES — pipe-delimited markdown tables (|col|col|) will NOT render as tables. They break into ugly labeled text. NEVER use markdown tables.
- No checkboxes, footnotes, or task lists
- No custom colors, fonts, or inline styles
- Only two heading levels (h3, h4)

Instead of tables, use these alternatives (in order of preference):
1. Bullet lists with bold labels — best for key-value data or comparisons:
   - **Name**: Alice
   - **Age**: 30
   - **City**: NYC

2. Nested lists — best for grouped/categorized data:
   - **Frontend**
     - React 18
     - TypeScript
   - **Backend**
     - Node.js
     - Express

3. Bold headers with list items — best for feature/comparison matrices:
   **Telegram bot** — Grammy v1.31
   **AI agent** — Claude Code SDK v1.0
   **TTS** — OpenAI gpt-4o-mini-tts

4. Preformatted code blocks — ONLY for data where alignment matters (ASCII tables):
   \`\`\`
   Name      Age   City
   Alice     30    NYC
   Bob       25    London
   \`\`\`
   Note: code blocks lose all formatting (no bold, links, etc.) so only use when alignment is critical.

Structure guidelines for long responses:
- Use ## or ### headings to create clear sections (renders as h3/h4)
- Use --- horizontal rules to separate major sections
- Use bullet lists liberally — they render cleanly
- Use > blockquotes for callouts, warnings, or important notes
- Keep paragraphs concise; Telegraph renders best with short blocks of text
- Nest sub-items under list items for tree-like structures instead of indented text`;

const INLINE_FORMATTING = `

Response Formatting:
Your responses are displayed via Telegram using MarkdownV2 formatting.
Long responses are automatically chunked into multiple messages.

Supported formatting:
- **bold**, *italic*, ~~strikethrough~~, \`inline code\`
- Links: [text](url)
- Lists: unordered (- item) and ordered (1. item)
- Code blocks: \`\`\`code\`\`\`
- Blockquotes: > text

Instead of tables (which don't render well in Telegram), use bullet lists with bold labels:
- **Name**: Alice
- **Age**: 30
- **City**: NYC`;

const BASE_SYSTEM_PROMPT = CORE_GUIDELINES + (config.TELEGRAPH_ENABLED ? TELEGRAPH_FORMATTING : INLINE_FORMATTING);

const REDDIT_TOOL_PROMPT = `

Reddit Tool:
You have a claudegram_fetch_reddit MCP tool that fetches Reddit content directly (subreddits, posts with comments, user profiles).
Use it when the user asks about Reddit content — no need to tell them to use a command.
The tool accepts a target (r/<subreddit>, u/<username>, post URL, post ID) and optional sort/time/limit/depth parameters.

Semantic mappings for natural language Reddit queries:
- "today" / "today's top" → sort: top, time_filter: day
- "newest" / "latest" / "recent" → sort: new
- "hottest" / "trending" / "what's hot" → sort: hot
- "top" / "best" → sort: top
- "this week" → sort: top, time_filter: week
- "this month" → sort: top, time_filter: month
- "rising" → sort: rising

The user also has a /reddit Telegram command for direct use.`;

const REDDIT_VIDEO_TOOL_PROMPT = `

Reddit Video Tool:
The user can download Reddit-hosted videos via the /vreddit Telegram command.
If the user wants a video file, tell them to use /vreddit with the post URL.
The claudegram_fetch_reddit tool is for text/comments only, not media downloads.`;

const MEDIUM_TOOL_PROMPT = `

Medium Tool:
You have a claudegram_fetch_medium MCP tool that fetches Medium articles (bypasses paywall via Freedium).
Use it when the user shares a Medium URL or asks to read an article — no need to tell them to use a command.
The user also has a /medium Telegram command for direct use.`;

const EXTRACT_TOOL_PROMPT = `

Media Extract Tool:
You have a claudegram_extract_media MCP tool that extracts content from YouTube, Instagram, and TikTok URLs.
Use mode "text" to transcribe videos, "audio" for MP3, "video" for MP4, "all" for everything.
Audio/video files are sent directly to the user via Telegram as a side effect.
Use it when the user asks to transcribe, download, or extract media from a URL — no need to tell them to use a command.
For voice notes sent directly in chat, the user should use /transcribe instead.
The user also has an /extract Telegram command for direct use.`;

const SEND_FILE_TOOL_PROMPT = `

Send File Tool:
You have a claudegram_send_file MCP tool that sends files to the user via Telegram.
Use it after creating or generating files (SVGs, images, PDFs, reports, code bundles, etc.) to deliver them directly.
The file must be within the current working directory or /tmp. Maximum size: 50MB.
When you generate a file and the user would benefit from receiving it, proactively send it — no need to ask.`;

const SET_TOPIC_TOOL_PROMPT = `

Auto-Topic Tool (IMPORTANT — call this often):
You MUST use the claudegram_set_topic MCP tool to keep the bot's display name in sync with what the user is working on. The bot name renders as "topic — project — Name" with a 64-char limit.

Call claudegram_set_topic in these situations:
1. ON YOUR VERY FIRST RESPONSE of any conversation — read the user's first message and call the tool with a 1-4 word topic BEFORE writing your reply text.
2. WHENEVER THE USER'S FOCUS SHIFTS to a meaningfully different task (different file/feature/bug/question category). Call the tool, THEN respond.
3. Pass an empty string ("") to clear when the conversation becomes general or idle.

When NOT to call: minor follow-up on the same topic; clarifying questions about ongoing work; the next message in a continuous task.

Format: 1-4 lowercase words. Examples: "auth bug", "CI fix", "dark mode", "API docs", "watchdog tuning", "PR planning", "reading code".

When uncertain whether the topic shifted, LEAN TOWARD CALLING. A slightly-too-frequent topic update is fine; a stale topic is bad UX. The user is relying on the bot name to know what you're working on.`;

const MONITOR_RESPONSE_INSTRUCTIONS = `

Monitor Event Responses:
When you receive a <task-notification> that contains an <event> tag (i.e. a Monitor tool's event), respond with EXACTLY one line:

📡 <event-content>

Where <event-content> is the verbatim text from the <event> tag — no quotes, no commentary, no surrounding text. This is the only content of your response for that turn. The bot surfaces this single line as a separate Telegram message so the user can see each monitor event.

This rule applies ONLY to monitor event notifications. Task completion notifications (the ones with <status>) are handled by the bot — for those, respond as you normally would (briefly acknowledge or stay silent).`;

const REASONING_SUMMARY_INSTRUCTIONS = `

Reasoning Summary (required when enabled):
- At the end of each response, add a short section titled "Reasoning Summary".
- Provide 2–5 bullet points describing high-level actions/decisions taken.
- Do NOT reveal chain-of-thought, hidden reasoning, or sensitive tool outputs.
- Skip the summary for very short acknowledgements or pure error messages.`;

const TOOL_PROMPTS = [
  SEND_FILE_TOOL_PROMPT,
  config.DYNAMIC_BOT_NAME ? SET_TOPIC_TOOL_PROMPT : '',
  config.REDDIT_ENABLED ? REDDIT_TOOL_PROMPT : '',
  config.VREDDIT_ENABLED ? REDDIT_VIDEO_TOOL_PROMPT : '',
  config.MEDIUM_ENABLED ? MEDIUM_TOOL_PROMPT : '',
  config.EXTRACT_ENABLED ? EXTRACT_TOOL_PROMPT : '',
].join('');

const SYSTEM_PROMPT = `${BASE_SYSTEM_PROMPT}${TOOL_PROMPTS}${MONITOR_RESPONSE_INSTRUCTIONS}${config.CLAUDE_REASONING_SUMMARY ? REASONING_SUMMARY_INSTRUCTIONS : ''}`;

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

export async function sendToAgent(
  sessionKey: string,
  message: string,
  options: AgentOptions = {}
): Promise<AgentResponse> {
  const { onProgress, onToolStart, onToolEnd, onTaskEvent, onSubTurnResponse, abortController, command, model, images } = options;

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
  let initEvent: { model: string; sessionId: string } | undefined;

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

    const existingSessionId = chatSessionIds.get(sessionKey) || session.claudeSessionId;

    // Log session resume if applicable
    if (existingSessionId) {
      if (!chatSessionIds.get(sessionKey)) {
        chatSessionIds.set(sessionKey, existingSessionId);
      }
      logAt('basic', `[Claude] Resuming session ${existingSessionId} for session ${sessionKey}`);
    }

    const toolsOption = config.DANGEROUS_MODE
      ? { type: 'preset' as const, preset: 'claude_code' as const }
      : ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Task'];

    const allowedToolsOption = config.DANGEROUS_MODE
      ? undefined
      : ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Task'];

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
    const TOPIC_REMINDER_COOLDOWN_MS = 90_000;
    const autoTopicHook: Partial<Record<HookEvent, HookCallbackMatcher[]>> =
      config.DYNAMIC_BOT_NAME
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

    // Create MCP server for Claudegram tools (if telegramCtx is available)
    const mcpServers: Record<string, McpServerConfig> = {};
    if (options.telegramCtx) {
      const server = createClaudegramMcpServer({
        telegramCtx: options.telegramCtx as Context,
        sessionKey,
      });
      mcpServers['claudegram-tools'] = server;
    }

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
      model: effectiveModel,
      ...(effectiveEffort ? { effort: effectiveEffort } : {}),
      resume: existingSessionId,
      ...(permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
      ...(() => {
        if (!config.CLAUDE_USE_BUNDLED_EXECUTABLE) {
          return { pathToClaudeCodeExecutable: config.CLAUDE_EXECUTABLE_PATH };
        }
        const bundled = resolveBundledClaudeBin();
        return bundled ? { pathToClaudeCodeExecutable: bundled } : {};
      })(),
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
        })
      : null;
    watchdog?.start();

    // Track whether we've captured a plan from spontaneous plan mode
    let planCaptured = false;

    // Track tool_use_ids that were launched with run_in_background:true,
    // so the matching task_started event can be marked as backgrounded.
    // (task_updated.is_backgrounded only fires on transitions, not initial state.)
    const backgroundedToolUseIds = new Set<string>();
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
              fullText += block.text;
              onProgress?.(fullText);
              // Flush immediately on first text so early restarts have something
              if (!firstTextFlushed) {
                firstTextFlushed = true;
                flushPreview();
              }
            }
          } else if (block.type === 'tool_use') {
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
            if (isBackgroundedToolCall && 'id' in block && typeof block.id === 'string') {
              backgroundedToolUseIds.add(block.id);
              if (isMonitorCall) monitorToolUseIds.add(block.id);
              logAt('verbose', `[Claude] BACKGROUND TASK LAUNCH: tool=${block.name} tool_use_id=${block.id}`);
            }
            // Special logging for Task tool (subagents) - always log at basic level
            if (block.name === 'Task') {
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
          logAt('basic', `[Claude] COMPACTION: trigger=${cbMsg.compact_metadata.trigger}, pre_tokens=${cbMsg.compact_metadata.pre_tokens}`);
        } else if (responseMessage.subtype === 'init') {
          const sysMsg = responseMessage as SDKSystemMessage;
          initEvent = {
            model: sysMsg.model,
            sessionId: sysMsg.session_id,
          };
          // Store session ID early so it's available for recovery if the query hangs
          chatSessionIds.set(sessionKey, sysMsg.session_id);
          sessionManager.setClaudeSessionId(sessionKey, sysMsg.session_id);
          logAt('basic', `[Claude] SESSION INIT: model=${sysMsg.model}, session=${sysMsg.session_id}`);

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
        logAt('basic', `[Claude] Query completed: ${getTimingReport(timer)}`);
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
            sessionManager.setClaudeSessionId(sessionKey, responseMessage.session_id);
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
          // Clear stale session ID so next attempt starts fresh
          // (but not on silence timeout — we want to preserve the session for recovery)
          chatSessionIds.delete(sessionKey);
          const session = sessionManager.getSession(sessionKey);
          if (session) {
            session.claudeSessionId = undefined;
          }
          logAt('basic', `[Claude] Cleared stale session for session ${sessionKey} due to ${responseMessage.subtype}`);

          fullText = `Error: ${responseMessage.subtype}`;
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
        abortController,
        model: options.model,
        telegramCtx: options.telegramCtx,
      });

      combinedText += response.text;
      allToolsUsed.push(...response.toolsUsed);

      onIterationComplete?.(iteration, response.text);

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
