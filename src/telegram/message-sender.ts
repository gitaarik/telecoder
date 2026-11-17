import { Context, InputFile, GrammyError } from 'grammy';
import { config } from '../config.js';
import { formatMarkdown, markdownToEntities, splitEntityMessage, MAX_MESSAGE_LENGTH } from './markdown.js';
import { editFormatted, replyFormatted } from './send.js';
import {
  getSpinnerFrame,
  getThinkingVerb,
  getToolIcon,
  getToolAction,
  renderStatusLine,
  renderBackgroundFooter,
  extractToolDetail,
  formatBashCommandBlock,
  elideToolOutput,
  stripAnsi,
  TOOL_ICONS,
} from './terminal-renderer.js';
import { taskTracker } from './task-tracker.js';
import { taskListDisplay } from './task-list.js';
import { EntityText, clip, plain, type EntityMessage } from './entities.js';
import type { ToolResultEvent, EditDiffEvent } from '../providers/types.js';
import { getSessionKeyFromCtx, parseSessionKey } from '../utils/session-key.js';
import { resolveVerbosityFlags } from '../utils/verbosity.js';
import { actionLogger, type StatusSource } from './action-logger.js';
import { sessionManager } from '../claude/session-manager.js';
import { sessionJsonlPath } from '../claude/session-jsonl.js';
import { messageOffsets, countJsonlLines } from '../claude/message-offsets.js';
import { storeSuggestion } from '../claude/pending-suggestions.js';
import {
  SUGGESTION_CARD_BUTTON,
  buildSuggestionCardText,
  flattenSuggestion,
  formatSuggestionLabel,
  suggestionFitsOnButton,
} from './prompt-suggestion.js';
import { hasPendingQuestionForSession } from '../claude/ask-user.js';
import { PREMIUM_MODEL_ICON } from '../claude/model-catalog.js';
import { getPremiumModel } from '../providers/provider-router.js';
import * as fs from 'fs';
import * as path from 'path';
import { isClaudeAuthError } from '../claude/claude-auth.js';

export const FORK_KEYBOARD = { inline_keyboard: [[{ text: '🍴 Fork', callback_data: 'fork:pick' }]] };

/**
 * The buttons on the banner where a chat switched conversations: fork that
 * point again, or open the tree of branches it belongs to.
 */
export const BRANCH_MARKER_KEYBOARD = {
  inline_keyboard: [[
    { text: '🍴 Fork', callback_data: 'fork:pick' },
    { text: '🌳 Tree', callback_data: 'tree:show' },
  ]],
};

/**
 * Status-bubble text shown while an ask_user question is waiting on a tap.
 * Replaces the spinner: the watchdog is deliberately paused during a pending
 * question, so nothing else stops the bubble animating "Thinking…" at a turn
 * that is actually parked on the user.
 */
const AWAITING_ANSWER_LINE = '⏸️ Waiting for your answer — see the question below ↓';

/**
 * Status-bubble text once the action log has taken the live status line over.
 * The log is posted below the bubble and is usually tall enough to push it off
 * screen, so the status line moves to the bottom of the log, where the user is
 * looking.
 */
const LOG_POINTER_LINE = '⏳ Working — live log below ↓';

/**
 * Cap on a tool's detail in the status line under the action log. Verbose mode
 * shows paths and patterns whole, and the line shares its message with up to
 * ten actions.
 */
const LOG_STATUS_DETAIL_CHARS = 200;

/** A suggestion registered for this turn, and how it is to be offered. */
interface PlannedSuggestion {
  id: string;
  /** Flattened text — what is shown, and what a tap sends. */
  text: string;
  /** True when the text fits on its own button under the response. */
  onButton: boolean;
}

/**
 * Register a suggestion in the pending-suggestions store and decide how it
 * reaches the user: on a button when it fits there whole, otherwise on a card
 * of its own. Returns null when there is no suggestion for this turn (the
 * caller still gets its fork button).
 */
function planSuggestion(
  sessionKey: string,
  suggestion: string | undefined,
): PlannedSuggestion | null {
  const text = flattenSuggestion(suggestion ?? '');
  if (!text) return null;
  const onButton = suggestionFitsOnButton(text);
  const id = storeSuggestion(sessionKey, text, onButton ? 'button' : 'card');
  return { id, text, onButton };
}

export interface ToolOperation {
  name: string;
  detail?: string;
  /**
   * Multi-line command body rendered beneath the status header while the tool
   * runs (Bash only). Shown in a separate block so the header — and its live
   * timer — stay on one clean line.
   */
  commandBlock?: string;
}

interface StreamState {
  chatId: number;
  threadId?: number;
  sessionKey: string;
  messageId: number | null;
  /** The reply as written so far: every text block of the turn, in markdown. */
  content: string;
  /** When `content` last changed: the status line says "Writing" for a while after. */
  contentChangedAt: number;
  /** `content` as the live messages last showed it. */
  shownContent: string;
  /**
   * What each live message last showed, the bubble first, as a key of its text
   * and entities: an edit that would change nothing is skipped.
   */
  shown: string[];
  /** Messages the live reply overflowed into below the bubble, in order. */
  overflowIds: number[];
  /**
   * The last message this sender posted under the bubble during the turn —
   * prose flushed ahead of a question, mostly. A turn that writes nothing
   * after that puts its fork button here, not on the bubble above it.
   */
  lastPostId: number | null;
  /** A refresh held back by the edit throttle, due when the throttle allows. */
  flushTimer: NodeJS.Timeout | null;
  /**
   * Live edits sent and not yet answered. One can outlast the turn: autoRetry
   * holds an edit Telegram rate-limited for up to a minute, then sends it
   * again. finishStreaming and cancelStreaming wait for these before their own
   * edit, so a late "Writing…" can't land on top of the final text.
   */
  liveEdits: Set<Promise<boolean>>;
  /** Set once finish or cancel has begun; no live edit starts after it. */
  ended: boolean;
  /** Gap between edits that show new text; grows after Telegram rate-limits us. */
  streamIntervalMs: number;
  lastUpdate: number;
  // The live status line
  spinnerIndex: number;
  spinnerInterval: NodeJS.Timeout | null;
  currentOperation: ToolOperation | null;
  operationStartTime: number;
  rateLimitedUntil: number;
  lastRateLimitDurationMs: number;
  // Claude Code's live spinner tip (PTY mode), mirrored under the status line.
  // Null when no tip is currently on screen.
  tip: string | null;
  // Action logging for verbose mode
  actionLogEnabled: boolean;
  // What the turn was sent, drawn at the bottom of the action log.
  prompt: string;
  // The premium model the turn runs on, badged on the status line; see premiumBadge.
  premiumModel?: string;
}

