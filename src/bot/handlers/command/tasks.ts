/**
 * /tasks and /shells — inspecting what the agent is running.
 *
 * Grouped because both are read-only views over live process state with the
 * same list/detail inline-keyboard shape: /tasks over the SDK task tracker,
 * /shells over the pty's real child processes.
 */

import { Context } from 'grammy';
import { EntityText, type EntityMessage } from '../../../telegram/entities.js';
import { replyFormatted, editCallbackMessage } from '../../../telegram/send.js';
import { taskTracker, type TaskState } from '../../../telegram/task-tracker.js';
import { getPtyProvider } from '../../../providers/claude-provider.js';
import { scrapeTasksOverlay } from '../../../claude/tasks-overlay-scraper.js';
import {
  getDirectChildren,
  describeProcess,
  isDescendantOf,
  killTree,
  type ProcInfo,
} from '../../../utils/proc-children.js';
import { getSessionKeyFromCtx } from '../../../utils/session-key.js';

// ---------------------------------------------------------------------------
// /tasks — list and inspect SDK background tasks
// ---------------------------------------------------------------------------

interface TaskGroup {
  emoji: string;
  label: string;
  tasks: TaskState[];
}

function groupTasksForDisplay(tasks: TaskState[]): TaskGroup[] {
  const monitors: TaskState[] = [];
  const shells: TaskState[] = [];
  const agents: TaskState[] = [];
  const workflows: TaskState[] = [];
  const other: TaskState[] = [];

  for (const task of tasks) {
    switch (task.taskType) {
      case 'monitor_mcp': monitors.push(task); break;
      case 'local_bash': shells.push(task); break;
      case 'local_workflow': workflows.push(task); break;
      case 'local_agent':
      case 'remote_agent':
      case undefined:
        agents.push(task);
        break;
      default:
        other.push(task);
    }
  }

  const groups: TaskGroup[] = [];
  if (agents.length) groups.push({ emoji: '🤖', label: 'Agents', tasks: agents });
  if (monitors.length) groups.push({ emoji: '📡', label: 'Monitors', tasks: monitors });
  if (shells.length) groups.push({ emoji: '💻', label: 'Shells', tasks: shells });
  if (workflows.length) groups.push({ emoji: '📋', label: 'Workflows', tasks: workflows });
  if (other.length) groups.push({ emoji: '🔹', label: 'Other', tasks: other });
  return groups;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function formatTaskElapsed(task: TaskState): string {
  return formatDuration((task.endedAt ?? Date.now()) - task.startedAt);
}

function formatTaskSilence(task: TaskState): string {
  return formatDuration(Date.now() - task.lastActivityAt);
}

/**
 * How long a task may go without any SDK event before /tasks flags it as
 * probably-finished. A completion `notification` removes the entry outright,
 * so an entry still listed after a long silence usually means that event
 * never arrived (restart mid-task, dropped notification).
 *
 * Deliberately generous: this only annotates, never hides, but a false
 * positive on a slow-but-live agent is still noise.
 */
const STALE_AFTER_MS = 15 * 60 * 1000;

/**
 * Monitors are exempt. An armed monitor waiting for its first event is
 * *supposed* to sit silent for hours, so inactivity carries no signal about
 * whether it's still alive — flagging them would mark every idle monitor.
 */
function isPossiblyStale(task: TaskState): boolean {
  if (task.taskType === 'monitor_mcp') return false;
  return Date.now() - task.lastActivityAt > STALE_AFTER_MS;
}

function getActiveTasks(sessionKey: string): TaskState[] {
  return taskTracker.getTasks(sessionKey).filter(t =>
    t.status === 'running' || t.status === 'pending'
  );
}

function renderTasksList(sessionKey: string, tasks: TaskState[]): { message: EntityMessage; keyboard: { text: string; callback_data: string }[][] } {
  if (tasks.length === 0) {
    // Cross-pointer: a `Bash(run_in_background=true)` shell can outlive its SDK
    // task entry (npm release scripts, deploys), so the statusline's 🔍 counter
    // may show > 0 while /tasks is empty. Surface that here so users know
    // where to look next.
    const claudePid = getPtyProvider().getSessionPid(sessionKey);
    const shellCount = claudePid !== undefined ? getBgProcesses(claudePid).length : 0;
    const b = new EntityText().add('🔄 ').bold('Active background tasks').newline(2).add('None running.');
    if (shellCount > 0) {
      const noun = shellCount === 1 ? 'shell' : 'shells';
      b.newline(2).italic(`🔍 ${shellCount} background ${noun} still running — see /shells.`);
    }
    return {
      message: b.build(),
      keyboard: [[
        { text: '🔄 Refresh', callback_data: 'tasks:refresh' },
        { text: '🔎 Ask claude', callback_data: 'tasks:ask' },
      ]],
    };
  }

  const groups = groupTasksForDisplay(tasks);
  const b = new EntityText()
    .add('🔄 ')
    .bold('Active background tasks')
    .add(` (${tasks.length})`)
    .newline(2);

  // Number tasks globally so callback buttons match the listed indices.
  let index = 1;
  const numberedTasks: TaskState[] = [];

  for (const group of groups) {
    b.add(`${group.emoji} `).bold(group.label).add(` (${group.tasks.length})`).newline();
    for (const task of group.tasks) {
      const desc = task.description.length > 70
        ? task.description.substring(0, 67) + '...'
        : task.description;
      const staleMark = isPossiblyStale(task) ? '⚠️ ' : '';
      b.add(`  ${index}. ${staleMark}${desc} · ${formatTaskElapsed(task)}`).newline();
      numberedTasks.push(task);
      index++;
    }
    b.newline();
  }
  b.italic('Tap a number to view details.');
  if (numberedTasks.some(isPossiblyStale)) {
    b.newline().italic(
      '⚠️ no update in a while — may have finished already. ' +
        'Tap 🔎 Ask claude to confirm.',
    );
  }

  const keyboard: { text: string; callback_data: string }[][] = [];
  // Telegram inline keyboards render best at 5 buttons per row for short labels.
  const numberRow: { text: string; callback_data: string }[] = [];
  numberedTasks.forEach((task, i) => {
    numberRow.push({ text: String(i + 1), callback_data: `tasks:view:${task.id}` });
    if (numberRow.length === 5 || i === numberedTasks.length - 1) {
      keyboard.push([...numberRow]);
      numberRow.length = 0;
    }
  });
  keyboard.push([
    { text: '🔄 Refresh', callback_data: 'tasks:refresh' },
    { text: '🔎 Ask claude', callback_data: 'tasks:ask' },
  ]);

  return { message: b.build(), keyboard };
}

function renderTaskDetail(task: TaskState): { message: EntityMessage; keyboard: { text: string; callback_data: string }[][] } {
  const groupHint = (() => {
    switch (task.taskType) {
      case 'monitor_mcp': return '📡 Monitor';
      case 'local_bash': return '💻 Shell';
      case 'local_workflow': return '📋 Workflow';
      case 'local_agent':
      case 'remote_agent':
      case undefined: return '🤖 Agent';
      default: return '🔹 Task';
    }
  })();

  const b = new EntityText().add(`${groupHint}: `).bold(task.description).newline();
  /** A `• Label: ` bullet on a line of its own; the caller appends the value. */
  const field = (label: string) => b.newline().add('• ').bold(`${label}:`).add(' ');

  field('Status').add(task.status);
  field('Backgrounded').add(task.isBackgrounded ? 'yes' : 'no');
  field('Started').add(`${formatTaskElapsed(task)} ago`);
  if (isPossiblyStale(task)) {
    field('Last update').add(`${formatTaskSilence(task)} ago ⚠️`);
  }
  if (task.taskType) {
    field('Type').code(task.taskType);
  }
  if (task.lastProgress?.lastToolName) {
    field('Last tool').code(task.lastProgress.lastToolName);
  }
  if (task.lastProgress?.usage) {
    const u = task.lastProgress.usage;
    field('Tokens').add(`${u.totalTokens} · `).bold('Tool uses:').add(` ${u.toolUses}`);
  }
  if (task.lastProgress?.summary) {
    const summary = task.lastProgress.summary.length > 300
      ? task.lastProgress.summary.substring(0, 297) + '...'
      : task.lastProgress.summary;
    b.newline(2).bold('Latest progress:').newline().quote(summary);
  }
  if (task.error) {
    b.newline(2).add(`⚠️ ${task.error}`);
  }

  return {
    message: b.build(),
    keyboard: [
      [
        { text: '← Back to list', callback_data: 'tasks:back' },
        { text: '🔄 Refresh', callback_data: `tasks:view:${task.id}` },
      ],
    ],
  };
}

export async function handleTasks(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) {
    await ctx.reply('❌ Could not determine chat context for /tasks.');
    return;
  }

  const tasks = getActiveTasks(keyInfo.sessionKey);
  const { message, keyboard } = renderTasksList(keyInfo.sessionKey, tasks);

  await replyFormatted(ctx, message, { reply_markup: { inline_keyboard: keyboard } });
}

