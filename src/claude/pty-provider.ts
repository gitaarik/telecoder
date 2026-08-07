import { spawn, type IPty } from 'node-pty';
import headless from '@xterm/headless';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { config } from '../config.js';
import { sessionManager } from './session-manager.js';
import { claudeSessionFileExists, readLastApiErrorFromJsonl, readLastAssistantTurnText, readLastCompactionFromJsonl, readLastUsageFromJsonl, readLastUserPromptMarker, sessionJsonlMtimeMs, type CompactionInfo, type UserPromptMarker } from './session-jsonl.js';
import { clearDeliveredProse, getDeliveredProse, stripDeliveredPrefix } from './turn-prose.js';
import { isNativeCompactCommand } from './command-parser.js';
import { isCancelled } from './request-queue.js';
import { getWorkspaceRoot } from '../utils/workspace-guard.js';
import { parseSessionKey } from '../utils/session-key.js';
import { fmtTokens } from '../utils/format.js';
import { envWithoutParentSession } from '../utils/claude-env.js';
import { legacyEnv } from '../utils/legacy-env.js';
import { userPreferences } from '../providers/user-preferences.js';
import {
  getIpcPort,
  registerActiveTurn,
  registerIpcHandler,
  unregisterActiveTurn,
  type ActiveTurn,
} from './ipc-server.js';
// Side-effect import: registers /mcp/* IPC handlers that bridge the standalone
// MCP subprocess back to bot-side state (Telegram API, session topic, …).
import './mcp-bridge.js';
import { onAsyncToolArmed, markTurnStart, markTurnEnd, teardown as teardownMonitorRelay, relayPushNotification, type AsyncToolKind } from './monitor-relay.js';
import { isSubagentTool } from './subagent-tools.js';
import { relayUpdateBanner, scrapeUpdateBanner } from './update-banner-relay.js';
import { evaluateToolCall, isPermissionGateEnabled, DENY_MARKER_START, DENY_MARKER_END } from './permission-gate.js';
import {
  buildSettingsJson,
  buildMcpConfigJson,
  buildMcpEnv,
  buildMcpToolsSystemPromptNote,
} from './pty-spawn-config.js';
import { scrapePromptSuggestion } from './prompt-suggestion-scraper.js';
import { scrapeTip } from './tip-scraper.js';
import { isSuggestionsEnabled } from '../telegram/suggestions-settings.js';
import type { Context } from 'grammy';
import { type AgentOptions, type AgentResponse, type Provider, type ProviderName, type ModelInfo, type AgentUsage, type LoopOptions, type EditDiffEvent, type ToolResultEvent, type ImageAttachment } from '../providers/types.js';

const { Terminal } = headless;

// ---- Config from prototype --------------------------------------------------

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

// dist/claude/pty-provider.js → sibling dist/bin/mcp-server.js

const COLS = 120;
const ROWS = 40;
const IDLE_MS = 1200;

/**
 * Short window we wait *after* the Stop hook fires before extracting the
 * screen. Stop fires when claude finishes the response, but the TUI is
 * still redrawing the input box at that point. Without a settle, we'd
 * sometimes capture a half-rendered screen. 200ms is enough in practice.
 */
const POST_STOP_SETTLE_MS = 200;
/**
 * Absolute wall-clock cap for a single turn — safety net for a genuinely
 * wedged pty. Substantive investigative turns (multi-step Bash, deep code
 * reads) can legitimately run several minutes; the default (2 h, via
 * CLAUDE_PTY_HARD_TIMEOUT_MS) is long enough to let those finish while still
 * being a sane upper bound. Raise the env var for unusually long turns. Note
 * that the inflight gate and bullet-count gate already prevent the
 * *idle-fallback* from firing prematurely — this timer only fires if neither
 * Stop nor any other resolve path triggers for the full duration.
 */
const MAX_TURN_MS = config.CLAUDE_PTY_HARD_TIMEOUT_MS;
const STARTUP_MAX_MS = 15_000;
/**
 * Readiness thresholds for the first turn on a pty spawned with `--resume`.
 * Claude replays the whole transcript on resume, and a long conversation takes
 * minutes of near-continuous rendering — during which it draws the input glyph
 * early, pauses, and keeps going. The normal 1.2s/15s pair reads one of those
 * pauses as "ready", the prompt is pasted into an editor that isn't listening
 * yet, and the Enter that submits it is swallowed. Demand a longer quiet period
 * and allow far longer to reach it: waiting out the replay beats submitting
 * into it. Still capped, so a genuinely stuck TUI can't hang the bot.
 */
const RESUME_SETTLE_IDLE_MS = 3_000;
const RESUME_STARTUP_MAX_MS = 180_000;
/**
 * After writing \r we confirm claude actually took the prompt — it appears in
 * the session log as a user record. Until that lands (or we give up), re-send
 * \r periodically as long as our text is still sitting in the input box: a
 * swallowed keystroke is invisible otherwise, and the turn would resolve on
 * stale log content. Skipped for slash commands, which need not write a record.
 */
const SUBMIT_CONFIRM_CAP_MS = 30_000;
const SUBMIT_RETRY_EVERY_MS = 3_000;

/**
 * The slice of a prompt we look for on the rendered screen: leading
 * non-whitespace of the first line, short enough to survive wrapping in the
 * 120-col input box, long enough to be distinctive. Undefined when the prompt
 * is too short to match meaningfully — callers treat that as "can't tell".
 */
function promptNeedle(prompt: string): string | undefined {
  const firstLine = prompt.replace(/^\s+/, '').split(/\r?\n/, 1)[0] ?? '';
  const needle = firstLine.slice(0, 24);
  return needle.length < 4 ? undefined : needle;
}
/**
 * Idle + prompt-visible safety net for prompts that produce no JSONL activity.
 * Most prompts (model turns, /compact, /clear, /handoff, …) write at least one
 * record to the session log, so the JSONL-mtime gate resolves them cleanly.
 * Slash commands like /cost or /config emit purely TUI output without touching
 * the log; without this fallback those would hang until MAX_TURN_MS. 5s of
 * confirmed idle with the input prompt back on screen is well past any
 * realistic typing latency from claude itself.
 */
const NO_JSONL_FALLBACK_MS = 5_000;

/**
 * Thrown by sendToAgent when Claude Code wrote a synthetic API-error record to
 * the session log for the just-finished turn (socket dropped, rate limit, …).
 * Surfaced as a distinct class so message handlers can show an API-error
 * banner instead of the generic "⚠️ Request cancelled" used for user /stop.
 */
export class ClaudeApiError extends Error {
  constructor(public detail: string) {
    super(`Claude Code API error: ${detail}`);
    this.name = 'ClaudeApiError';
  }
}

function resolveCwd(sessionKey: string): string {
  const session = sessionManager.getSession(sessionKey);
  if (!session) {
    throw new Error('No active session. Use /project to set working directory.');
  }
  const cwd = session.workingDirectory;
  if (cwd && fs.existsSync(cwd)) return cwd;
  const fallback = process.env.HOME || process.cwd();
  console.warn(`[PtyProvider] Working directory does not exist: ${cwd}, falling back to ${fallback}`);
  return fallback;
}