const MIN_EDIT_INTERVAL_MS = 10000; // Minimum time between status-only edits (~5 edits/min safe zone)

/**
 * Minimum time between edits that show more of the reply. Telegram allows a
 * bot about one message a second in a private chat and twenty a minute in a
 * group, edits included, and the status line and action log draw on the same
 * allowance. A 429 doubles the gap, up to {@link MAX_STREAM_EDIT_INTERVAL_MS}.
 */
const STREAM_EDIT_INTERVAL_MS = 1500;
const GROUP_STREAM_EDIT_INTERVAL_MS = 3500;
const MAX_STREAM_EDIT_INTERVAL_MS = 15000;

/** How long after new text the status line keeps saying "Writing". */
const WRITING_WINDOW_MS = 4000;

/** On the status line while the reply is being written: the text above it isn't final yet. */
const STREAMING_INDICATOR = '✍️ Writing…';

/**
 * Tacked onto the status line's first line while a premium model is on, so a
 * fable picked for one task doesn't go on quietly spending the plan's limits
 * on the next ten.
 */
function premiumBadge(model: string | undefined): string {
  return model ? ` · ${PREMIUM_MODEL_ICON} ${model}` : '';
}

// `mcp__telecoder-tools__telecoder_send_file` → `telecoder_send_file`
function stripMcpServerPrefix(toolName: string): string {
  if (!toolName.startsWith('mcp__')) return toolName;
  const lastSep = toolName.lastIndexOf('__');
  return lastSep > 0 ? toolName.slice(lastSep + 2) : toolName;
}

/**
 * Trim long absolute paths so a diff header reads `src/foo.ts` rather than
 * `/home/rik/dev/telecoder/src/foo.ts`. Falls back to the full path if no
 * prefix matches.
 */
function stripWorkingDir(filePath: string): string {
  const cwd = process.cwd();
  if (filePath.startsWith(cwd + '/')) return filePath.slice(cwd.length + 1);
  const home = process.env.HOME;
  if (home && filePath.startsWith(home + '/')) return '~/' + filePath.slice(home.length + 1);
  return filePath;
}

/** Everything one refresh of the live status bubble shows. */
export interface StatusBubbleView {
  /** An ask_user question is waiting on a tap. */
  awaitingAnswer: boolean;
  /** The tool running now, or null while Claude is thinking. */
  operation: ToolOperation | null;
  spinnerIndex: number;
  /** How long `operation` has been running. */
  elapsedMs: number;
  /** The Telegram rate-limit pause the last edit ran into, if any. */
  pausedMs?: number;
  /** Claude Code's live spinner tip (PTY mode); null when none is on screen. */
  tip: string | null;
  /** Background-task footer; null when nothing runs in the background. */
  footer: EntityMessage | null;
  /** The reply has grown in the last few seconds: say "Writing", not "Thinking". */
  writing?: boolean;
  /** The premium model the turn runs on, if any. */
  premiumModel?: string;
}

/**
 * Lay out the live status bubble.
 *
 * A running Bash command goes in a `bash` code block, the way the permission
 * prompt shows one: monospace keeps a long one-liner's pipes and `$(...)`
 * legible, and the block's copy button hands back the bare command.
 *
 * Entities rather than MarkdownV2: the command is the model's own text, and an
 * underscore or backtick in it would break the parse and fail the edit.
 *
 * Exported for tests.
 */
export function renderStatusBubble(view: StatusBubbleView): EntityMessage {
  const b = new EntityText();
  const { operation } = view;

  if (view.awaitingAnswer) {
    // A pending ask_user question outranks the tool/thinking status: the turn
    // is blocked on a button tap, and a spinner here reads as work still in
    // progress, which is exactly the cue that makes a question easy to miss.
    b.add(AWAITING_ANSWER_LINE);
  } else if (operation) {
    b.add(renderStatusLine(
      view.spinnerIndex,
      getToolIcon(operation.name),
      getToolAction(operation.name),
      operation.detail?.trim(),
      view.elapsedMs,
      view.pausedMs,
    ) + premiumBadge(view.premiumModel));
    // Bash commands render their (possibly multi-line) command in a separate
    // block below the header so the timer stays on a clean single line.
    if (operation.commandBlock) b.newline().pre(operation.commandBlock, 'bash');
  } else if (view.writing) {
    b.add(`${getSpinnerFrame(view.spinnerIndex)} ${STREAMING_INDICATOR}${premiumBadge(view.premiumModel)}`);
  } else {
    b.add(`${getSpinnerFrame(view.spinnerIndex)} ${TOOL_ICONS.thinking} ${getThinkingVerb()}...${premiumBadge(view.premiumModel)}`);
  }

  // Mirror Claude Code's live spinner tip under the status line, as the TUI
  // shows it. Suppressed while a question is pending — the tip is whatever was
  // on screen when the model blocked, and it dilutes the one line that matters.
  if (view.tip && !view.awaitingAnswer) b.newline().add(`  ⎿ 💡 ${view.tip}`);

  if (view.footer) b.newline(2).append(view.footer);

  return b.build();
}