export async function handleTasksCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!data || !keyInfo) {
    await ctx.answerCallbackQuery().catch(() => {});
    return;
  }
  const { sessionKey } = keyInfo;

  if (data === 'tasks:refresh' || data === 'tasks:back') {
    const tasks = getActiveTasks(sessionKey);
    const { message, keyboard } = renderTasksList(sessionKey, tasks);
    await ctx.answerCallbackQuery().catch(() => {});
    try {
      await editCallbackMessage(ctx, message, { reply_markup: { inline_keyboard: keyboard } });
    } catch (err) {
      // "message is not modified" is fine — content already up to date.
      const msg = err instanceof Error ? err.message.toLowerCase() : '';
      if (!msg.includes('message is not modified')) {
        console.error('[Tasks] Failed to refresh list:', err);
      }
    }
    return;
  }

  if (data === 'tasks:ask') {
    await handleAskClaude(ctx, sessionKey);
    return;
  }

  if (data.startsWith('tasks:view:')) {
    const taskId = data.substring('tasks:view:'.length);
    const task = taskTracker.getTask(sessionKey, taskId);
    if (!task) {
      // Task finished or was cleared between renders — go back to the list.
      const tasks = getActiveTasks(sessionKey);
      const { message, keyboard } = renderTasksList(sessionKey, tasks);
      await ctx.answerCallbackQuery({ text: 'Task no longer active.' }).catch(() => {});
      try {
        await editCallbackMessage(ctx, message, { reply_markup: { inline_keyboard: keyboard } });
      } catch { /* ignore */ }
      return;
    }
    const { message, keyboard } = renderTaskDetail(task);
    await ctx.answerCallbackQuery().catch(() => {});
    try {
      await editCallbackMessage(ctx, message, { reply_markup: { inline_keyboard: keyboard } });
    } catch (err) {
      const msg = err instanceof Error ? err.message.toLowerCase() : '';
      if (!msg.includes('message is not modified')) {
        console.error('[Tasks] Failed to render detail:', err);
      }
    }
    return;
  }

  await ctx.answerCallbackQuery().catch(() => {});
}