interface PtySession {
  term: IPty;
  xterm: headless.Terminal;
  cwd: string;
  /**
   * Pre-minted UUID passed to `claude --session-id`. Used as the registry key
   * for hook event dispatch (the hook payload's `session_id` matches this).
   */
  claudeSessionId: string;
  lastChunkAt: number;
  endOfTurnResolver: ((text: string) => void) | null;
  endOfTurnRejector: ((err: Error) => void) | null;
  idleTimer: NodeJS.Timeout | null;
  hardTimer: NodeJS.Timeout | null;
  onProgress?: (progress: string) => void;
  /** Forwards Claude Code's live spinner tip to the Telegram status line. */
  onTip?: (tip: string | null) => void;
  /** Last tip value pushed via onTip; gates redundant callbacks. */
  lastTip: string | null;
  lastScreenText: string;
  /**
   * True once the current turn's Stop hook has fired. While true, the
   * end-of-turn check uses POST_STOP_SETTLE_MS instead of IDLE_MS and stops
   * requiring the input prompt glyph to be visible (Stop is itself the
   * authoritative signal; the prompt-visible check was only a heuristic).
   */
  stopReceived: boolean;
  /**
   * In-flight tool count for the active turn. Bumped on PreToolUse hooks,
   * decremented on PostToolUse/PostToolUseFailure. While >0 we refuse the
   * idle-fallback end-of-turn (a long-running tool like claudegram_ask_user
   * can pause the pty for minutes with no output). Stop is still authoritative
   * — it only fires after all tools complete, so it can resolve regardless.
   */
  inflightTools: number;
  /**
   * Wall-clock time we wrote the current turn's prompt to the pty. Used by
   * the idle fallback together with the JSONL-mtime snapshot below to decide
   * whether claude has done any work for this prompt yet. Also drives the
   * NO_JSONL_FALLBACK_MS safety net for slash commands that produce no
   * JSONL records (e.g. /cost).
   */
  submitTimeMs: number;
  /**
   * Session-log mtime captured immediately before we submitted the prompt.
   * The idle fallback refuses to resolve until the current mtime exceeds
   * this value — claude flushes a record to the log for every assistant
   * message, tool call, system event, and compact_boundary, so a moving
   * mtime is a reliable "claude actually did something" signal. Replaces
   * the older bullet-count heuristic, which silently hung on /compact and
   * other slash commands that don't emit a `●` glyph.
   */
  jsonlMtimeAtSubmit: number;
  /**
   * Identity of the last user prompt in the session log at submit time. If it
   * hasn't changed by end-of-turn, claude never took delivery of our prompt —
   * a moving mtime isn't proof it did, because `--resume` alone rewrites
   * bookkeeping records (system, last-prompt) on spawn. Without this check the
   * turn resolves on that mtime bump and the JSONL read returns the *previous*
   * turn's answer, which the user sees as a fresh reply to a question the model
   * never saw.
   */
  promptMarkerAtSubmit: UserPromptMarker | undefined;
  /**
   * True when the submitted prompt was a slash command. Those can legitimately
   * finish without adding a prompt record to the log (purely-TUI ones like
   * /cost render to screen only), so the prompt-landed check above is skipped
   * for them and the NO_JSONL_FALLBACK_MS path still applies.
   */
  submittedSlashCommand: boolean;
  /**
   * True between spawning this pty with `--resume` and its first submitted
   * prompt. While set, readiness uses RESUME_SETTLE_IDLE_MS/RESUME_STARTUP_MAX_MS
   * so we wait out the transcript replay instead of pasting into it.
   */
  awaitingResumeReplay: boolean;
  /**
   * Set to true after we've scanned this pty's startup output for Claude
   * Code's update banner. The banner only renders during the first TUI draw,
   * but it lingers in the xterm scrollback for the lifetime of the pty — so
   * without a guard we'd re-detect and re-post the same notice on every
   * subsequent turn. Re-check happens on /clear (cleanupSession destroys
   * this state) or after any spawn-triggering event.
   */
  updateBannerChecked: boolean;
}

function transcriptSavingDisabled(screenText: string): boolean {
  return /transcript saving is off/i.test(screenText);
}

export class PtyProvider implements Provider {
  readonly name: ProviderName = 'claude';

  private sessions = new Map<string, PtySession>();
  /**
   * Last-known usage per sessionKey, refreshed at end-of-turn from claude's
   * on-disk JSONL log. Surfaced via getCachedUsage so the status line and
   * per-turn usage chips light up the same as SDK mode.
   */
  private usageCache = new Map<string, AgentUsage>();

  getSessionPid(sessionKey: string): number | undefined {
    return this.sessions.get(sessionKey)?.term.pid;
  }

  async sendToAgent(sessionKey: string, message: string, options?: AgentOptions): Promise<AgentResponse> {
    const commandWrapped = wrapCommandPrompt(message, options?.command);
    const { prompt: promptToSend, tempPaths } = stageImagesForPty(commandWrapped, options?.images);

    // Timestamp of the newest compaction already on disk before this turn.
    // Any compaction with a later timestamp afterward was produced by this turn
    // — a manual `/compact` or an auto-compaction that fired near the limit —
    // and we surface it to the caller (compaction renders no `●`, so it's
    // invisible to screen scraping otherwise). See _resolveCompaction below.
    const preCompact = this._readLastCompaction(sessionKey);
    const compactionBeforeMs = preCompact?.timestampMs ?? 0;

    let finalScreenText: string;
    try {
      finalScreenText = await this._runPtyTurn(sessionKey, promptToSend, options);
    } catch (err) {
      // If the user cancelled (/stop or /cancel), the pty kill in the abort
      // path was deliberate. Return a graceful "cancelled" response instead
      // of bubbling the error up to handleMessage — handleCancel already
      // showed the user a "🛑 Cancelled" banner; we just need this promise
      // to settle cleanly so subsequent queued messages can proceed.
      if (isCancelled(sessionKey)) {
        return { text: '🛑 Cancelled.', toolsUsed: [] };
      }
      throw err;
    } finally {
      // Best-effort cleanup of staged image temp files. Claude has presumably
      // already read them via the Read tool; leaving them around would just
      // accumulate cruft in /tmp.
      for (const p of tempPaths) {
        try { fs.unlinkSync(p); } catch { /* already gone */ }
      }
    }
    // Prefer the JSONL session log over screen scraping. A single turn can
    // emit multiple `●` text blocks separated by tool calls (e.g. "let me
    // check X" → Bash → "found it, here's the answer"); _extractAssistantResponse
    // only sees the last bullet because it scrapes the final screen. The JSONL
    // log has every text block as a structured record, so joining them gives
    // the user the full reply. Falls back to screen scrape if the log isn't
    // available (very rare — Stop hook fires after claude flushes records).
    // Before reading anything out of the log, prove claude actually took
    // delivery of this prompt. A pty respawned against a large session spends
    // its first seconds replaying the transcript, and the Enter that submits
    // our prompt gets swallowed while the editor is still coming up. The turn
    // resolves anyway — `--resume` rewrites bookkeeping records on spawn, so
    // the mtime gate in _checkEndOfTurn reads that as "claude did something" —
    // and the JSONL read below then returns the PREVIOUS turn's answer. The
    // user gets a stale reply to a question the model never saw, and every
    // retry repeats it. Only bail when the log demonstrably still ends on the
    // turn it ended on before we submitted; a missing log or missing baseline
    // falls through to the screen-scrape guards below.
    const turnSession = this.sessions.get(sessionKey);
    const markerNow = this._currentPromptMarker(sessionKey);
    const markerAtSubmit = turnSession?.promptMarkerAtSubmit;
    if (
      turnSession
      && !turnSession.submittedSlashCommand
      && markerNow && markerAtSubmit
      && markerNow.id === markerAtSubmit.id
    ) {
      // Distinguish the two ways the log can fail to move. If claude says it
      // isn't saving the transcript, the prompt was almost certainly answered
      // — we simply can't read it — and the cure is environmental, not a retry.
      if (transcriptSavingDisabled(finalScreenText)) {
        throw new Error(
          "Claude Code isn't saving this session's transcript, so the bot can't read its replies. It inherited a parent Claude session's environment — restart the bot from a shell that isn't inside a Claude Code session.",
        );
      }
      throw new Error(
        "Claude never received your message — the TUI was still busy (this happens on the first message after a restart, while a long session is replayed). Please send it again.",
      );
    }

    const fromJsonl = this._readAssistantResponseFromJsonl(sessionKey);

    // First-turn-in-fresh-cwd failure: claude's TUI is still rendering the
    // welcome banner when _waitForReady's ❯ check trips, our prompt+Enter
    // gets swallowed by the not-yet-receptive editor, the NO_JSONL_FALLBACK
    // timer resolves the turn after 5s, and the screen scrape returns the
    // welcome banner as if it were a reply. Refuse to do that — throw a
    // clear error so the user sees a retry-worthy failure instead of
    // "Done — full response below ↓" followed by `Welcome back Rik!`.
    if (!fromJsonl && looksLikeWelcomeBanner(finalScreenText)) {
      throw new Error(
        "Claude TUI was still on the welcome screen at end-of-turn — your message wasn't received. Please send it again.",
      );
    }

    // Prose already pushed to the chat mid-turn (an ask_user question flushes
    // its own set-up text above the buttons) would otherwise be repeated here,
    // since the JSONL read returns every text record of the turn. Strip it and
    // retire the marker — see turn-prose.ts.
    const assistantResponse = stripDeliveredPrefix(
      fromJsonl ?? this._extractAssistantResponse(finalScreenText),
      getDeliveredProse(sessionKey),
    );
    clearDeliveredProse(sessionKey);

    const usage = this._refreshUsageFromJsonl(sessionKey);

    // If Claude Code's in-flight request died this turn it appended a
    // synthetic `isApiErrorMessage:true` record to the session log. The JSONL
    // readers above already filter that record out (so `assistantResponse` and
    // `usage` reflect the last *real* assistant turn, not the zeroed
    // synthetic), but we still need to surface the failure to the caller — a
    // silent successful return would fire "✅ Done" as if the turn succeeded.
    const botSession = sessionManager.getSession(sessionKey);
    if (botSession?.claudeSessionId) {
      const apiError = readLastApiErrorFromJsonl(botSession.workingDirectory, botSession.claudeSessionId);
      if (apiError) throw new ClaudeApiError(apiError);
    }

    const nextPromptSuggestion = await this._awaitPromptSuggestion(sessionKey);

    // Did a compaction land this turn? A newer compact_boundary than the one we
    // saw at submit time means yes. `/compact` writes no assistant prose, so
    // `assistantResponse` would otherwise be the *previous* turn's reply scraped
    // back out of the JSONL — the "I get the same response again" symptom. For a
    // manual compact we replace that stale text with a real confirmation; for an
    // auto-compaction that rode along with a normal turn we keep the assistant's
    // reply and just attach the notification via `compaction`.
    const postCompact = this._readLastCompaction(sessionKey);
    const compactedThisTurn =
      !!postCompact && postCompact.timestampMs > compactionBeforeMs;
    const isManualCompact = isNativeCompactCommand(message);

    let text = assistantResponse;
    let compaction: { trigger: 'manual' | 'auto'; preTokens: number } | undefined;
    if (compactedThisTurn && postCompact) {
      compaction = { trigger: postCompact.trigger, preTokens: postCompact.preTokens };
      if (isManualCompact) {
        text = this._formatCompactionConfirmation(postCompact);
        // The confirmation text already carries the token detail; drop the
        // separate generic notification so the user gets one clean message.
        compaction = undefined;
      }
    } else if (isManualCompact) {
      // Command ran but no boundary was recorded — Claude Code skips compaction
      // when the context is already small. Say so instead of echoing stale text.
      text = 'ℹ️ Nothing to compact — the context is already small enough.';
    }

    return {
      text,
      toolsUsed: [], // PTY provider does not have tool usage information
      usage,
      ...(compaction ? { compaction } : {}),
      ...(nextPromptSuggestion ? { nextPromptSuggestion } : {}),
    };
  }

