/**
 * Tracks the work each session has running in the background: monitors,
 * backgrounded shells, subagents and workflows.
 *
 * The monitor relay (claude/monitor-relay.ts) feeds it. It records a task when
 * claude starts one and removes it when the task's notification comes back,
 * which may be turns later. So a task in here is one still running in the
 * background, and there is no status to keep. Cleared with the session's
 * relay state.
 */

/** What is known about a task when claude starts it. */
export interface TaskStart {
  taskId: string;
  description: string;
  /**
   * For a backgrounded shell, the command it runs. The description is what
   * the model called it; claude's own `/tasks` list shows the command, so
   * this is what finds the task's row there.
   */
  command?: string;
  toolUseId?: string;
  taskType?: string;
  /**
   * When the task began, for one already running before it was reported: a
   * Bash call claude moved to the background had been running in the
   * foreground until then. Defaults to now.
   */
  startedAt?: number;
}

/** One timed line of what a task is doing, for the running-in-background footer. */
export interface TaskUpdate {
  at: number;
  text: string;
}

/** Updates kept per task: the footer shares the status bubble, so only the latest few. */
const MAX_TASK_UPDATES = 3;

export interface TaskState {
  id: string;
  description: string;
  /** A backgrounded shell's command; see TaskStart.command. */
  command?: string;
  taskType?: string;
  toolUseId?: string;
  /**
   * Claude's own id for the task (the `bkvx2hlkb` in "moved to the background
   * (ID: bkvx2hlkb)"). TaskStop names a task by this id and nothing else, so
   * without it a stopped task could not be found. Known once the launching
   * call has returned; a relay-armed task has none until then.
   */
  claudeTaskId?: string;
  startedAt: number;
  /**
   * Last time the task was heard from: its start, or a monitor firing. The
   * notification that ends a task removes the entry outright, so a
   * long-silent entry is usually one whose notification never landed: a
   * restart mid-task, or a dropped event. /tasks flags those instead of
   * hiding them.
   */
  lastActivityAt: number;
  /**
   * The latest things the task reported, oldest first, capped at
   * MAX_TASK_UPDATES: a monitor's firings.
   */
  updates?: TaskUpdate[];
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

  /** Record a task claude has just started. */
  start(sessionKey: string, task: TaskStart): TaskState {
    const state: TaskState = {
      id: task.taskId,
      description: task.description,
      ...(task.command !== undefined ? { command: task.command } : {}),
      taskType: task.taskType,
      toolUseId: task.toolUseId,
      startedAt: task.startedAt ?? Date.now(),
      lastActivityAt: Date.now(),
    };
    this.getOrCreateMap(sessionKey).set(task.taskId, state);
    return state;
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

  /** Record something a task reported: a monitor firing. Unknown tasks are ignored. */
  noteUpdate(sessionKey: string, taskId: string, text: string, at = Date.now()): void {
    const task = this.sessionTasks.get(sessionKey)?.get(taskId);
    if (!task) return;
    task.lastActivityAt = at;
    pushUpdate(task, text, at);
  }

  /** Record claude's own id for a task, once the launching call has returned it. */
  setClaudeTaskId(sessionKey: string, taskId: string, claudeTaskId: string): void {
    const task = this.sessionTasks.get(sessionKey)?.get(taskId);
    if (task) task.claudeTaskId = claudeTaskId;
  }

  /** The task claude knows by `claudeTaskId`, if its launching call reported it. */
  findByClaudeTaskId(sessionKey: string, claudeTaskId: string): TaskState | undefined {
    const tasks = this.sessionTasks.get(sessionKey);
    if (!tasks) return undefined;
    for (const task of tasks.values()) if (task.claudeTaskId === claudeTaskId) return task;
    return undefined;
  }

  getTask(sessionKey: string, taskId: string): TaskState | undefined {
    return this.sessionTasks.get(sessionKey)?.get(taskId);
  }

  /**
   * The session's tasks running in the background, oldest first. Drives
   * `/tasks` and the streaming UI's "in background" footer.
   */
  getTasks(sessionKey: string): TaskState[] {
    const tasks = this.sessionTasks.get(sessionKey);
    return tasks ? Array.from(tasks.values()) : [];
  }

  getBackgroundedCount(sessionKey: string): number {
    return this.sessionTasks.get(sessionKey)?.size ?? 0;
  }

  /** Background tasks still running across every session. */
  getBackgroundedTotal(): number {
    let total = 0;
    for (const sessionKey of this.sessionTasks.keys()) total += this.getBackgroundedCount(sessionKey);
    return total;
  }

  /**
   * True when at least one Monitor task is currently running. The idle reaper
   * asks: a pty with a monitor armed isn't idle, however quiet it is.
   */
  hasActiveMonitor(sessionKey: string): boolean {
    const tasks = this.sessionTasks.get(sessionKey);
    if (!tasks) return false;
    for (const task of tasks.values()) {
      if (task.taskType === 'monitor_mcp') return true;
    }
    return false;
  }

  clear(sessionKey: string): void {
    this.sessionTasks.delete(sessionKey);
  }
}

function pushUpdate(task: TaskState, text: string, at = Date.now()): void {
  const line = text.replace(/\s+/g, ' ').trim();
  if (!line) return;
  const updates = task.updates ?? [];
  // A repeat says nothing new; moving its time up keeps the footer honest
  // about when the task last spoke.
  const last = updates[updates.length - 1];
  if (last?.text === line) last.at = at;
  else updates.push({ at, text: line });
  task.updates = updates.slice(-MAX_TASK_UPDATES);
}

export const taskTracker = new TaskTracker();