/**
 * Test hooks. The predicate is pure, but the render path is where a staleness
 * regression would actually be seen, so both are exposed — and the detail
 * view with them, for its formatting.
 */
export const _isPossiblyStale = isPossiblyStale;
export const _renderTasksList = renderTasksList;
export const _renderTaskDetail = renderTaskDetail;

// ---------------------------------------------------------------------------
// "🔎 Ask claude" — relay claude's own /tasks overlay
// ---------------------------------------------------------------------------

/**
 * The tracker above is reconstructed from tool-arm and task-notification
 * events, so it only knows about work TeleCoder saw start. Claude's own
 * `/tasks` overlay is the live process's view: it also covers shells claude
 * backgrounded on its own initiative, and everything armed before the last bot
 * restart (relay state doesn't persist). This button asks it directly.
 *
 * PTY-only — there is no TUI to drive in SDK mode, where the tracker is fed
 * from the event stream and is already authoritative.
 */
async function handleAskClaude(ctx: Context, sessionKey: string): Promise<void> {
  await ctx.answerCallbackQuery({ text: 'Asking claude…' }).catch(() => {});

  // Every answer below opens with the same heading.
  const view = () => new EntityText().add('🔎 ').bold("Claude's background view").newline(2);

  const result = await getPtyProvider().runOverlayCommand(sessionKey, '/tasks');
  if (!result.ok) {
    const reason =
      result.reason === 'turn-active'
        ? 'Claude is mid-turn — the TUI keyboard is busy. Try again once it finishes.'
        : result.reason === 'not-ready'
          ? 'The Claude TUI is not at a prompt right now. Try again in a moment.'
          : 'No active PTY session for this chat. In SDK mode the list above is already authoritative.';
    await replyFormatted(ctx, view().add(reason).build());
    return;
  }

  const overlay = scrapeTasksOverlay(result.screen);
  if (!overlay) {
    // The overlay's layout is a Claude Code implementation detail and can move
    // between releases — say so plainly rather than showing a mangled guess.
    await replyFormatted(
      ctx,
      view()
        .add("Couldn't read the ")
        .code('/tasks')
        .add(' overlay — Claude Code may have changed its layout. The list above still works.')
        .build(),
    );
    return;
  }

  if (overlay.empty) {
    // A code block for one line of "nothing running" is noise. Worth saying
    // out loud though: claude reporting empty while the list above shows
    // tasks means our tracker is holding entries claude no longer knows about.
    const tracked = getActiveTasks(sessionKey).length;
    const b = view().add('Nothing running.');
    if (tracked > 0) {
      b.newline(2).italic(`The ${tracked} task(s) listed above are unknown to claude — likely finished already.`);
    }
    await replyFormatted(ctx, b.build());
    return;
  }

  const body = overlay.text.length > 3000 ? overlay.text.slice(0, 2997) + '...' : overlay.text;
  await replyFormatted(ctx, view().pre(body).build());
}

