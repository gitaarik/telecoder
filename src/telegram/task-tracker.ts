/**
 * Tracks Claude Agent SDK background tasks per session.
 *
 * Tasks survive across streaming turns: a task started in turn 1 may emit
 * its `task_notification` in turn 2 or later (e.g. when the model calls
 * `TaskOutput` to wait for completion). Cleared explicitly via clear() on
 * /reset or session teardown.
 */

import type { TaskEvent, TaskStatus, TaskUsage } from '../providers/types.js';

export interface TaskState {
  id: string;
  description: string;
  taskType?: string;
  workflowName?: string;
  toolUseId?: string;
  status: TaskStatus;
  isBackgrounded: boolean;
  skipTranscript: boolean;
  startedAt: number;
  endedAt?: number;
  lastProgress?: { summary?: string; lastToolName?: string; usage?: TaskUsage };
  outputFile?: string;
  finalSummary?: string;
  error?: string;
  /**
   * message_id of the chat message announcing the task started ("📡 Monitor
   * armed", "⚙️ Backgrounded", "🤖 Subagent started"). When the task finishes,
   * completion handlers edit this message in place so the chat doesn't keep
   * showing a stale "in progress" line.
   */
  armedMessageId?: number;
}

class TaskTracker {
  private sessionTasks: Map<string, Map<string, TaskState>> = new Map();

  private getOrCreateMap(sessionKey: string): Map<string, TaskState> {
    let tasks = this.sessionTasks.get(sessionKey);
    if (!tasks) {
      tasks = new Map();
      this.sessionTasks.set(sessionKey, tasks);
    }
    return tasks;
  }

  /**
   * Apply an SDK task event to the per-session task map.
   * Returns the resulting TaskState (or undefined if the event referenced
   * an unknown task on a non-started subtype).
   */
  handleEvent(sessionKey: string, event: TaskEvent): TaskState | undefined {
    const tasks = this.getOrCreateMap(sessionKey);

    switch (event.type) {
      case 'started': {
        // Monitors are inherently long-running streaming subscriptions —
        // treat them as backgrounded even if the launching tool didn't set
        // run_in_background:true.
        const isMonitor = event.taskType === 'monitor_mcp';
        const state: TaskState = {
          id: event.taskId,
          description: event.description,
          taskType: event.taskType,
          workflowName: event.workflowName,
          toolUseId: event.toolUseId,
          status: 'running',
          isBackgrounded: event.isBackgrounded ?? isMonitor,
          skipTranscript: event.skipTranscript ?? false,
          startedAt: Date.now(),
        };
        tasks.set(event.taskId, state);
        return state;
      }
      case 'progress': {
        const existing = tasks.get(event.taskId);
        if (!existing) return undefined;
        // Note: event.description on progress events conveys the *current
        // activity*, not the task's description — keep the original.
        existing.lastProgress = {
          summary: event.summary,
          lastToolName: event.lastToolName,
          usage: event.usage,
        };
        return existing;
      }
      case 'updated': {
        const existing = tasks.get(event.taskId);
        if (!existing) return undefined;
        if (event.status) existing.status = event.status;
        if (event.isBackgrounded !== undefined) existing.isBackgrounded = event.isBackgrounded;
        if (event.error !== undefined) existing.error = event.error;
        if (event.endTime !== undefined) existing.endedAt = event.endTime;
        return existing;
      }
      case 'notification': {
        const existing = tasks.get(event.taskId);
        if (!existing) {
          // Notification for an unknown task — synthesise a minimal record
          const synthetic: TaskState = {
            id: event.taskId,
            description: '(unknown task)',
            status: event.status,
            isBackgrounded: false,
            skipTranscript: false,
            startedAt: Date.now(),
            endedAt: Date.now(),
            outputFile: event.outputFile,
            finalSummary: event.summary,
          };
          tasks.set(event.taskId, synthetic);
          return synthetic;
        }
        existing.status = event.status;
        existing.outputFile = event.outputFile;
        existing.finalSummary = event.summary;
        existing.endedAt = existing.endedAt ?? Date.now();
        if (event.usage) {
          existing.lastProgress = {
            ...existing.lastProgress,
            usage: event.usage,
          };
        }
        return existing;
      }
    }
  }

  /**
   * Remove a finished task from the tracker. Call once the completion
   * notification has been delivered to the user.
   */
  remove(sessionKey: string, taskId: string): void {
    const tasks = this.sessionTasks.get(sessionKey);
    if (!tasks) return;
    tasks.delete(taskId);
    if (tasks.size === 0) {
      this.sessionTasks.delete(sessionKey);
    }
  }

  getTask(sessionKey: string, taskId: string): TaskState | undefined {
    return this.sessionTasks.get(sessionKey)?.get(taskId);
  }

  getTasks(sessionKey: string): TaskState[] {
    const tasks = this.sessionTasks.get(sessionKey);
    return tasks ? Array.from(tasks.values()) : [];
  }

  /**
   * Tasks currently running in the background
   * (is_backgrounded=true, status not in a terminal state).
   * Drives the streaming UI's "in background" footer.
   */
  getBackgroundedTasks(sessionKey: string): TaskState[] {
    const tasks = this.sessionTasks.get(sessionKey);
    if (!tasks) return [];
    const result: TaskState[] = [];
    for (const task of tasks.values()) {
      if (task.isBackgrounded && (task.status === 'running' || task.status === 'pending')) {
        result.push(task);
      }
    }
    return result;
  }

  getBackgroundedCount(sessionKey: string): number {
    return this.getBackgroundedTasks(sessionKey).length;
  }

  /**
   * True when at least one Monitor task is currently running. Used to detect
   * SDK sub-turns that are triggered by monitor events so the bot can surface
   * the model's echoed event line as its own Telegram message.
   */
  hasActiveMonitor(sessionKey: string): boolean {
    const tasks = this.sessionTasks.get(sessionKey);
    if (!tasks) return false;
    for (const task of tasks.values()) {
      if (task.taskType === 'monitor_mcp' && (task.status === 'running' || task.status === 'pending')) {
        return true;
      }
    }
    return false;
  }

  clear(sessionKey: string): void {
    this.sessionTasks.delete(sessionKey);
  }
}

export const taskTracker = new TaskTracker();
