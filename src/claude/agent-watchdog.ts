/**
 * Agent watchdog that monitors the SDK message loop for unresponsive behavior.
 * Logs warnings when no messages are received for extended periods.
 *
 * Tracks two types of activity:
 * - Any activity: all SDK messages (for true silence detection)
 * - Meaningful activity: only progress-indicating messages like assistant responses,
 *   tool completions, and system events (for stale tool detection)
 *
 * The stale tool timeout fires when heartbeat messages (tool_progress, stream_event)
 * keep arriving but no meaningful progress is made — indicating a tool is stuck.
 */

import { formatDuration } from '../utils/agent-timer.js';

/** Message types that indicate real progress (not just heartbeats). */
const MEANINGFUL_MESSAGE_TYPES = new Set([
  'assistant',
  'system',
  'tool_use_summary',
  'result',
  'auth_status',
]);

export interface WatchdogOptions {
  chatId: string;
  warnAfterSeconds: number;
  logIntervalSeconds: number;
  timeoutMs?: number; // 0 or undefined = no hard timeout
  silenceTimeoutMs?: number; // 0 or undefined = no silence timeout
  staleToolTimeoutMs?: number; // 0 or undefined = no stale tool timeout
  onWarning?: (sinceLastMessageMs: number, totalElapsedMs: number) => void;
  onTimeout?: () => void;
  onSilenceTimeout?: () => void;
  onStaleToolTimeout?: () => void;
  /**
   * Optional callback that returns true while the query is legitimately
   * waiting on an external user action (e.g. an inline-keyboard tap from
   * claudegram_ask_user). When true, all timeout checks are skipped and the
   * activity timestamps are kept fresh so the watchdog doesn't fire the
   * moment the wait ends.
   */
  shouldPauseTimeouts?: () => boolean;
}

export class AgentWatchdog {
  private chatId: string;
  private warnAfterMs: number;
  private logIntervalMs: number;
  private timeoutMs: number;
  private silenceTimeoutMs: number;
  private staleToolTimeoutMs: number;
  private onWarning?: (sinceLastMessageMs: number, totalElapsedMs: number) => void;
  private onTimeout?: () => void;
  private onSilenceTimeout?: () => void;
  private onStaleToolTimeout?: () => void;
  private shouldPauseTimeouts?: () => boolean;

  private startTime: number = 0;
  private lastActivityTime: number = 0;
  private lastMeaningfulActivityTime: number = 0;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private hasWarned: boolean = false;
  private stopped: boolean = false;

  constructor(options: WatchdogOptions) {
    this.chatId = options.chatId;
    this.warnAfterMs = options.warnAfterSeconds * 1000;
    this.logIntervalMs = options.logIntervalSeconds * 1000;
    this.timeoutMs = options.timeoutMs || 0;
    this.silenceTimeoutMs = options.silenceTimeoutMs || 0;
    this.staleToolTimeoutMs = options.staleToolTimeoutMs || 0;
    this.onWarning = options.onWarning;
    this.onTimeout = options.onTimeout;
    this.onSilenceTimeout = options.onSilenceTimeout;
    this.onStaleToolTimeout = options.onStaleToolTimeout;
    this.shouldPauseTimeouts = options.shouldPauseTimeouts;
  }

  /**
   * Start the watchdog timer.
   */
  start(): void {
    this.startTime = Date.now();
    this.lastActivityTime = this.startTime;
    this.lastMeaningfulActivityTime = this.startTime;
    this.hasWarned = false;
    this.stopped = false;

    this.intervalId = setInterval(() => {
      if (this.stopped) return;
      this.check();
    }, this.logIntervalMs);
  }

  /**
   * Record activity (message received from SDK).
   * Only meaningful message types reset the stale tool timer.
   */
  recordActivity(messageType?: string): void {
    this.lastActivityTime = Date.now();
    if (messageType && MEANINGFUL_MESSAGE_TYPES.has(messageType)) {
      this.lastMeaningfulActivityTime = Date.now();
      this.hasWarned = false; // Reset warning state on meaningful activity
    }
  }

  /**
   * Check if watchdog should fire warnings or timeout.
   */
  private check(): void {
    // Suspend all timeouts while we're explicitly waiting on external user
    // input (e.g. an ask_user button tap). Bump both activity timestamps so
    // the moment the wait ends we don't immediately trip a timeout that
    // accumulated during the pause.
    if (this.shouldPauseTimeouts?.()) {
      const now = Date.now();
      this.lastActivityTime = now;
      this.lastMeaningfulActivityTime = now;
      return;
    }

    const now = Date.now();
    const sinceLastActivity = now - this.lastActivityTime;
    const sinceLastMeaningful = now - this.lastMeaningfulActivityTime;
    const totalElapsed = now - this.startTime;

    // Check hard timeout first
    if (this.timeoutMs > 0 && totalElapsed >= this.timeoutMs) {
      console.log(
        `[Claude] WATCHDOG TIMEOUT: No response after ${formatDuration(totalElapsed)}, chat:${this.chatId}`
      );
      this.onTimeout?.();
      this.stop();
      return;
    }

    // Check silence timeout (no messages at all — stream likely dead)
    if (this.silenceTimeoutMs > 0 && sinceLastActivity >= this.silenceTimeoutMs) {
      console.log(
        `[Claude] WATCHDOG SILENCE TIMEOUT: No messages for ${formatDuration(sinceLastActivity)} (limit: ${formatDuration(this.silenceTimeoutMs)}), chat:${this.chatId}`
      );
      this.onSilenceTimeout?.();
      this.stop();
      return;
    }

    // Check stale tool timeout (heartbeats arriving but no meaningful progress)
    if (this.staleToolTimeoutMs > 0 && sinceLastMeaningful >= this.staleToolTimeoutMs) {
      // Only fire if we ARE receiving heartbeats (otherwise silence timeout handles it)
      const receivingHeartbeats = this.lastActivityTime > this.lastMeaningfulActivityTime;
      if (receivingHeartbeats) {
        console.log(
          `[Claude] WATCHDOG STALE TOOL TIMEOUT: Only heartbeats for ${formatDuration(sinceLastMeaningful)} (limit: ${formatDuration(this.staleToolTimeoutMs)}), chat:${this.chatId}`
        );
        this.onStaleToolTimeout?.();
        this.stop();
        return;
      }
    }

    // Check warning threshold (based on meaningful activity)
    if (sinceLastMeaningful >= this.warnAfterMs) {
      if (!this.hasWarned) {
        // First warning at threshold
        this.hasWarned = true;
        console.log(
          `[Claude] WATCHDOG WARNING: No meaningful messages for ${formatDuration(sinceLastMeaningful)} (total: ${formatDuration(totalElapsed)}), chat:${this.chatId}`
        );
        this.onWarning?.(sinceLastMeaningful, totalElapsed);
      } else {
        // Subsequent "still waiting" logs
        console.log(
          `[Claude] [${formatDuration(totalElapsed)}] WATCHDOG: Still waiting, no meaningful messages for ${formatDuration(sinceLastMeaningful)}, chat:${this.chatId}`
        );
      }
    } else {
      // Under threshold - just log elapsed time at trace level
      console.log(
        `[Claude] [${formatDuration(totalElapsed)}] WATCHDOG: Logging - still waiting for messages`
      );
    }
  }

  /**
   * Stop the watchdog timer.
   */
  stop(): void {
    this.stopped = true;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Get total elapsed time since start.
   */
  getElapsedMs(): number {
    return Date.now() - this.startTime;
  }
}
