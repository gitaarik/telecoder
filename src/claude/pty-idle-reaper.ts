/**
 * Ending PTY sessions nobody is using.
 *
 * A PTY session keeps its `claude` running between turns, a few hundred MB
 * each, and nothing else ever ends one short of /clear, a crash or a restart.
 * Threads make that add up: every thread is a session, and a thread deleted
 * in Telegram leaves its claude behind for good, since Telegram tells the bot
 * nothing about it.
 *
 * So every few minutes, the claudes idle longer than CLAUDE_PTY_IDLE_TIMEOUT_MS
 * are ended. That costs the next message in such a session a few seconds of
 * startup while it resumes from the transcript, as after a restart; the
 * prompt cache it would have hit has expired by then anyway.
 *
 * Idle means nothing would be lost: no turn, whoever started it; no
 * background task, Monitor or subagent still to report back; and no shell
 * Claude left running in the background, which would die with its claude.
 */

import { config } from '../config.js';
import { getPtyProvider } from '../providers/claude-provider.js';
import { taskTracker } from '../telegram/task-tracker.js';
import { describeProcess, getDirectChildren } from '../utils/proc-children.js';
import { isProcessing } from './request-queue.js';
import { hasSelfStartedTurn } from './monitor-relay.js';

const SWEEP_MS = 5 * 60_000;

/**
 * Claude's Bash tool runs every command, a background one too, in a shell
 * that sources its snapshot of the user's shell first. Its MCP servers are
 * children of claude as well, and must not count.
 */
const BASH_TOOL_SHELL_MARKER = '/shell-snapshots/snapshot-';

function hasBashToolShell(claudePid: number): boolean {
  return getDirectChildren(claudePid).some((pid) => describeProcess(pid)?.cmd.includes(BASH_TOOL_SHELL_MARKER));
}

/** Whether ending this session's claude now would cut something off. */
export function sessionHasWork(sessionKey: string, claudePid: number): boolean {
  return isProcessing(sessionKey)
    || hasSelfStartedTurn(sessionKey)
    || taskTracker.getBackgroundedCount(sessionKey) > 0
    || taskTracker.hasActiveMonitor(sessionKey)
    || hasBashToolShell(claudePid);
}

/** One sweep: end the idle claudes and say which. */
export function endIdlePtySessions(maxIdleMs = config.CLAUDE_PTY_IDLE_TIMEOUT_MS): string[] {
  if (maxIdleMs <= 0) return [];
  const ended = getPtyProvider().endIdleSessions(maxIdleMs, sessionHasWork);
  if (ended.length > 0) {
    console.log(`[PtyIdleReaper] Ended ${ended.length} idle claude(s): ${ended.join(', ')}`);
  }
  return ended;
}

/** Sweep every few minutes from now on. A no-op when the timeout is 0. */
export function startPtyIdleReaper(): void {
  if (config.CLAUDE_PTY_IDLE_TIMEOUT_MS <= 0) return;
  const timer = setInterval(() => {
    try {
      endIdlePtySessions();
    } catch (err) {
      console.error('[PtyIdleReaper] Sweep failed:', err instanceof Error ? err.message : err);
    }
  }, SWEEP_MS);
  timer.unref?.();
}