/** A message's text and formatting as one comparable string. */
function messageKey(message: EntityMessage): string {
  return `${message.text}\u0000${JSON.stringify(message.entities)}`;
}

export class MessageSender {
  private streamStates: Map<string, StreamState> = new Map();
  // Per-stream counter of new chat messages posted during the turn (task
  // list first render, monitor armed/events, sub-turn echoes, backgrounded task
  // completions). Drives two behaviors when > 0:
  //   - finishStreaming posts the final response as a fresh bottom message
  //     and reduces the original "Processing..." bubble to a pointer, so the
  //     final answer isn't buried above the intervening messages.
  //   - sendCompletionNotification suppresses the generic "✅ Done" ping —
  //     the bottom-posted final message is itself a notification.
  // Reset on startStreaming.
  private interveningPostsThisStream: Map<string, number> = new Map();

  constructor() {
    // A task-list card is posted by a timer as often as by a tool call, so it
    // is counted where it is posted rather than where it was asked for.
    taskListDisplay.onPost((sessionKey) => this.noteInterveningPost(sessionKey));
  }

  private noteInterveningPost(sessionKey: string | undefined): void {
    if (!sessionKey) return;
    const prev = this.interveningPostsThisStream.get(sessionKey) ?? 0;
    this.interveningPostsThisStream.set(sessionKey, prev + 1);
  }

  /**
   * Send markdown — the model's own text, usually — as however many messages
   * it takes, with an Instant View link under the last when the reply is long
   * enough to be worth a page. The text always goes out in full: the page is a
   * second way to read it, not a replacement for it.
   *
   * Returns the message_id of the last Telegram message posted, or null if
   * nothing was sent (every attempt failed). Callers that want to attach the
   * /fork button use this to know which message to anchor onto.
   */
  async sendMessage(ctx: Context, text: string): Promise<number | null> {
    return this.sendParts(ctx, formatMarkdown(text, config.MAX_MESSAGE_LENGTH));
  }

  /** Post `parts` in order; the id of the last one that went out. */
  private async sendParts(ctx: Context, parts: EntityMessage[]): Promise<number | null> {
    let lastMessageId: number | null = null;
    for (const part of parts) {
      try {
        lastMessageId = (await replyFormatted(ctx, part)).message_id;
      } catch (error) {
        console.error('[Send] Failed to send part:', error instanceof Error ? error.message : error);
        try {
          lastMessageId = (await ctx.reply('⚠️ Message formatting error')).message_id;
        } catch { /* give up */ }
      }
    }
    // Posted during a turn, this is the lowest message of the turn so far:
    // finishStreaming anchors the fork button here when nothing follows it.
    const sessionKey = getSessionKeyFromCtx(ctx)?.sessionKey;
    const state = sessionKey ? this.streamStates.get(sessionKey) : undefined;
    if (state && lastMessageId !== null) state.lastPostId = lastMessageId;
    return lastMessageId;
  }

  /**
   * Attach a "🍴 Fork" button to a past assistant message and record the
   * JSONL truncation point that corresponds to it. Idempotent: calling this
   * twice on the same message just re-records the offset (Telegram returns
   * "message is not modified" on the second edit, which we swallow).
   *
   * Safe to call when there's no active claudeSessionId or JSONL yet — we
   * silently skip in that case so the assistant turn isn't blocked by a
   * fork-tracking edge case.
   */
  async attachForkButton(
    ctx: Context,
    sessionKey: string,
    messageId: number | null | undefined,
    suggestion: PlannedSuggestion | null = null,
  ): Promise<void> {
    if (!messageId) return;
    const session = sessionManager.getSession(sessionKey);
    if (!session?.claudeSessionId) return;

    const jsonlPath = sessionJsonlPath(session.workingDirectory, session.claudeSessionId);
    const lineCount = countJsonlLines(jsonlPath);
    if (lineCount === 0) return;

    messageOffsets.record(sessionKey, messageId, {
      claudeSessionId: session.claudeSessionId,
      projectPath: session.workingDirectory,
      lineCount,
      conversationId: session.conversationId,
    });

    // A suggestion short enough to read on a button goes on a row above the
    // fork button, so it is the primary call-to-action and fork stays as the
    // secondary affordance. A longer one is not put here at all — it would
    // arrive clipped — and {@link sendSuggestionCard} gives it its own
    // message instead.
    const rows: Array<Array<{ text: string; callback_data: string }>> = [];
    if (suggestion?.onButton) {
      rows.push([{
        text: formatSuggestionLabel(suggestion.text),
        callback_data: `sgt:${suggestion.id}`,
      }]);
    }
    rows.push([{ text: '🍴 Fork', callback_data: 'fork:pick' }]);
    const replyMarkup = rows.length === 1 ? FORK_KEYBOARD : { inline_keyboard: rows };

    try {
      await ctx.api.editMessageReplyMarkup(
        ctx.chat!.id,
        messageId,
        { reply_markup: replyMarkup },
      );
    } catch (err) {
      // "message is not modified" or "message to edit not found" — non-fatal.
      const msg = err instanceof Error ? err.message.toLowerCase() : '';
      if (!msg.includes('not modified') && !msg.includes('not found') && !msg.includes('message_id_invalid')) {
        console.debug('[Fork] attachForkButton edit failed:', err instanceof Error ? err.message : err);
      }
    }
  }