// ── /shells ─────────────────────────────────────────────────────
// List OS-level child processes of the chat's PTY claude session and offer
// a one-tap SIGTERM. Complements /tasks (which only sees SDK-tracked tasks)
// and rescues `Bash(run_in_background=true)` shells whose stop condition
// will never fire.

const BG_MCP_SERVER_MARKER = 'mcp-server.js';

function formatBgAge(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return m > 0 ? `${h}h${m}m` : `${h}h`;
  }
  return `${Math.floor(sec / 86400)}d`;
}

function truncateBgCmd(cmd: string, max = 150): string {
  if (cmd.length <= max) return cmd;
  return cmd.substring(0, max - 1) + '…';
}

// Claude's `Bash(run_in_background=true)` shells are spawned as
//   <shell> -c "source <snapshot> && setopt … && eval '<USER_CMD>' < /dev/null && pwd -P >| /tmp/…"
// The wrapper is noise — pull out the real command between `eval '` and the
// trailing `' < /dev/null`. Returns the original cmd if the pattern doesn't
// match (e.g. the MCP server, foreign children).
function unwrapBgCmd(cmd: string): string {
  const evalIdx = cmd.indexOf("eval '");
  if (evalIdx === -1) return cmd;
  const start = evalIdx + "eval '".length;
  const tail = cmd.indexOf("' < /dev/null", start);
  if (tail === -1 || tail <= start) return cmd;
  return cmd.substring(start, tail);
}

export function getBgProcesses(claudePid: number): ProcInfo[] {
  const result: ProcInfo[] = [];
  for (const childPid of getDirectChildren(claudePid)) {
    const info = describeProcess(childPid);
    if (!info) continue;
    if (info.cmd.includes(BG_MCP_SERVER_MARKER)) continue;
    result.push(info);
  }
  return result;
}