  /** Newest compaction boundary on disk for this session, if any. */
  private _readLastCompaction(sessionKey: string): CompactionInfo | undefined {
    const botSession = sessionManager.getSession(sessionKey);
    if (!botSession?.claudeSessionId) return undefined;
    return readLastCompactionFromJsonl(botSession.workingDirectory, botSession.claudeSessionId);
  }

  /** One-line manual `/compact` confirmation with the token reduction. */
  private _formatCompactionConfirmation(c: CompactionInfo): string {
    const before = fmtTokens(c.preTokens);
    // postTokens is absent on older Claude Code builds — omit the arrow then.
    return c.postTokens > 0
      ? `🗜️ Context compacted — ${before} → ${fmtTokens(c.postTokens)} tokens.`
      : `🗜️ Context compacted — was ${before} tokens.`;
  }

  /**
   * After end-of-turn extraction completes, poll the xterm buffer briefly
   * for Claude Code's ghost-text prompt suggestion. The probe showed it
   * arrives within ~500ms of the last byte; we already waited
   * POST_STOP_SETTLE_MS (200ms) before reaching here, so a single fast poll
   * with a short cap is plenty. Returns null when:
   *   - the chat hasn't opted in (we never set the env var, so claude won't
   *     have generated one)
   *   - the suggestion didn't arrive within the deadline (rate limit, growth-
   *     book gate off, API error during speculation, etc.)
   *   - the input box is showing the deterministic "Try ..." placeholder
   */
  private async _awaitPromptSuggestion(sessionKey: string): Promise<string | null> {
    if (!isSuggestionsEnabled(sessionKey)) return null;
    const session = this.sessions.get(sessionKey);
    if (!session) return null;
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      const found = scrapePromptSuggestion(session.xterm);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  }

  /**
   * Read the last assistant turn's full text from the JSONL session log.
   * Returns undefined when there's no session yet or the log hasn't been
   * written — sendToAgent falls back to screen scrape in that case.
   */
  private _readAssistantResponseFromJsonl(sessionKey: string): string | undefined {
    const botSession = sessionManager.getSession(sessionKey);
    if (!botSession?.claudeSessionId) return undefined;
    return readLastAssistantTurnText(botSession.workingDirectory, botSession.claudeSessionId);
  }

  /**
   * Tail the active session's JSONL log for the most recent usage block and
   * cache it. Falls back to undefined if claude hasn't written a usage record
   * yet (very first turn, or pre-existing session without compatible records).
   * Total cost is left at 0 — claude doesn't write pricing into the log and
   * recomputing it from pricing tables here would be brittle for first cut.
   */
  private _refreshUsageFromJsonl(sessionKey: string): AgentUsage | undefined {
    const botSession = sessionManager.getSession(sessionKey);
    if (!botSession?.claudeSessionId) return undefined;

    const snapshot = readLastUsageFromJsonl(botSession.workingDirectory, botSession.claudeSessionId);
    if (!snapshot) return undefined;

    const usage: AgentUsage = {
      inputTokens: snapshot.inputTokens,
      outputTokens: snapshot.outputTokens,
      cacheReadTokens: snapshot.cacheReadTokens,
      cacheWriteTokens: snapshot.cacheWriteTokens,
      totalCostUsd: 0,
      // PTY mode runs claude with the user's 1m-context entitlement (the banner
      // reads "Opus 4.8 (1M context) · Claude Max"). Hardcoding 1_000_000 is
      // a reasonable default — the bot's % calculation just needs *some* sane
      // denominator.
      contextWindow: 1_000_000,
      numTurns: snapshot.numTurns,
      // Report what actually served the turn. If the log has no model on it,
      // say so rather than inventing one — claude picks its own default.
      model: snapshot.model
        || userPreferences.getModel(parseSessionKey(sessionKey).chatId)
        || 'Claude Code default',
    };
    this.usageCache.set(sessionKey, usage);
    return usage;
  }