  /**
   * Post a suggestion that is too wide for a button as its own message: the
   * full prompt in the body, a fixed short label on the button below it.
   *
   * Sent silently — the response it follows has already raised a notification,
   * and a second ping for an optional suggestion is not worth a buzz. No-ops
   * for a suggestion that rode on its button, and for a turn that had none.
   */
  async sendSuggestionCard(ctx: Context, suggestion: PlannedSuggestion | null): Promise<void> {
    if (!suggestion || suggestion.onButton) return;

    const reply_markup = {
      inline_keyboard: [[{ text: SUGGESTION_CARD_BUTTON, callback_data: `sgt:${suggestion.id}` }]],
    };
    try {
      await replyFormatted(ctx, buildSuggestionCardText(suggestion.text), {
        reply_markup,
        disable_notification: true,
      });
    } catch (err) {
      // The answer itself already landed; a missing suggestion is cosmetic.
      console.debug('[Suggestion] card send failed:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Send a file as a document attachment
   */
  async sendDocument(ctx: Context, filePath: string, caption?: string): Promise<boolean> {
    try {
      if (!fs.existsSync(filePath)) {
        console.error('[Document] File not found:', filePath);
        return false;
      }

      const fileName = path.basename(filePath);
      const fileBuffer = fs.readFileSync(filePath);
      const inputFile = new InputFile(fileBuffer, fileName);

      await ctx.replyWithDocument(inputFile, { caption });

      return true;
    } catch (error) {
      console.error('[Document] Failed to send:', error);
      return false;
    }
  }

  async startStreaming(ctx: Context, prompt: string): Promise<void> {
    const keyInfo = getSessionKeyFromCtx(ctx);
    if (!keyInfo) return;
    const { chatId, threadId, sessionKey } = keyInfo;

    const verbosityFlags = resolveVerbosityFlags(chatId);
    const actionLogEnabled = verbosityFlags.useActionLog && (verbosityFlags.showToolResults || verbosityFlags.showDiffs);


    const premiumModel = getPremiumModel(sessionKey);
    const initialText = `${getSpinnerFrame(0)} ${TOOL_ICONS.thinking} ${getThinkingVerb()}...${premiumBadge(premiumModel)}`;
    // No "typing…": the turn has a live status line — in the bubble, then at
    // the bottom of the action log — and Telegram Desktop draws the typing
    // animation on the CPU for as long as it is up, which renewed every few
    // seconds is the whole turn.
    const message = await ctx.reply(initialText);

    const now = Date.now();
    const state: StreamState = {
      chatId,
      threadId,
      sessionKey,
      messageId: message.message_id,
      content: '',
      contentChangedAt: 0,
      shownContent: '',
      shown: [],
      overflowIds: [],
      lastPostId: null,
      flushTimer: null,
      liveEdits: new Set(),
      ended: false,
      streamIntervalMs: ctx.chat?.type === 'private' ? STREAM_EDIT_INTERVAL_MS : GROUP_STREAM_EDIT_INTERVAL_MS,
      lastUpdate: now,
      spinnerIndex: 0,
      spinnerInterval: null,
      currentOperation: null,
      operationStartTime: now,
      rateLimitedUntil: 0,
      lastRateLimitDurationMs: 0,
      tip: null,
      actionLogEnabled,
      prompt,
      premiumModel,
    };

    // Register before anything else can throw. The typing indicator and the
    // thinking bubble are already live at this point, and the only handle on
    // them is `state` — if we bail out before registering, finish/cancel can't
    // find the stream and the "typing…" interval ticks forever.
    this.streamStates.set(sessionKey, state);
    this.interveningPostsThisStream.set(sessionKey, 0);
    // The task list's next change posts a fresh card, under this turn's prompt.
    taskListDisplay.startTurn(sessionKey);

    // Initialize action logging if enabled. Cosmetic, so a failure here
    // degrades to a turn without an action log rather than no turn at all.
    if (actionLogEnabled) {
      try {
        await actionLogger.initialize(ctx, sessionKey, this.logStatusSource(state), state.prompt);
      } catch (error) {
        console.error('[ActionLog] initialize failed, continuing without it:', error);
      }
    }

    // Periodic refresh so the elapsed timer and spinner update even during long tool runs
    state.spinnerInterval = setInterval(() => {
      state.spinnerIndex += 1;
      if (ctx) {
        this.flushLive(ctx, state).catch(() => {});
      }
    }, MIN_EDIT_INTERVAL_MS);
  }

  private stopSpinnerAnimation(state: StreamState): void {
    if (state.spinnerInterval) {
      clearInterval(state.spinnerInterval);
      state.spinnerInterval = null;
    }
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }
  }

  /**
   * Update the current tool operation (terminal UI mode).
   * Event-driven: triggers a status message edit on each tool change.
   */
  updateToolOperation(sessionKey: string, toolName: string, input?: Record<string, unknown>, ctx?: Context): void {
    const state = this.streamStates.get(sessionKey);
    if (!state) return;

    // TaskCreate and TaskUpdate change the task list on disk; its card is
    // redrawn from there once the write has landed.
    if (ctx) {
      taskListDisplay.noteToolStart(ctx.api, sessionKey, toolName, sessionManager.getSession(sessionKey)?.claudeSessionId);
    }

    const { chatId } = parseSessionKey(sessionKey);
    const verbose = resolveVerbosityFlags(chatId).fullToolInputs;
    if (toolName === 'Bash') {
      // Show the full command in a block beneath the header (capped per the
      // verbose flag) instead of just its first line on the `→` row — a leading
      // `cd` otherwise hides the slow work the timer is actually counting.
      const command = typeof input?.command === 'string' ? input.command : undefined;
      state.currentOperation = { name: toolName, commandBlock: formatBashCommandBlock(command, verbose) };
    } else {
      const detail = input ? extractToolDetail(toolName, input, verbose) : undefined;
      state.currentOperation = { name: toolName, detail };
    }
    state.operationStartTime = Date.now();
    state.spinnerIndex += 1;

    if (ctx) {
      this.flushLive(ctx, state).catch(() => {});
    }
  }

  /**
   * Clear the current tool operation (terminal UI mode)
   */
  clearToolOperation(sessionKey: string): void {
    taskListDisplay.noteToolEnd(sessionKey);
    const state = this.streamStates.get(sessionKey);
    if (!state) return;
    state.currentOperation = null;
  }

  /**
   * Post the "🔔 Scheduled: …" header that precedes a scheduled-task fire.
   * The scheduled prompt itself is then enqueued through the normal turn
   * pipeline; this header just makes the unprompted message obvious so the
   * user understands why a turn appeared with no input from them.
   */
  async postScheduledFire(ctx: Context, label: string, prompt: string): Promise<void> {
    const preview = prompt.length > 100 ? prompt.substring(0, 97) + '...' : prompt;
    const b = new EntityText().add('🔔 ');
    if (label) b.bold('Scheduled').add(` — ${label}`);
    else b.bold('Scheduled fire');
    b.newline().code(preview);
    try {
      await replyFormatted(ctx, b.build());
    } catch (error) {
      console.error('[Schedule] Failed to post scheduled header:', error instanceof Error ? error.message : error);
    }
    this.noteInterveningPost(getSessionKeyFromCtx(ctx)?.sessionKey);
  }

  /**
   * If action-log mode is on for this chat AND the verbosity tier shows tool
   * output, lazily initialize the logger and hand off to `forward`. Returns
   * true when the action log took the message — callers fall through to the
   * direct-post path when it returns false.
   */
  private async routeToActionLog(
    ctx: Context,
    forward: (sessionKey: string) => Promise<void>,
  ): Promise<boolean> {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return false;
    const flags = resolveVerbosityFlags(chatId);
    if (!flags.useActionLog || !(flags.showToolResults || flags.showDiffs)) return false;
    const sessionKey = getSessionKeyFromCtx(ctx)?.sessionKey;
    if (!sessionKey) return false;
    if (!actionLogger.isActive(sessionKey)) {
      // No log for this session. Only open one if a turn is actually
      // streaming — otherwise this is a straggler arriving after the turn
      // ended and the log was collapsed and cleaned up (5s after finishStream),
      // and initializing here would start a *second*, live-looking action log
      // below the collapsed summary. Stragglers post as their own message
      // instead.
      const stream = this.streamStates.get(sessionKey);
      if (!stream) {
        console.debug(`[ActionLog] Straggler for ${sessionKey} after log cleanup — posting directly instead of opening a new log`);
        return false;
      }
      await actionLogger.initialize(ctx, sessionKey, this.logStatusSource(stream), stream.prompt);
    }
    await forward(sessionKey);
    return true;
  }

  /**
   * Post a truncated preview of a tool's result. In action log mode, adds to
   * the consolidated log; otherwise sends as its own Telegram message.
   * Sent only when the chat's verbosity tier resolves `showToolResults: true`
   * (caller is responsible for the gate). Plain text: tool output is shown as
   * it came. The streaming bubble is pushed below via `noteInterveningPost`.
   */
  async postToolResult(
    ctx: Context,
    event: ToolResultEvent,
    maxLines: number,
    maxChars: number,
  ): Promise<void> {
    if (await this.routeToActionLog(ctx, (sk) => actionLogger.addToolResult(sk, event, maxLines, maxChars))) {
      return;
    }

    // Fall back to original behavior
    const cleaned = stripAnsi(event.content).replace(/\s+$/u, '');
    if (!cleaned && !event.isError) return;

    const icon = event.toolName ? getToolIcon(event.toolName) : '🔹';
    const label = event.toolName ? stripMcpServerPrefix(event.toolName) : 'tool';
    const verb = event.isError ? 'error' : 'result';

    // Tail-biased for errors (failures land at the end), head-biased for
    // success — middle elided either way (see elideToolOutput).
    const body = elideToolOutput(cleaned || '(no output)', maxLines, maxChars, { isError: event.isError });

    const detail = event.toolName && event.input
      ? extractToolDetail(event.toolName, event.input, true)
      : undefined;
    const detailLine = detail
      ? `${event.toolName === 'Bash' ? '$ ' : ''}${detail}\n`
      : '';

    const text = `${icon} ${label} ${verb}\n${detailLine}${body}`;
    try {
      await replyFormatted(ctx, text);
      this.noteInterveningPost(getSessionKeyFromCtx(ctx)?.sessionKey);
    } catch (err) {
      console.error('[ToolResult] Failed to post:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Post a before/after preview for a successful Edit or Write call. In action
   * log mode, adds to the consolidated log; otherwise sends as its own message.
   * Each side is independently capped at `maxLines` and prefixed with `-`/`+`.
   * Write (new file) skips the `-` side. Plain text, shown as it came.
   */
  async postEditDiff(ctx: Context, event: EditDiffEvent, maxLines: number): Promise<void> {
    if (await this.routeToActionLog(ctx, (sk) => actionLogger.addEditDiff(sk, event, maxLines))) {
      return;
    }

    // Fall back to original behavior
    const fileLabel = stripWorkingDir(event.filePath);
    const headerIcon = event.toolName === 'Write' ? '✏️' : '🔧';
    const lines: string[] = [`${headerIcon} ${event.toolName} ${fileLabel}`];

    if (typeof event.oldString === 'string' && event.oldString.length > 0) {
      const oldLines = event.oldString.split('\n');
      const oldShown = oldLines.slice(0, maxLines).map((l) => `- ${l}`);
      if (oldLines.length > maxLines) {
        oldShown.push(`- [+${oldLines.length - maxLines} more lines]`);
      }
      lines.push(...oldShown);
    }

    const newLines = event.newString.split('\n');
    const newShown = newLines.slice(0, maxLines).map((l) => `+ ${l}`);
    if (newLines.length > maxLines) {
      newShown.push(`+ [+${newLines.length - maxLines} more lines]`);
    }
    lines.push(...newShown);

    const text = lines.join('\n');
    try {
      await replyFormatted(ctx, text);
      this.noteInterveningPost(getSessionKeyFromCtx(ctx)?.sessionKey);
    } catch (err) {
      console.error('[EditDiff] Failed to post:', err instanceof Error ? err.message : err);
    }
  }

  /** What the status line shows right now. */
  private statusView(state: StreamState): StatusBubbleView {
    return {
      awaitingAnswer: hasPendingQuestionForSession(state.sessionKey),
      operation: state.currentOperation,
      spinnerIndex: state.spinnerIndex,
      elapsedMs: Date.now() - state.operationStartTime,
      pausedMs: state.lastRateLimitDurationMs > 0 ? state.lastRateLimitDurationMs : undefined,
      tip: state.tip,
      footer: renderBackgroundFooter(taskTracker.getTasks(state.sessionKey)),
      writing: Date.now() - state.contentChangedAt < WRITING_WINDOW_MS,
      premiumModel: state.premiumModel,
    };
  }

  /**
   * The status line as the action log draws it at its bottom.
   *
   * It shares a message with up to ten actions, so a long command is clipped
   * as compact mode clips it — verbose mode allows 3,500 characters — and a
   * long detail is cut short. The bubble's rate-limit note is left off: it is
   * about the bubble's own edits, which have stopped.
   */
  private logStatusSource(state: StreamState): StatusSource {
    return () => {
      const view = this.statusView(state);
      const operation = view.operation && {
        ...view.operation,
        detail: view.operation.detail && clip(view.operation.detail, LOG_STATUS_DETAIL_CHARS),
        commandBlock: formatBashCommandBlock(view.operation.commandBlock, false),
      };
      return renderStatusBubble({ ...view, operation, pausedMs: undefined });
    };
  }

  /**
   * The line under the live reply that says it isn't final: the status line,
   * or a pointer down to the action log once that carries the status line.
   */
  private liveFooter(state: StreamState): EntityMessage {
    if (actionLogger.showsStatus(state.sessionKey)) return plain(LOG_POINTER_LINE);
    return renderStatusBubble(this.statusView(state));
  }

  /**
   * The live messages: the reply so far, split where it outgrows one message,
   * with `footer` under the last. The bubble shows the first; the rest
   * overflow into messages of their own below it.
   */
  private liveMessages(state: StreamState, footer: EntityMessage): EntityMessage[] {
    const prose = state.content.trim();
    if (!prose) return [footer];
    const room = MAX_MESSAGE_LENGTH - footer.text.length - 2;
    const parts = splitEntityMessage(markdownToEntities(prose), room, { markers: false });
    if (parts.length === 0) return [footer];
    const last = parts.length - 1;
    return parts.map((part, i) => (i === last ? new EntityText().append(part).newline(2).append(footer).build() : part));
  }

  /**
   * Bring the live messages up to date: the bubble, and any it overflowed
   * into. An edit that only moves the status line waits
   * {@link MIN_EDIT_INTERVAL_MS} since the last; one that shows more of the
   * reply waits the much shorter stream interval, and is scheduled for when
   * that has passed rather than dropped. `immediate` skips the wait, for a
   * change the user has to see now.
   */
  private async flushLive(ctx: Context, state: StreamState, immediate = false): Promise<void> {
    // Verify state is still active
    const currentState = this.streamStates.get(state.sessionKey);
    if (!currentState || currentState !== state || state.ended || !state.messageId) return;

    // Once the action log is in the chat it carries the status line, which it
    // redraws on its own throttle. The bubble's footer just points down at it.
    if (actionLogger.showsStatus(state.sessionKey)) {
      await actionLogger.refreshStatus(state.sessionKey, immediate);
      // The turn may have ended while the log was drawn.
      if (state.ended) return;
    }

    const now = Date.now();
    const newText = state.content !== state.shownContent;
    const interval = newText ? state.streamIntervalMs : MIN_EDIT_INTERVAL_MS;
    const wait = Math.max(state.rateLimitedUntil - now, immediate ? 0 : state.lastUpdate + interval - now);
    if (wait > 0) {
      // New text is worth coming back for; a status-only change is picked up
      // by the next spinner tick.
      if (newText) this.scheduleFlush(ctx, state, wait);
      return;
    }

    const content = state.content;
    state.lastUpdate = now;
    const edit = this.showLive(ctx, state, this.liveMessages(state, this.liveFooter(state)));
    state.liveEdits.add(edit);
    const shown = await edit.finally(() => state.liveEdits.delete(edit));
    if (state.ended) return;
    if (shown) {
      state.shownContent = content;
      // Successful edit — clear any rate-limit annotation after it's been shown once
      state.lastRateLimitDurationMs = 0;
    } else if (newText && state.rateLimitedUntil > Date.now()) {
      // The reply may have stopped growing, so nothing else would bring the
      // text that was refused back once the backoff is over.
      this.scheduleFlush(ctx, state, state.rateLimitedUntil - Date.now());
    }
  }

  private scheduleFlush(ctx: Context, state: StreamState, wait: number): void {
    if (state.flushTimer) return;
    state.flushTimer = setTimeout(() => {
      state.flushTimer = null;
      this.flushLive(ctx, state).catch(() => {});
    }, wait);
  }

  /**
   * Edit the bubble and its overflow messages to `messages`, posting overflow
   * messages that don't exist yet and deleting ones no longer needed. False if
   * Telegram rate-limited us; the throttle is widened and a retry scheduled
   * by the caller's next refresh.
   */
  private async showLive(ctx: Context, state: StreamState, messages: EntityMessage[]): Promise<boolean> {
    try {
      for (let i = 0; i < messages.length; i++) {
        const key = messageKey(messages[i]);
        if (state.shown[i] === key) continue;
        const id = i === 0 ? state.messageId : state.overflowIds[i - 1];
        if (id) {
          await this.editLive(ctx, state.chatId, id, messages[i]);
        } else {
          // Silent: the bubble above already raised the turn's notification,
          // and the final reply raises its own.
          const sent = await replyFormatted(ctx, messages[i], { disable_notification: true });
          state.overflowIds[i - 1] = sent.message_id;
        }
        state.shown[i] = key;
      }
      await this.dropOverflow(ctx, state, messages.length - 1);
      return true;
    } catch (error) {
      if (error instanceof GrammyError && error.error_code === 429) {
        const retryAfter = error.parameters.retry_after ?? 60;
        state.rateLimitedUntil = Date.now() + retryAfter * 1000;
        state.lastRateLimitDurationMs = retryAfter * 1000;
        state.streamIntervalMs = Math.min(state.streamIntervalMs * 2, MAX_STREAM_EDIT_INTERVAL_MS);
        console.warn(`[Stream] Rate limited, backing off for ${retryAfter}s (session:${state.sessionKey})`);
        return false;
      }
      // The bubble was deleted, or the turn ended under us: cosmetic either way.
      const msg = error instanceof Error ? error.message.toLowerCase() : '';
      if (!msg.includes('message to edit not found') && !msg.includes('message_id_invalid')) {
        console.error('[Stream] Error updating live message:', error);
      }
      return false;
    }
  }

  /**
   * Stop live edits and wait out the ones already sent, so the turn's last
   * edit is the one the bubble keeps. Edits land in the order Telegram gets
   * them, and an edit autoRetry is holding after a 429 gets there late.
   */
  private async endLiveEdits(state: StreamState): Promise<void> {
    state.ended = true;
    await Promise.allSettled([...state.liveEdits]);
  }

  /** Edit one message, treating "message is not modified" as done. */
  private async editLive(ctx: Context, chatId: number, messageId: number, message: EntityMessage): Promise<void> {
    try {
      await editFormatted(ctx.api, chatId, messageId, message);
    } catch (error) {
      if (error instanceof Error && error.message.includes('message is not modified')) return;
      throw error;
    }
  }

  /** Delete the overflow messages past the first `keep`. */
  private async dropOverflow(ctx: Context, state: StreamState, keep: number): Promise<void> {
    while (state.overflowIds.length > keep) {
      const id = state.overflowIds.pop()!;
      state.shown.length = Math.min(state.shown.length, state.overflowIds.length + 1);
      try {
        await ctx.api.deleteMessage(state.chatId, id);
      } catch { /* already gone */ }
    }
  }

  /**
   * The reply so far — the whole of it, every text block of the turn in
   * markdown — shown live in the bubble above the status line, and updated as
   * it grows until {@link finishStreaming} puts the final text in its place.
   */
  updateStream(ctx: Context, content: string): void {
    const keyInfo = getSessionKeyFromCtx(ctx);
    if (!keyInfo) return;

    const state = this.streamStates.get(keyInfo.sessionKey);
    if (!state || !state.messageId || content === state.content) return;

    state.content = content;
    state.contentChangedAt = Date.now();
    this.flushLive(ctx, state).catch(() => {});
  }

  /**
   * Mirror Claude Code's live spinner tip (PTY mode) under the status line.
   * Pass null to clear it. Attempts an immediate flush so the tip appears
   * promptly; the flush respects the normal edit throttle, and the periodic
   * spinner refresh picks it up otherwise.
   */
  updateTip(ctx: Context, tip: string | null): void {
    const keyInfo = getSessionKeyFromCtx(ctx);
    if (!keyInfo) return;

    const state = this.streamStates.get(keyInfo.sessionKey);
    if (!state || !state.messageId) return;
    if (state.tip === tip) return;

    state.tip = tip;
    this.flushLive(ctx, state).catch(() => {});
  }

  /**
   * An ask_user question has just been posted to the chat.
   *
   * Counts it as an intervening post so finishStreaming publishes the final
   * answer as a fresh message at the bottom. Without this the counter stays at
   * 0 and the answer is edited into the status bubble — which sits *above* the
   * question — and a Telegram edit neither notifies nor re-orders, so the
   * question remains the last thing in the chat while the answer lands
   * silently upstream where it is easy to never see.
   *
   * Also repoints the status bubble at the user; see {@link AWAITING_ANSWER_LINE}.
   */
  async noteQuestionPosted(ctx: Context, sessionKey: string): Promise<void> {
    this.noteInterveningPost(sessionKey);
    await this.refreshQuestionStatus(sessionKey, ctx);
  }

  /**
   * Counterpart to {@link noteQuestionPosted}, called once the question is
   * resolved — by a tap or by timing out — so the bubble drops the waiting
   * notice and goes back to reporting progress.
   *
   * What the turn does next goes in a new action log, under the question and
   * the answer: see {@link ActionLogger.startNewMessage}.
   */
  async noteQuestionAnswered(ctx: Context, sessionKey: string): Promise<void> {
    actionLogger.startNewMessage(sessionKey);
    await this.refreshQuestionStatus(sessionKey, ctx);
  }

  /**
   * Re-render the bubble to match the session's current pending-question
   * state. Reads the registry rather than tracking a flag of its own, so the
   * bubble cannot disagree with it — overlapping asks and timeouts both land
   * on the right text without extra bookkeeping.
   */
  private async refreshQuestionStatus(sessionKey: string, ctx: Context): Promise<void> {
    const state = this.streamStates.get(sessionKey);
    if (!state || !state.messageId) return;
    // Bypass the edit throttle: the point of the notice is that it lands
    // now, not up to MIN_EDIT_INTERVAL_MS later on the next spinner tick.
    await this.flushLive(ctx, state, true).catch(() => {});
  }

  async finishStreaming(
    ctx: Context,
    finalContent: string,
    options: { nextPromptSuggestion?: string } = {},
  ): Promise<void> {
    const keyInfo = getSessionKeyFromCtx(ctx);
    if (!keyInfo) return;
    const { chatId, sessionKey } = keyInfo;

    const state = this.streamStates.get(sessionKey);
    if (!state) return;

    // Stop the spinner and any held-back refresh
    this.stopSpinnerAnimation(state);
    state.currentOperation = null;
    await this.endLiveEdits(state);

    // Track the last Telegram message we posted in this turn so the /fork
    // button can be anchored to the final user-visible message (so a tap
    // forks AT that point, not at some earlier chunk).
    let lastMessageId: number | null = state.messageId;

    // Registered once, past the early returns above: an entry planned for a
    // turn that never renders would sit in the store until its TTL with no
    // button pointing at it.
    const suggestion = planSuggestion(sessionKey, options.nextPromptSuggestion);

    // A card posted at the very end of the turn still counts as an intervening post.
    await taskListDisplay.flush(sessionKey);

    if (state.messageId) {
      const hasInterveningPosts = (this.interveningPostsThisStream.get(sessionKey) ?? 0) > 0;
      const actionLogWasActive = actionLogger.isActive(sessionKey);

      // If the action log was used OR other messages interrupted the flow,
      // post the final answer as a new message for better visibility.
      if (hasInterveningPosts || actionLogWasActive) {
        const trimmedFinal = finalContent.trim();
        await this.dropOverflow(ctx, state, 0);
        try {
          await editFormatted(ctx.api, chatId, state.messageId, trimmedFinal ? '✅ Done — full response below ↓' : '✅ Done');
        } catch (err) {
          console.debug('[Stream] Pointer edit failed:', err instanceof Error ? err.message : err);
        }
        if (trimmedFinal) {
          const sentId = await this.sendMessage(ctx, finalContent);
          if (sentId) lastMessageId = sentId;
        }
      } else {
        // No intervening posts: the live messages become the answer, edited in place.
        let parts = formatMarkdown(finalContent, config.MAX_MESSAGE_LENGTH);
        if (parts.length === 0) parts = [plain('Done.')];
        try {
          const ids = [state.messageId, ...state.overflowIds];
          for (let i = 0; i < parts.length; i++) {
            if (i < ids.length) {
              await this.editLive(ctx, chatId, ids[i], parts[i]);
              lastMessageId = ids[i];
            } else {
              lastMessageId = (await replyFormatted(ctx, parts[i])).message_id;
            }
          }
          await this.dropOverflow(ctx, state, parts.length - 1);
        } catch (error) {
          console.error('[Stream] Final edit failed, sending the answer fresh:', error);
          await this.dropOverflow(ctx, state, 0);
          try {
            await ctx.api.deleteMessage(chatId, state.messageId);
          } catch { /* ignore */ }
          lastMessageId = await this.sendMessage(ctx, finalContent);
        }
      }
    }

    // Everything the turn had to say went out before a question was asked,
    // and the answer ended it: the final text is empty, and the fork button
    // belongs under that prose, not on the "Done" bubble above it and the
    // question.
    if (!finalContent.trim() && state.lastPostId !== null) lastMessageId = state.lastPostId;

    await this.attachForkButton(ctx, sessionKey, lastMessageId, suggestion);
    await this.sendSuggestionCard(ctx, suggestion);

    this.streamStates.delete(sessionKey);

    // Draw the live log one last time once any remaining tool results have
    // landed.
    actionLogger.endTurn(sessionKey);
  }

  /**
   * Put a cancel/error banner where the status line was, under whatever of the
   * reply had been written, and tear down the per-turn streaming state.
   * `reason` is either an explicit banner string or the Error that ended the
   * turn; an Error whose `name` is `ClaudeApiError` gets a distinct banner so
   * users can tell a Claude Code API failure apart from a /stop they initiated
   * themselves.
   */
  async cancelStreaming(ctx: Context, reason: string | Error = '⚠️ Request cancelled'): Promise<void> {
    const banner = typeof reason === 'string'
      ? reason
      : isClaudeAuthError(reason?.message) || reason?.name === 'ClaudeNotLoggedInError'
        ? "🔑 Claude Code isn't logged in — turn aborted"
        : (reason?.name === 'ClaudeApiError' ? '⚠️ Claude API error — turn aborted' : '⚠️ Request cancelled');

    const keyInfo = getSessionKeyFromCtx(ctx);
    if (!keyInfo) return;
    const { sessionKey } = keyInfo;

    const state = this.streamStates.get(sessionKey);
    if (state) {
      this.stopSpinnerAnimation(state);
      await this.endLiveEdits(state);

      if (state.messageId) {
        // Shown in full, unthrottled: this is the last edit the turn makes.
        state.shown = [];
        await this.showLive(ctx, state, this.liveMessages(state, plain(banner)));
      }
    }

    this.streamStates.delete(sessionKey);

    // Draw the live log one last time once any remaining tool results have
    // landed.
    actionLogger.endTurn(sessionKey);
  }

  /**
   * Send a brief new message to trigger a push notification after a long task.
   * Telegram only notifies on new messages, not edits — so streaming mode
   * needs this to alert the user when a long task finishes.
   *
   * Suppressed when at least one backgrounded-task completion message was
   * already posted during this stream — that message is itself a new chat
   * message, which triggers a notification on its own.
   */
  async sendCompletionNotification(ctx: Context, elapsedMs: number): Promise<void> {
    if (!config.NOTIFICATION_ENABLED) return;
    if (elapsedMs < config.NOTIFICATION_THRESHOLD_SECONDS * 1000) return;

    const chatId = ctx.chat?.id;
    if (chatId !== undefined && !resolveVerbosityFlags(chatId).sendCompletionPing) return;

    const sessionKey = getSessionKeyFromCtx(ctx)?.sessionKey;
    if (sessionKey) {
      const intervening = this.interveningPostsThisStream.get(sessionKey) ?? 0;
      if (intervening > 0) return;
    }

    try {
      const seconds = Math.round(elapsedMs / 1000);
      const duration = seconds >= 60
        ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
        : `${seconds}s`;
      await ctx.reply(`✅ Done (${duration})`);
    } catch (error) {
      console.error('[Notification] Failed to send completion notification:', error);
    }
  }

  // Send typing indicator for a specific chat (useful for long operations)
  async sendTyping(ctx: Context): Promise<void> {
    try {
      await ctx.api.sendChatAction(ctx.chat!.id, 'typing');
    } catch (error) {
      console.error('Error sending typing:', error);
    }
  }
}

export const messageSender = new MessageSender();