function renderBgList(sessionKey: string, claudePid: number | undefined, procs: ProcInfo[]): {
  message: EntityMessage;
  keyboard: { text: string; callback_data: string }[][];
} {
  const heading = () => new EntityText().add('🔍 ').bold('Background processes');
  if (claudePid === undefined) {
    return {
      message: heading()
        .newline(2)
        .italic('No active PTY session for this chat.')
        .newline(2)
        .add('In SDK mode, use /tasks to inspect tracked background tasks.')
        .build(),
      keyboard: [],
    };
  }
  if (procs.length === 0) {
    // Cross-pointer to /tasks when SDK-tracked tasks (agents, monitors) are
    // running but no OS shells are.
    const taskCount = getActiveTasks(sessionKey).length;
    const b = heading().newline(2).add('None running.');
    if (taskCount > 0) {
      const noun = taskCount === 1 ? 'task' : 'tasks';
      b.newline(2).italic(`🔄 ${taskCount} SDK ${noun} still running — see /tasks.`);
    }
    return {
      message: b.build(),
      keyboard: [[{ text: '🔄 Refresh', callback_data: 'shells:refresh' }]],
    };
  }

  const b = heading().add(` (${procs.length})`).newline(2);
  procs.forEach((p, i) => {
    b.bold(`${i + 1}.`).add(` [${formatBgAge(p.ageSec)}] pid `).code(String(p.pid)).newline();
    b.code(truncateBgCmd(unwrapBgCmd(p.cmd))).newline(2);
  });
  b.italic('Tap a number to SIGTERM that process (and its descendants).');

  const keyboard: { text: string; callback_data: string }[][] = [];
  let row: { text: string; callback_data: string }[] = [];
  procs.forEach((p, i) => {
    row.push({ text: `🛑 #${i + 1}`, callback_data: `shells:kill:${p.pid}` });
    if (row.length === 4 || i === procs.length - 1) {
      keyboard.push(row);
      row = [];
    }
  });
  keyboard.push([
    { text: '🛑 Kill all', callback_data: 'shells:killall' },
    { text: '🔄 Refresh', callback_data: 'shells:refresh' },
  ]);
  return { message: b.build(), keyboard };
}

async function rerenderBg(ctx: Context, sessionKey: string, claudePid: number | undefined): Promise<void> {
  // Brief grace period so killed processes drop out of /proc before we re-read.
  await new Promise((r) => setTimeout(r, 200));
  const procs = claudePid !== undefined ? getBgProcesses(claudePid) : [];
  const { message, keyboard } = renderBgList(sessionKey, claudePid, procs);
  try {
    await editCallbackMessage(ctx, message, { reply_markup: { inline_keyboard: keyboard } });
  } catch (err) {
    const msg = err instanceof Error ? err.message.toLowerCase() : '';
    if (!msg.includes('message is not modified')) {
      console.error('[/shells] Failed to refresh list:', err);
    }
  }
}

export async function handleShells(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) {
    await ctx.reply('❌ Could not determine chat context for /shells.');
    return;
  }
  const claudePid = getPtyProvider().getSessionPid(keyInfo.sessionKey);
  const procs = claudePid !== undefined ? getBgProcesses(claudePid) : [];
  const { message, keyboard } = renderBgList(keyInfo.sessionKey, claudePid, procs);
  await replyFormatted(ctx, message, { reply_markup: { inline_keyboard: keyboard } });
}

export async function handleShellsCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!data || !keyInfo) {
    await ctx.answerCallbackQuery().catch(() => {});
    return;
  }
  const claudePid = getPtyProvider().getSessionPid(keyInfo.sessionKey);

  if (data === 'shells:refresh') {
    await ctx.answerCallbackQuery().catch(() => {});
    await rerenderBg(ctx, keyInfo.sessionKey, claudePid);
    return;
  }

  if (data === 'shells:killall') {
    if (claudePid === undefined) {
      await ctx.answerCallbackQuery({ text: 'No active session.' }).catch(() => {});
      return;
    }
    const procs = getBgProcesses(claudePid);
    let total = 0;
    for (const p of procs) total += killTree(p.pid);
    await ctx.answerCallbackQuery({ text: `SIGTERM sent to ${total} process(es).` }).catch(() => {});
    await rerenderBg(ctx, keyInfo.sessionKey, claudePid);
    return;
  }

  if (data.startsWith('shells:kill:')) {
    const pid = Number.parseInt(data.substring('shells:kill:'.length), 10);
    if (claudePid === undefined || !Number.isFinite(pid)) {
      await ctx.answerCallbackQuery({ text: 'Unknown target.' }).catch(() => {});
      return;
    }
    // PIDs can be recycled — refuse to signal anything that's no longer a
    // descendant of this chat's claude session.
    if (!isDescendantOf(claudePid, pid)) {
      await ctx.answerCallbackQuery({ text: `PID ${pid} no longer belongs to this session.` }).catch(() => {});
      await rerenderBg(ctx, keyInfo.sessionKey, claudePid);
      return;
    }
    const killed = killTree(pid);
    await ctx.answerCallbackQuery({ text: `SIGTERM sent (${killed} process(es)).` }).catch(() => {});
    await rerenderBg(ctx, keyInfo.sessionKey, claudePid);
    return;
  }

  await ctx.answerCallbackQuery().catch(() => {});
}