  private async _runPtyTurn(sessionKey: string, prompt: string, options?: AgentOptions): Promise<string> {
    const session = this._getOrCreateSession(sessionKey, options);

    // Bind the in-flight options to claude's session_id so hook callbacks
    // dispatched by the IPC server can find the right AgentOptions to fire.
    // onClaudeStop is the Stop hook bridge — flips stopReceived and re-arms
    // the idle timer with the shorter settle window so we don't wait the
    // full IDLE_MS if no more chunks arrive after Stop fires.
    const activeTurn: ActiveTurn = {
      sessionKey,
      options: options ?? {},
      onClaudeStop: () => {
        session.stopReceived = true;
        if (session.endOfTurnResolver) {
          if (session.idleTimer) clearTimeout(session.idleTimer);
          session.idleTimer = setTimeout(() => this._checkEndOfTurn(session), POST_STOP_SETTLE_MS);
        }
      },
      onToolStart: () => { session.inflightTools++; },
      onToolEnd: () => {
        session.inflightTools = Math.max(0, session.inflightTools - 1);
        // A tool just completed — the screen may be about to update. If the
        // idle timer was waiting, reschedule it so we don't fire while output
        // is still settling.
        if (session.endOfTurnResolver && session.idleTimer) {
          clearTimeout(session.idleTimer);
          const idleMs = session.stopReceived ? POST_STOP_SETTLE_MS : IDLE_MS;
          session.idleTimer = setTimeout(() => this._checkEndOfTurn(session), idleMs);
        }
      },
    };
    registerActiveTurn(session.claudeSessionId, activeTurn);
    // Tell the monitor relay we're in a turn so it suppresses event posts
    // for assistant text that's being delivered through the normal pipeline.
    markTurnStart(sessionKey);
    // Start clean: a turn that died before its end-of-turn strip must not
    // leave a marker behind that eats the front of the next turn's reply.
    clearDeliveredProse(sessionKey);

    // Mid-turn abort. Two stages:
    //   1. Write Esc (0x1b) into the pty — claude code's TUI shortcut for
    //      "interrupt current generation and return to prompt".
    //   2. If Esc doesn't take effect within 2s (claude v2.1.143 sometimes
    //      ignores it during certain tool-use states), kill the pty outright.
    //      The next turn will respawn with --resume to restore conversation
    //      context from the JSONL log, so the user loses at most their place
    //      in the in-memory transcript — not the conversation itself.
    const abortSignal = options?.abortController?.signal;
    let abortKillTimer: NodeJS.Timeout | null = null;
    const abortHandler = () => {
      try { session.term.write('\x1b'); } catch { /* pty already gone */ }
      abortKillTimer = setTimeout(() => {
        if (session.endOfTurnRejector) {
          console.warn('[PtyProvider] Esc did not interrupt within 2s, killing pty');
          try { session.term.kill(); } catch { /* already dead */ }
          // onExit handler will reject endOfTurnRejector and clear the map.
        }
      }, 2000);
    };
    if (abortSignal?.aborted) {
      // Pre-aborted (e.g. user hit /stop before we even started writing). Skip
      // the whole pty round-trip and return whatever's currently on screen.
      unregisterActiveTurn(session.claudeSessionId);
      return this._getScreenText(session);
    }
    abortSignal?.addEventListener('abort', abortHandler);

    try {
      // A pty spawned with --resume is still replaying the transcript; give it
      // the patience that needs rather than pasting into a busy editor.
      if (session.awaitingResumeReplay) {
        await this._waitForReady(session, RESUME_SETTLE_IDLE_MS, RESUME_STARTUP_MAX_MS);
        session.awaitingResumeReplay = false;
      } else {
        await this._waitForReady(session, IDLE_MS, STARTUP_MAX_MS);
      }
      this._maybeRelayUpdateBanner(session, sessionKey);

      // Snapshot the screen before submitting so the progress diff and the
      // end-of-turn extraction only see content produced by this turn — the
      // pty stays alive across turns to preserve conversation state, so the
      // buffer holds the cumulative history.
      session.lastScreenText = this._getScreenText(session);
      // Baseline for the idle fallback: capture both wall-clock and the
      // session-log mtime now, so _checkEndOfTurn can tell whether claude has
      // actually produced output for *this* prompt (mtime advanced) or we're
      // looking at a no-op slash command (mtime unchanged → NO_JSONL_FALLBACK_MS
      // safety net).
      session.submitTimeMs = Date.now();
      session.jsonlMtimeAtSubmit = this._currentJsonlMtimeMs(sessionKey);
      // Which turn the log ends on right now, so end-of-turn can prove our
      // prompt actually landed rather than trusting a bumped mtime.
      session.promptMarkerAtSubmit = this._currentPromptMarker(sessionKey);
      session.submittedSlashCommand = prompt.trimStart().startsWith('/');

      // Submit handling for claude's TUI input editor:
      //
      // claude v2.1.143 integrated an Nvim-style multi-line editor (the
      // status bar shows "ctrl+g to edit in Nvim"). It uses a size/timing
      // heuristic to decide whether stdin is a paste vs typing, and on a
      // freshly-spawned PTY (where claude is still mid-init when our prompt
      // arrives) that heuristic occasionally folds the trailing \r into the
      // paste buffer instead of treating it as Enter — the prompt then sits
      // in the input box unsent, the model never runs, and the welcome
      // banner is what survives end-of-turn extraction.
      //
      // Three-part defence:
      //   1. Wrap the prompt in bracketed-paste markers (xterm DECSET 2004).
      //      Claude's editor parses them and strips them, so the model sees
      //      the same payload as before, but the END marker unambiguously
      //      closes the paste — the next byte (\r) is then a real keystroke.
      //   2. Echo-verify: poll the screen until the first chars of our
      //      prompt actually appear in the input box. Confirms claude's
      //      input loop is actually consuming our bytes.
      //   3. Retry loop: if echo-verify misses (claude's input loop wasn't
      //      receptive yet — happens on first-launch of a fresh PTY when
      //      ❯ is drawn before the editor is wired up), wait a beat and
      //      write again. The needle match is content-based so a duplicate
      //      write still resolves on the first burst's bytes if they finally
      //      arrive late; otherwise the second write gets a fresh chance.
      //      The welcome-banner guard in sendToAgent is the final safety net.
      const ECHO_CAP_MS = 2_000;
      const MAX_ATTEMPTS = 3;
      const RETRY_BACKOFF_MS = 750;
      let echoed = false;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        if (attempt > 0) {
          console.warn(`[PtyProvider] echo-verify miss on attempt ${attempt}/${MAX_ATTEMPTS}, retrying write`);
          await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
        }
        session.term.write(`\x1b[200~${prompt}\x1b[201~`);
        echoed = await this._waitForPromptEcho(session, prompt, ECHO_CAP_MS);
        if (echoed) break;
      }
      session.term.write('\r');
      await this._confirmSubmitted(session, sessionKey, prompt, abortSignal);

      return await this._awaitEndOfTurn(session);
    } finally {
      if (abortKillTimer) clearTimeout(abortKillTimer);
      abortSignal?.removeEventListener('abort', abortHandler);
      unregisterActiveTurn(session.claudeSessionId);
      // Re-enable monitor-event relay; the turn pipeline is done forwarding.
      markTurnEnd(sessionKey);
    }
  }

  private _getOrCreateSession(sessionKey: string, options?: AgentOptions): PtySession {
    const requiredCwd = resolveCwd(sessionKey);
    const existing = this.sessions.get(sessionKey);
    if (existing) {
      if (existing.cwd === requiredCwd) {
        // Reuse the live pty so claude keeps prior turns in context.
        existing.onProgress = options?.onProgress;
        existing.onTip = options?.onTip;
        return existing;
      }
      // Workspace changed under us — restart cleanly.
      this._cleanupSession(sessionKey);
    }

    // Resume the prior claude session if we have one on disk for this cwd.
    // Bot restarts (or any pty teardown) wipe the live process's in-memory
    // context, but `claude --resume <id>` replays the JSONL log so claude
    // picks up exactly where the previous turn left off. The id is preserved
    // across resumes, so our IPC routing key stays stable.
    const botSession = sessionManager.getSession(sessionKey);
    const priorId = botSession?.claudeSessionId;
    const resuming = !!(priorId && claudeSessionFileExists(requiredCwd, priorId));
    const claudeSessionId = resuming ? priorId! : randomUUID();
    if (!resuming) {
      sessionManager.setClaudeSessionId(sessionKey, claudeSessionId);
    }

    const ipcPort = getIpcPort();
    const settingsJson = buildSettingsJson(ipcPort);
    const mcpConfigJson = buildMcpConfigJson(buildMcpEnv({
      TELECODER_IPC_PORT: String(ipcPort),
      TELECODER_CLAUDE_SESSION_ID: claudeSessionId,
      // Workspace root for the MCP subprocess (used by list_projects). This is
      // the top-level dev directory (`config.WORKSPACE_DIR`), NOT the current
      // project cwd — list_projects needs to enumerate sibling projects.
      TELECODER_WORKSPACE_ROOT: getWorkspaceRoot(),
    }));

    // /effort and /model are per-chat preferences the CLI accepts as flags.
    // They can only be applied at spawn, so changing either tears the pty down
    // (see handleEffort / handleModelCommand) to force a respawn — context
    // survives because the next spawn resumes the same session id.
    const { chatId } = parseSessionKey(sessionKey);
    const effort = userPreferences.getEffort(chatId);
    const model = userPreferences.getModel(chatId);

    const args = [
      '--dangerously-skip-permissions',
      ...(resuming ? ['--resume', claudeSessionId] : ['--session-id', claudeSessionId]),
      ...(effort ? ['--effort', effort] : []),
      ...(model ? ['--model', model] : []),
      // Exclude user-level settings. This keeps PTY mode predictable —
      // most importantly it drops `editorMode: "vim"` which makes \r insert
      // a newline instead of submitting (we saw prompts pile up in the
      // multi-line buffer and never reach the model). Project + local
      // settings still load, as does our injected --settings JSON below.
      '--setting-sources', 'project,local',
      '--settings', settingsJson,
      // Spawn our standalone MCP server as a stdio subprocess. Strict mode
      // scopes MCP to *only* what we pass here — the user's globally
      // configured MCP servers don't load in PTY mode.
      '--mcp-config', mcpConfigJson,
      '--strict-mcp-config',
      // Make our MCP tools discoverable to claude. Without this the tool
      // names appear in claude's deferred-tools list but claude often picks
      // WebFetch/Bash for the same task because the deferred listing has
      // no descriptions.
      '--append-system-prompt', buildMcpToolsSystemPromptNote(),
      // Hard-disable claude's built-in AskUserQuestion. The headless xterm has
      // no real user to type a response, so an AskUserQuestion call freezes
      // the turn until MAX_TURN_MS fires (~30 min). The system-prompt note
      // already steers claude toward claudegram_ask_user, but the model still
      // reaches for the built-in sometimes mid-turn — a hard deny forces it
      // to the MCP variant (or plain text).
      //
      // CronCreate / ScheduleWakeup / RemoteTrigger are also blocked: their
      // fires land outside our session (cron in PTY mode, RemoteTrigger on
      // claude.ai's servers) and never reach the Telegram chat.
      // claudegram_loop / claudegram_schedule replace them and route fires
      // through the bot. Set TELECODER_ALLOW_NATIVE_SCHEDULING=1 to keep
      // the built-ins enabled if you want to experiment.
      '--disallowedTools', legacyEnv('ALLOW_NATIVE_SCHEDULING') === '1'
        ? 'AskUserQuestion'
        : 'AskUserQuestion,CronCreate,ScheduleWakeup,RemoteTrigger',
    ];

    const term = spawn(CLAUDE_BIN, args, {
      name: 'xterm-256color',
      cols: COLS,
      rows: ROWS,
      cwd: requiredCwd,
      env: {
        ...envWithoutParentSession(),
        TERM: 'xterm-256color',
        // Belt and braces alongside the stripped markers above: whatever else
        // the bot inherited, this pty must write its session log — the bot has
        // no other way to read the model's reply.
        CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1',
        // Claude code's default MCP tool-call timeout is 60s. claudegram_ask_user
        // long-polls for up to 10 min waiting on a Telegram button tap; without
        // this override claude aborts the call at 60s, fires postToolUseFailure
        // with an empty tool_response (rendered as "(no output)" in the action
        // log), and the model gives up on the tool. 15 min covers the 10-min
        // ask-user window with margin.
        MCP_TOOL_TIMEOUT: '900000',
        // Suppress claude's "How is Claude doing this session?" feedback
        // survey. It renders as plain text in the PTY ("1: Bad  2: Fine ..."),
        // which has no clickable buttons in Telegram and just clutters the
        // chat — there's no real user at a TUI to respond.
        CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
        // Enable Claude Code's speculative next-prompt feature when the chat
        // has opted in. Suggestion is rendered as ghost text in the input box;
        // the scraper picks it up at end-of-turn (see prompt-suggestion-scraper).
        // Spawn-time only — toggling /suggestions mid-session has no effect
        // until the PTY is respawned.
        ...(isSuggestionsEnabled(sessionKey) ? { CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: '1' } : {}),
      },
    });

    const xterm = new Terminal({
      cols: COLS,
      rows: ROWS,
      scrollback: 1000,
      allowProposedApi: true,
    });

    const session: PtySession = {
      term,
      xterm,
      cwd: requiredCwd,
      claudeSessionId,
      lastChunkAt: Date.now(),
      endOfTurnResolver: null,
      endOfTurnRejector: null,
      idleTimer: null,
      hardTimer: null,
      onProgress: options?.onProgress,
      onTip: options?.onTip,
      lastTip: null,
      lastScreenText: '',
      stopReceived: false,
      inflightTools: 0,
      submitTimeMs: 0,
      jsonlMtimeAtSubmit: 0,
      promptMarkerAtSubmit: undefined,
      submittedSlashCommand: false,
      awaitingResumeReplay: resuming,
      updateBannerChecked: false,
    };

    term.onData((chunk: string) => this._onData(session, chunk));

    term.onExit(({ exitCode, signal }) => {
      if (session.endOfTurnRejector) {
        session.endOfTurnRejector(new Error(`claude exited (code=${exitCode}, signal=${signal}) mid-turn`));
      }
      // Identity check: /clear or a workspace switch synchronously kills
      // this term, removes us from the map, and may immediately spawn a
      // replacement at the same sessionKey. By the time *this* late onExit
      // fires, the replacement is the live session — don't wipe it out.
      if (this.sessions.get(sessionKey) === session) {
        this.sessions.delete(sessionKey);
      }
    });

    this.sessions.set(sessionKey, session);
    return session;
  }

  private _onData(session: PtySession, chunk: string) {
    session.lastChunkAt = Date.now();
    session.xterm.write(chunk);

    if (session.onProgress) {
        const newScreenText = this._getScreenText(session);
        if(newScreenText.length > session.lastScreenText.length) {
            const diff = newScreenText.substring(session.lastScreenText.length);
            // We only care about assistant output, not user prompts or UI elements
            const cleanDiff = diff.replace(/^●\s*/, '').replace('❯', '').trim();
            if(cleanDiff.length > 0) {
                 session.onProgress(cleanDiff);
            }
        }
        session.lastScreenText = newScreenText;
    }

    // Mirror Claude Code's live spinner tip into the Telegram status line.
    // The tip is drawn in place at the bottom of the TUI, so it doesn't reach
    // the append-only onProgress diff above — scrape it directly and only fire
    // when it actually changes (including when it clears to null).
    if (session.onTip) {
      const tip = scrapeTip(session.xterm);
      if (tip !== session.lastTip) {
        session.lastTip = tip;
        session.onTip(tip);
      }
    }

    if (session.endOfTurnResolver) {
      if (session.idleTimer) clearTimeout(session.idleTimer);
      const idleMs = session.stopReceived ? POST_STOP_SETTLE_MS : IDLE_MS;
      session.idleTimer = setTimeout(() => this._checkEndOfTurn(session), idleMs);
    }
  }

  private _checkEndOfTurn(session: PtySession) {
    if (!session.endOfTurnResolver) return;

    const idleMs = session.stopReceived ? POST_STOP_SETTLE_MS : IDLE_MS;
    const sinceLast = Date.now() - session.lastChunkAt;
    const isIdle = sinceLast >= idleMs;

    // A tool is still pending (e.g. claudegram_ask_user long-polling for a
    // user button tap, or claude's own AskUserQuestion dialog waiting on the
    // TUI). The pty is silent by design — don't mistake that for end-of-turn.
    // Stop only fires *after* all tools complete, so even the post-Stop path
    // is safe to gate on this.
    if (session.inflightTools > 0) {
      session.idleTimer = setTimeout(() => this._checkEndOfTurn(session), idleMs);
      return;
    }

    // Stop hook fired → Stop itself is the authoritative end-of-turn signal,
    // we just wait for a brief settle. Otherwise fall back to the idle path:
    // pty quiet for IDLE_MS, the input prompt is back on screen, AND claude
    // has either written something to the JSONL log since we submitted
    // (model turns, /compact, /handoff, /clear all do) or we've waited
    // NO_JSONL_FALLBACK_MS to cover purely-TUI slash commands like /cost.
    // The JSONL-mtime gate replaces an older bullet-count check that hung
    // indefinitely on /compact because compaction renders no `●` glyph.
    const jsonlMtime = this._lookupJsonlMtime(session);
    const sawJsonlActivity = jsonlMtime > session.jsonlMtimeAtSubmit;
    const sinceSubmit = Date.now() - session.submitTimeMs;
    const claudeProducedSomething = sawJsonlActivity || sinceSubmit >= NO_JSONL_FALLBACK_MS;
    const canResolve = session.stopReceived
      ? isIdle
      : isIdle && this._isPromptVisible(session) && claudeProducedSomething;

    if (canResolve) {
      const resolved = session.endOfTurnResolver;
      session.endOfTurnResolver = null;
      session.endOfTurnRejector = null;
      if (session.hardTimer) clearTimeout(session.hardTimer);
      resolved(this._getScreenText(session));
    } else {
      // If we're only waiting on NO_JSONL_FALLBACK_MS, re-arm just past the
      // deadline so a no-op slash command doesn't sit on an idle timer that
      // only re-fires when the pty produces another chunk.
      const idleRemaining = Math.max(50, idleMs - sinceLast);
      const fallbackRemaining = claudeProducedSomething
        ? Infinity
        : Math.max(50, NO_JSONL_FALLBACK_MS - sinceSubmit);
      const wait = Math.min(idleRemaining, fallbackRemaining);
      session.idleTimer = setTimeout(() => this._checkEndOfTurn(session), wait);
    }
  }

  /** Identity of the last user prompt in the active session's log, if any. */
  private _currentPromptMarker(sessionKey: string): UserPromptMarker | undefined {
    const botSession = sessionManager.getSession(sessionKey);
    if (!botSession?.claudeSessionId) return undefined;
    return readLastUserPromptMarker(botSession.workingDirectory, botSession.claudeSessionId);
  }

  /** Cheap fs.stat on the active session's JSONL log; 0 if not on disk yet. */
  private _currentJsonlMtimeMs(sessionKey: string): number {
    const botSession = sessionManager.getSession(sessionKey);
    if (!botSession?.claudeSessionId) return 0;
    return sessionJsonlMtimeMs(botSession.workingDirectory, botSession.claudeSessionId);
  }

  private _lookupJsonlMtime(session: PtySession): number {
    return sessionJsonlMtimeMs(session.cwd, session.claudeSessionId);
  }

  private _isPromptVisible(session: PtySession): boolean {
    // ❯ appears in claude's input box. We use includes() rather than
    // startsWith() because the box-drawing chrome wraps the line as
    // `│ ❯ <typed text> │`, which trims to a string that doesn't *start*
    // with ❯. claude's own assistant output uses ● for bullets, not ❯,
    // so false positives are unlikely.
    return this._getScreenText(session).includes('❯');
  }

  private _awaitEndOfTurn(session: PtySession): Promise<string> {
    return new Promise((resolve, reject) => {
      // Intentionally NOT resetting xterm / lastScreenText: the pty is shared
      // across turns, and _runPtyTurn snapshotted lastScreenText right before
      // writing the prompt so the diff & extraction logic see only new content.
      // stopReceived MUST be reset — it's per-turn state and the previous turn
      // left it true. inflightTools should already be 0 at end-of-turn but
      // reset defensively in case a Pre→Post pair was skipped (e.g. claude
      // killed mid-tool).
      session.stopReceived = false;
      session.inflightTools = 0;
      // Each turn gets a fresh Telegram status message (StreamState.tip starts
      // null), so clear lastTip to force a re-push of the current tip.
      session.lastTip = null;
      session.endOfTurnResolver = resolve;
      session.endOfTurnRejector = reject;
      session.idleTimer = setTimeout(() => this._checkEndOfTurn(session), IDLE_MS);
      session.hardTimer = setTimeout(() => {
        if (session.endOfTurnRejector) {
          const r = session.endOfTurnRejector;
          session.endOfTurnResolver = null;
          session.endOfTurnRejector = null;
          r(new Error(`turn exceeded ${MAX_TURN_MS}ms`));
        }
      }, MAX_TURN_MS);
    });
  }

  /**
   * Wait until claude is actually ready to receive a prompt: stdout has been
   * idle for `idleMs` AND the input prompt glyph is visible on the rendered
   * screen. Stdout-idle alone is unsafe — claude's startup pauses (plugin
   * loading, settings parse) can exceed idleMs before the input box is drawn,
   * so a prompt written then gets silently consumed by the startup flow.
   * Caps at `capMs` so we never hang forever; logs a warning if the cap is
   * hit and proceeds anyway (better than freezing the bot).
   */
  private async _waitForReady(session: PtySession, idleMs: number, capMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < capMs) {
      const since = Date.now() - session.lastChunkAt;
      if (since >= idleMs && this._isPromptVisible(session)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    console.warn(`[PtyProvider] _waitForReady cap reached (${capMs}ms) without confirmed input prompt; proceeding anyway`);
  }

  /**
   * Wait for evidence that claude took delivery of the prompt: a user record
   * appearing in the session log. While it hasn't, and our text is still
   * visible in the input box, re-send \r every SUBMIT_RETRY_EVERY_MS — the
   * editor swallows the keystroke silently when it's busy (transcript replay,
   * late startup), and nothing downstream can tell that from a slow model.
   *
   * The log read is gated on the log's mtime so a large transcript isn't
   * re-parsed on every poll. Returns true once the prompt lands; false on
   * cap-hit, where the end-of-turn guard in sendToAgent reports the failure.
   * Slash commands skip the whole thing — they needn't write a record at all,
   * and blind \r retries would be the only outcome.
   */
  private async _confirmSubmitted(
    session: PtySession,
    sessionKey: string,
    prompt: string,
    abortSignal?: AbortSignal,
  ): Promise<boolean> {
    if (session.submittedSlashCommand) return true;

    const baselineId = session.promptMarkerAtSubmit?.id;
    const deadline = Date.now() + SUBMIT_CONFIRM_CAP_MS;
    let seenMtime = session.jsonlMtimeAtSubmit;
    let lastRetryAt = Date.now();

    while (Date.now() < deadline) {
      // Stop waiting the moment the turn is cancelled or the pty dies —
      // _awaitEndOfTurn handles both, and retrying \r into a dead term or a
      // cancelled turn is pointless.
      if (abortSignal?.aborted) return false;
      if (this.sessions.get(sessionKey) !== session) return false;
      const mtime = this._currentJsonlMtimeMs(sessionKey);
      if (mtime !== seenMtime) {
        seenMtime = mtime;
        const markerNow = this._currentPromptMarker(sessionKey);
        if (markerNow && markerNow.id !== baselineId) return true;
      }
      if (Date.now() - lastRetryAt >= SUBMIT_RETRY_EVERY_MS) {
        lastRetryAt = Date.now();
        // With persistence off the log will never confirm anything, so retrying
        // just fires Enter into a session that already took the prompt. Stop
        // and let the end-of-turn guard name the real problem.
        if (transcriptSavingDisabled(this._getScreenText(session))) {
          console.warn('[PtyProvider] transcript saving is off — cannot confirm submission from the log');
          return false;
        }
        if (this._screenHasPromptText(session, prompt)) {
          console.warn('[PtyProvider] prompt still in the input box after Enter — re-sending submit');
          session.term.write('\r');
        }
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    console.warn(`[PtyProvider] prompt not confirmed submitted within ${Math.round(SUBMIT_CONFIRM_CAP_MS / 1000)}s`);
    return false;
  }

  /** True if the prompt's distinctive opening is still on the rendered screen. */
  private _screenHasPromptText(session: PtySession, prompt: string): boolean {
    const needle = promptNeedle(prompt);
    // Too short to match reliably — assume it's still pending and let the
    // caller re-send; a stray Enter on an empty input box is a no-op.
    if (!needle) return true;
    return this._getScreenText(session).includes(needle);
  }

  /**
   * Poll the xterm buffer until the first chars of `prompt` appear on screen —
   * proves claude's editor actually consumed our paste before we send \r.
   * Returns true on echo confirmed, false on cap-hit. Caller retries the
   * write on false; the welcome-banner guard in sendToAgent is the final
   * safety net if every retry misses.
   *
   * Needle is the leading non-whitespace slice of the first line — short
   * enough to survive line wrapping in the 120-col input box, long enough
   * to be distinctive. Returns true immediately when the needle would be
   * too short to be a meaningful match (very short prompts can race the
   * \r submit, but they also rarely fall victim to the paste heuristic so
   * the retry loop isn't load-bearing for them).
   */
  private async _waitForPromptEcho(session: PtySession, prompt: string, capMs: number): Promise<boolean> {
    const needle = promptNeedle(prompt);
    if (!needle) {
      await new Promise((r) => setTimeout(r, 100));
      return true;
    }
    const deadline = Date.now() + capMs;
    while (Date.now() < deadline) {
      if (this._getScreenText(session).includes(needle)) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  }

  /**
   * After the first _waitForReady of this pty's lifetime, scan the rendered
   * screen for claude's "Update available" / "Successfully updated" banner
   * and relay it to Telegram. Guarded so we only fire once per pty spawn —
   * the banner sits in the xterm scrollback indefinitely otherwise.
   */
  private _maybeRelayUpdateBanner(session: PtySession, sessionKey: string): void {
    if (session.updateBannerChecked) return;
    session.updateBannerChecked = true;
    const banner = scrapeUpdateBanner(this._getScreenText(session));
    if (!banner) return;
    relayUpdateBanner(sessionKey, banner).catch((err) => {
      console.error('[PtyProvider] relay update banner failed:', err instanceof Error ? err.message : err);
    });
  }

  private _getScreenText(session: PtySession): string {
    const buffer = session.xterm.buffer.active;
    let text = '';
    for (let i = 0; i < buffer.length; i++) {
      text += buffer.getLine(i)?.translateToString(true) + '\n';
    }
    return text.replace(/\n+$/, ''); // Trim trailing newlines
  }

  private _extractAssistantResponse(screenText: string): string {
    const lines = screenText.split('\n');
    const lastAssistantLine = lines.map((line, i) => [line, i] as const).filter(([line]) => line.includes('●')).pop();
    if (!lastAssistantLine) {
      const promptIndex = lines.findIndex(line => line.includes('❯'));
      if (promptIndex > 0) return lines.slice(0, promptIndex).join('\n').trim();
      return screenText.trim();
    }

    const responseLines = lines.slice(lastAssistantLine[1]);
    const stopIndex = responseLines.findIndex((line, i) => i > 0 && this._isChromeLine(line));
    const contentLines = stopIndex !== -1 ? responseLines.slice(0, stopIndex) : responseLines;

    return contentLines
      .map(line => line.replace(/^●\s*/, ''))
      .join('\n')
      .trim();
  }

  // A line is considered TUI chrome (footer, input box, separator, prompt) and
  // marks the end of the assistant's response region.
  private _isChromeLine(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith('✻')) return true;                  // "Brewed for Xs" timer
    if (/^[╭╰╮╯]/.test(trimmed)) return true;                  // input-box corners
    if (/^│\s/.test(trimmed) || trimmed.includes('❯')) return true; // input box body / prompt glyph
    if (/^[─━═]{3,}$/.test(trimmed)) return true;              // horizontal separators
    return false;
  }

  private _cleanupSession(sessionKey: string) {
    const session = this.sessions.get(sessionKey);
    if(session) {
      try {
        session.term.kill();
      } catch (e) {
        // ignore
      }
      if(session.idleTimer) clearTimeout(session.idleTimer);
      if(session.hardTimer) clearTimeout(session.hardTimer);
      this.sessions.delete(sessionKey);
    }
    // Stop any monitor relay tied to this session — the JSONL it was watching
    // belongs to a now-dead claudeSessionId; the next session gets a new one.
    teardownMonitorRelay(sessionKey);
  }

  async sendLoopToAgent(sessionKey: string, message: string, options: LoopOptions = {}): Promise<AgentResponse> {
    const {
      onProgress,
      abortController,
      maxIterations = config.MAX_LOOP_ITERATIONS,
      onIterationComplete,
    } = options;

    if (!sessionManager.getSession(sessionKey)) {
      throw new Error('No active session. Use /project to set working directory.');
    }

    // Wrap only the first prompt with the DONE convention. Continuation turns
    // reuse the live pty so conversation context is already in claude's memory.
    const loopPrompt = `${message}\n\nIMPORTANT: When you have fully completed this task, respond with the word "DONE" on its own line at the end of your response. If you need to continue working, do not say "DONE".`;

    let iteration = 0;
    let combinedText = '';
    const allToolsUsed: string[] = [];
    let isComplete = false;

    while (iteration < maxIterations && !isComplete) {
      iteration++;

      if (abortController?.signal.aborted) {
        return { text: combinedText + '\n\n🛑 Loop cancelled.', toolsUsed: allToolsUsed };
      }

      const iterationPrefix = `\n\n--- Iteration ${iteration}/${maxIterations} ---\n\n`;
      combinedText += iterationPrefix;
      onProgress?.(combinedText);

      const currentPrompt = iteration === 1 ? loopPrompt : 'Continue the task. Say "DONE" when complete.';

      try {
        const response = await this.sendToAgent(sessionKey, currentPrompt, {
          ...options,
          onProgress: (text) => onProgress?.(combinedText + text),
        });

        combinedText += response.text;
        allToolsUsed.push(...response.toolsUsed);
        onIterationComplete?.(iteration, response.text);

        if (response.text.includes('DONE')) {
          isComplete = true;
          combinedText += '\n\n✅ Loop completed.';
        } else if (iteration >= maxIterations) {
          combinedText += `\n\n⚠️ Max iterations (${maxIterations}) reached.`;
        }

        onProgress?.(combinedText);
      } catch (error) {
        if (abortController?.signal.aborted) {
          return { text: combinedText + '\n\n🛑 Loop cancelled.', toolsUsed: allToolsUsed };
        }
        throw error;
      }
    }

    return { text: combinedText, toolsUsed: allToolsUsed };
  }

  clearConversation(sessionKey: string): void {
    this._cleanupSession(sessionKey);
    this.usageCache.delete(sessionKey);
    console.log(`[PtyProvider] Cleared conversation for session ${sessionKey}`);
  }

  setModel(chatId: number, model: string): void {
    // Applied as `--model` on the next spawn; the caller tears the pty down so
    // that happens on the next turn rather than whenever the session restarts.
    userPreferences.setModel(chatId, model);
  }

  /**
   * The model actually serving this chat, read from the last usage record in
   * the session log. Falls back to the pending preference (set but not yet
   * spawned), then to an honest placeholder — claude picks its own default and
   * we genuinely don't know which until a turn has been written.
   */
  getModel(chatId: number): string {
    const cached = this._findUsageForChat(chatId);
    if (cached?.model) return cached.model;
    return userPreferences.getModel(chatId) ?? 'Claude Code default';
  }

  clearModel(chatId: number): void {
    userPreferences.clearModel(chatId);
  }

  /**
   * usageCache is keyed by session key (chat, or chat:thread for forum topics)
   * but the Provider model API only gets a chat id — so match the plain chat
   * key first, then any thread under it.
   */
  private _findUsageForChat(chatId: number): AgentUsage | undefined {
    const direct = this.usageCache.get(String(chatId));
    if (direct) return direct;
    const prefix = `${chatId}:`;
    for (const [key, usage] of this.usageCache) {
      if (key.startsWith(prefix)) return usage;
    }
    return undefined;
  }

  getCachedUsage(sessionKey: string): AgentUsage | undefined {
    return this.usageCache.get(sessionKey);
  }

  isDangerousMode(): boolean {
    return true;
  }

  async getAvailableModels(chatId: number): Promise<ModelInfo[]> {
    // The same aliases the CLI accepts for --model. Matches SDK mode's list so
    // /model offers the same choices whichever method the chat is on.
    return Promise.resolve([
      { id: 'opus', label: 'opus', description: 'Most capable (default)' },
      { id: 'sonnet', label: 'sonnet', description: 'Balanced' },
      { id: 'haiku', label: 'haiku', description: 'Fast & light' },
    ]);
  }
}

// ---- Hook → AgentOptions callback bridge ------------------------------------
//
// The handlers below run inside the IPC server when claude-spawned hook curls
// reach us. They translate hook payloads into the SDK-shaped callbacks the bot
// already implements (onToolStart / onToolEnd / onToolResult / onEditDiff), so
// PTY mode lights up the same verbose UI as SDK mode.
//
// Callbacks are fire-and-forget — the hook command blocks claude until the
// HTTP POST returns, so we ack fast and let the bot's Telegram calls run on
// their own microtasks. Errors are logged, never rethrown into claude.

/**
 * Map an ImageAttachment mediaType to a sensible file extension. Falls back
 * to `.bin` for unknowns — claude code's Read tool sniffs content anyway, the
 * extension is mostly cosmetic.
 */
function imageExtension(mediaType: string): string {
  if (mediaType === 'image/jpeg') return 'jpg';
  if (mediaType === 'image/png') return 'png';
  if (mediaType === 'image/gif') return 'gif';
  if (mediaType === 'image/webp') return 'webp';
  return 'bin';
}

/**
 * Write the user's image attachments to /tmp and inject their paths into the
 * prompt. Claude's Read tool natively supports image files and surfaces them
 * to the model as image content blocks, so this gets us SDK-mode equivalent
 * image semantics without needing to deal with pty paste protocols.
 *
 * Returns the augmented prompt plus the list of temp paths the caller is
 * responsible for deleting after the turn ends.
 */
function stageImagesForPty(prompt: string, images?: ImageAttachment[]): { prompt: string; tempPaths: string[] } {
  if (!images || images.length === 0) return { prompt, tempPaths: [] };

  const tempPaths: string[] = [];
  for (const img of images) {
    const ext = imageExtension(img.mediaType);
    const filePath = path.join('/tmp', `telecoder-img-${randomUUID()}.${ext}`);
    fs.writeFileSync(filePath, Buffer.from(img.data, 'base64'));
    tempPaths.push(filePath);
  }

  const imageList = tempPaths.map((p, i) => `  ${i + 1}. ${p}`).join('\n');
  const augmented = `${prompt}

The user attached ${tempPaths.length === 1 ? 'an image' : `${tempPaths.length} images`} at:
${imageList}

Read ${tempPaths.length === 1 ? 'it' : 'them'} with the Read tool to see ${tempPaths.length === 1 ? 'its' : 'their'} contents.`;

  return { prompt: augmented, tempPaths };
}

/**
 * Apply per-command prompt wrapping so /plan and /explore behave the same in
 * PTY mode as in SDK mode. SDK does this differently:
 *   - explore: prepends "Explore the codebase and answer: " to the prompt
 *   - plan:   sets the SDK permissionMode to 'plan' (claude code then enforces
 *             read-only tool access)
 * In PTY mode we spawn with --dangerously-skip-permissions, so we can't flip
 * permission mode mid-run. Instead, plan mode is steered by a strong prompt
 * directive — claude will follow it on subscription-side too, matching the
 * SDK-mode user experience for the common case.
 */
/**
 * True if the xterm buffer is still showing Claude Code's first-launch welcome
 * screen. The two greeting strings only render together at startup — after any
 * prompt submits and the model produces output, they scroll out of the visible
 * buffer. Used by sendToAgent to detect the "prompt swallowed during TUI
 * startup" failure mode and throw instead of returning the banner as a reply.
 */
function looksLikeWelcomeBanner(screenText: string): boolean {
  return screenText.includes('Welcome back') && screenText.includes('Tips for getting started');
}

function wrapCommandPrompt(message: string, command: AgentOptions['command']): string {
  if (command === 'explore') {
    return `Explore the codebase and answer: ${message}`;
  }
  if (command === 'plan') {
    return `═══ PLAN MODE — STRICT ═══

You are in plan mode. Your only job this turn is to produce an implementation plan. Read the codebase, understand the task, and output a numbered plan.

PROHIBITED THIS TURN (treat as if these tools are disabled):
  • Edit, Write, NotebookEdit — no file changes of any kind
  • Bash commands that mutate state (no rm, mv, cp, mkdir, npm install, git commit, git push, etc.)
  • Any side-effecting MCP tool (no send_file, no extract_media, no telegraph publishing)
  • Do not run a build, do not run tests
  • Do not "just fix one quick thing while you're there"

ALLOWED:
  • Read, Grep, Glob — read-only file inspection
  • Bash for strictly read-only commands (ls, cat, grep, git log, git diff, git status, wc)
  • claudegram_list_projects, claudegram_ask_user — read-only or interactive-only

If you find yourself about to call a prohibited tool, STOP and put the action into the plan instead. The user will review the plan and explicitly ask you to execute in a follow-up message.

Output format: numbered steps, one per change you'd make. End with an "Out of scope" list of things you're deliberately not touching.

═══ TASK ═══

${message}`;
  }
  return message;
}

function fireAndForget(label: string, fn: (() => Promise<unknown> | unknown) | undefined): void {
  if (!fn) return;
  void Promise.resolve()
    .then(() => fn())
    .catch(err => console.error(`[PTY hook] ${label} threw:`, err));
}

/**
 * Pick the model-facing string out of a hook payload's `tool_response`.
 *
 * SDK mode delivers tool results as the *serialized* form the model sees
 * (Read → just the file content, Bash → stdout+stderr text). Hook payloads
 * instead give us claude's internal structured object:
 *   Read → { type: 'text', file: { filePath, content } }
 *   Bash → { stdout, stderr, exit_code, … }
 *
 * We unwrap the common shapes so PTY mode renders tool results the same way
 * SDK mode does. Unknown shapes fall back to a JSON dump — better than
 * nothing for diagnostics, even if it's ugly.
 */
/**
 * Join an MCP-style content array (`[{type:'text',text:'...'}, ...]`) into a
 * plain string. Returns `null` if the input isn't a recognizable MCP content
 * array, so callers can fall through to other shapes.
 */
function joinMcpContentArray(arr: unknown[]): string | null {
  const texts: string[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') return null;
    const o = item as Record<string, unknown>;
    if (typeof o.text === 'string') texts.push(o.text);
  }
  return texts.length ? texts.join('\n') : null;
}

function extractToolResponseContent(toolResponse: unknown): string {
  if (toolResponse == null) return '';
  if (typeof toolResponse === 'string') return toolResponse;

  // MCP tool result shapes: claude delivers MCP tool_response either as the
  // raw content array `[{type:'text', text:'...'}]` or as the wrapped form
  // `{content: [...], isError?: bool}`. Both should render as plain text in
  // the action log, not as JSON.
  if (Array.isArray(toolResponse)) {
    const joined = joinMcpContentArray(toolResponse);
    if (joined !== null) return joined;
  }

  if (typeof toolResponse !== 'object') return String(toolResponse);

  const obj = toolResponse as Record<string, unknown>;

  if (Array.isArray(obj.content)) {
    const joined = joinMcpContentArray(obj.content);
    if (joined !== null) return joined;
  }

  // Read → unwrap file.content
  if (obj.file && typeof obj.file === 'object') {
    const file = obj.file as Record<string, unknown>;
    if (typeof file.content === 'string') return file.content;
  }

  // Bash → combine stdout + stderr (matches what the model sees)
  if ('stdout' in obj || 'stderr' in obj) {
    const parts: string[] = [];
    if (typeof obj.stdout === 'string' && obj.stdout) parts.push(obj.stdout);
    if (typeof obj.stderr === 'string' && obj.stderr) parts.push(obj.stderr);
    return parts.join('\n').trim();
  }

  // Common single-field shapes
  for (const key of ['content', 'result', 'output', 'text'] as const) {
    if (typeof obj[key] === 'string') return obj[key] as string;
  }

  // Unknown shape — JSON-dump as a last resort so something shows up
  try { return JSON.stringify(obj); }
  catch { return String(obj); }
}

registerIpcHandler('/hook/preToolUse', async (turn, body) => {
  const toolName = String(body.tool_name ?? 'unknown');
  const toolInput = (body.tool_input ?? {}) as Record<string, unknown>;
  turn.onToolStart?.();
  fireAndForget('onToolStart', () => turn.options.onToolStart?.(toolName, toolInput));

  // Arm the relay so any task-notifications that fire AFTER this turn ends
  // still get routed to Telegram. Three async tool families need this:
  //   - Monitor (continuous event stream)
  //   - Bash with run_in_background=true (single completion notification)
  //   - Task/Agent (subagent — completion notification)
  // Each is backgrounded: PostToolUse fires almost immediately, the user-turn
  // returns, and the actual outcome arrives later as a task-notification.
  const asyncKind: AsyncToolKind | null =
    toolName === 'Monitor' ? 'monitor' :
    (toolName === 'Bash' && toolInput.run_in_background === true) ? 'bash_background' :
    isSubagentTool(toolName) ? 'subagent' :
    null;
  if (asyncKind) {
    const session = sessionManager.getSession(turn.sessionKey);
    const description = String(
      toolInput.description ??
      toolInput.target ??
      toolInput.file_path ??
      toolInput.path ??
      toolInput.command ??
      toolInput.prompt ??
      asyncKind,
    );
    const toolUseId = typeof body.tool_use_id === 'string' ? body.tool_use_id : undefined;
    if (session?.claudeSessionId) {
      onAsyncToolArmed(asyncKind, turn.sessionKey, session.workingDirectory, session.claudeSessionId, description, toolUseId);
    }
  }

  // PushNotification: claude's "ping the user" tool. The native impl fires
  // an OS-level notification on the bot host (no real user there); for us
  // Telegram is the notification surface, so we relay the message text.
  if (toolName === 'PushNotification') {
    const message = String(toolInput.message ?? '').trim();
    if (message) relayPushNotification(turn.sessionKey, message);
  }

  // Permission gate: opt-in via TELECODER_PERMISSION_PROMPTS=1. For tools
  // matching a dangerous pattern, blocks the call and waits for Telegram
  // approval. Decision returned as a deny-marker string the shell wrapper
  // parses to exit 2 (claude code's "block this tool" signal).
  if (isPermissionGateEnabled()) {
    const ctx = (turn.options as { telegramCtx?: Context }).telegramCtx;
    const decision = await evaluateToolCall({
      sessionKey: turn.sessionKey,
      toolName,
      toolInput,
      telegramCtx: ctx,
    });
    if (decision.block) {
      // Bump the inflight counter back down — the tool isn't actually going
      // to run, so PostToolUse won't fire and inflightTools would otherwise
      // stay stuck high.
      turn.onToolEnd?.();
      return `${DENY_MARKER_START}${decision.reason}${DENY_MARKER_END}`;
    }
  }

  return { ok: true };
});

registerIpcHandler('/hook/postToolUse', (turn, body) => {
  const toolName = String(body.tool_name ?? 'unknown');
  const toolInput = (body.tool_input ?? {}) as Record<string, unknown>;
  const toolUseId = String(body.tool_use_id ?? '');

  turn.onToolEnd?.();
  fireAndForget('onToolEnd', () => turn.options.onToolEnd?.());

  if (toolName === 'Edit' || toolName === 'Write') {
    // Successful Edit/Write — surface the diff so the bot shows before/after.
    const event: EditDiffEvent = {
      toolUseId,
      toolName,
      filePath: String(toolInput.file_path ?? ''),
      oldString: toolName === 'Edit' ? String(toolInput.old_string ?? '') : undefined,
      newString: toolName === 'Edit'
        ? String(toolInput.new_string ?? '')
        : String(toolInput.content ?? ''),
    };
    fireAndForget('onEditDiff', () => turn.options.onEditDiff?.(event));
  } else {
    const event: ToolResultEvent = {
      toolUseId,
      toolName,
      input: toolInput,
      content: extractToolResponseContent(body.tool_response),
      isError: false,
    };
    fireAndForget('onToolResult', () => turn.options.onToolResult?.(event));
  }
  return { ok: true };
});

registerIpcHandler('/hook/postToolUseFailure', (turn, body) => {
  const toolName = String(body.tool_name ?? 'unknown');
  const toolInput = (body.tool_input ?? {}) as Record<string, unknown>;
  const toolUseId = String(body.tool_use_id ?? '');

  turn.onToolEnd?.();
  fireAndForget('onToolEnd', () => turn.options.onToolEnd?.());
  const event: ToolResultEvent = {
    toolUseId,
    toolName,
    input: toolInput,
    content: extractToolResponseContent(body.tool_response),
    isError: true,
  };
  fireAndForget('onToolResult', () => turn.options.onToolResult?.(event));
  return { ok: true };
});

// Stop fires when claude finishes responding. PtyProvider's onClaudeStop sets
// stopReceived on the live pty session so end-of-turn detection switches to
// the short settle window and stops requiring the input prompt to be visible.
registerIpcHandler('/hook/stop', (turn) => {
  turn.onClaudeStop?.();
  return { ok: true };
});
