/**
 * /tasks and /shells — inspecting what the agent is running.
 *
 * Grouped because both are read-only views over live process state with the
 * same list/detail inline-keyboard shape: /tasks over the SDK task tracker,
 * /shells over the pty's real child processes.
 */

import { Context } from 'grammy';
import { escapeMarkdownV2 as esc } from '../../../telegram/markdown.js';
import { taskTracker, type TaskState } from '../../../telegram/task-tracker.js';
import { getPtyProvider } from '../../../providers/claude-provider.js';
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

function formatTaskElapsed(task: TaskState): string {
  const elapsedMs = (task.endedAt ?? Date.now()) - task.startedAt;
  const seconds = Math.floor(elapsedMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function getActiveTasks(sessionKey: string): TaskState[] {
  return taskTracker.getTasks(sessionKey).filter(t =>
    t.status === 'running' || t.status === 'pending'
  );
}

function renderTasksList(sessionKey: string, tasks: TaskState[]): { text: string; keyboard: { text: string; callback_data: string }[][] } {
  if (tasks.length === 0) {
    // Cross-pointer: a `Bash(run_in_background=true)` shell can outlive its SDK
    // task entry (npm release scripts, deploys), so the statusline's 🔍 counter
    // may show > 0 while /tasks is empty. Surface that here so users know
    // where to look next.
    const claudePid = getPtyProvider().getSessionPid(sessionKey);
    const shellCount = claudePid !== undefined ? getBgProcesses(claudePid).length : 0;
    const lines = ['🔄 *Active background tasks*', '', 'None running\\.'];
    if (shellCount > 0) {
      const noun = shellCount === 1 ? 'shell' : 'shells';
      lines.push('');
      lines.push(`_🔍 ${shellCount} background ${noun} still running — see /shells\\._`);
    }
    return {
      text: lines.join('\n'),
      keyboard: [[{ text: '🔄 Refresh', callback_data: 'tasks:refresh' }]],
    };
  }

  const groups = groupTasksForDisplay(tasks);
  const lines: string[] = [`🔄 *Active background tasks* \\(${tasks.length}\\)`, ''];

  // Number tasks globally so callback buttons match the listed indices.
  let index = 1;
  const numberedTasks: TaskState[] = [];

  for (const group of groups) {
    lines.push(`${group.emoji} *${esc(group.label)}* \\(${group.tasks.length}\\)`);
    for (const task of group.tasks) {
      const desc = task.description.length > 70
        ? task.description.substring(0, 67) + '...'
        : task.description;
      lines.push(`  ${index}\\. ${esc(desc)} · ${esc(formatTaskElapsed(task))}`);
      numberedTasks.push(task);
      index++;
    }
    lines.push('');
  }
  lines.push('_Tap a number to view details\\._');

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
  keyboard.push([{ text: '🔄 Refresh', callback_data: 'tasks:refresh' }]);

  return { text: lines.join('\n'), keyboard };
}

function renderTaskDetail(task: TaskState): { text: string; keyboard: { text: string; callback_data: string }[][] } {
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

  const lines: string[] = [
    `${groupHint}: *${esc(task.description)}*`,
    '',
    `• *Status:* ${esc(task.status)}`,
    `• *Backgrounded:* ${task.isBackgrounded ? 'yes' : 'no'}`,
    `• *Started:* ${esc(formatTaskElapsed(task))} ago`,
  ];
  if (task.taskType) {
    lines.push(`• *Type:* \`${esc(task.taskType)}\``);
  }
  if (task.lastProgress?.lastToolName) {
    lines.push(`• *Last tool:* \`${esc(task.lastProgress.lastToolName)}\``);
  }
  if (task.lastProgress?.usage) {
    const u = task.lastProgress.usage;
    lines.push(`• *Tokens:* ${esc(String(u.totalTokens))} · *Tool uses:* ${esc(String(u.toolUses))}`);
  }
  if (task.lastProgress?.summary) {
    const summary = task.lastProgress.summary.length > 300
      ? task.lastProgress.summary.substring(0, 297) + '...'
      : task.lastProgress.summary;
    lines.push('');
    lines.push('*Latest progress:*');
    lines.push(`> ${esc(summary)}`);
  }
  if (task.error) {
    lines.push('');
    lines.push(`⚠️ ${esc(task.error)}`);
  }

  return {
    text: lines.join('\n'),
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
  const { text, keyboard } = renderTasksList(keyInfo.sessionKey, tasks);

  await ctx.reply(text, {
    parse_mode: 'MarkdownV2',
    reply_markup: { inline_keyboard: keyboard },
  });
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
    const { text, keyboard } = renderTasksList(sessionKey, tasks);
    await ctx.answerCallbackQuery().catch(() => {});
    try {
      await ctx.editMessageText(text, {
        parse_mode: 'MarkdownV2',
        reply_markup: { inline_keyboard: keyboard },
      });
    } catch (err) {
      // "message is not modified" is fine — content already up to date.
      const msg = err instanceof Error ? err.message.toLowerCase() : '';
      if (!msg.includes('message is not modified')) {
        console.error('[Tasks] Failed to refresh list:', err);
      }
    }
    return;
  }

  if (data.startsWith('tasks:view:')) {
    const taskId = data.substring('tasks:view:'.length);
    const task = taskTracker.getTask(sessionKey, taskId);
    if (!task) {
      // Task finished or was cleared between renders — go back to the list.
      const tasks = getActiveTasks(sessionKey);
      const { text, keyboard } = renderTasksList(sessionKey, tasks);
      await ctx.answerCallbackQuery({ text: 'Task no longer active.' }).catch(() => {});
      try {
        await ctx.editMessageText(text, {
          parse_mode: 'MarkdownV2',
          reply_markup: { inline_keyboard: keyboard },
        });
      } catch { /* ignore */ }
      return;
    }
    const { text, keyboard } = renderTaskDetail(task);
    await ctx.answerCallbackQuery().catch(() => {});
    try {
      await ctx.editMessageText(text, {
        parse_mode: 'MarkdownV2',
        reply_markup: { inline_keyboard: keyboard },
      });
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
  text: string;
  keyboard: { text: string; callback_data: string }[][];
} {
  if (claudePid === undefined) {
    return {
      text:
        '🔍 *Background processes*\n\n' +
        '_No active PTY session for this chat\\._\n\n' +
        'In SDK mode, use /tasks to inspect tracked background tasks\\.',
      keyboard: [],
    };
  }
  if (procs.length === 0) {
    // Cross-pointer to /tasks when SDK-tracked tasks (agents, monitors) are
    // running but no OS shells are.
    const taskCount = getActiveTasks(sessionKey).length;
    const lines = ['🔍 *Background processes*', '', 'None running\\.'];
    if (taskCount > 0) {
      const noun = taskCount === 1 ? 'task' : 'tasks';
      lines.push('');
      lines.push(`_🔄 ${taskCount} SDK ${noun} still running — see /tasks\\._`);
    }
    return {
      text: lines.join('\n'),
      keyboard: [[{ text: '🔄 Refresh', callback_data: 'shells:refresh' }]],
    };
  }

  const lines: string[] = [`🔍 *Background processes* \\(${procs.length}\\)`, ''];
  procs.forEach((p, i) => {
    lines.push(`*${i + 1}\\.* \\[${esc(formatBgAge(p.ageSec))}\\] pid \`${esc(String(p.pid))}\``);
    lines.push(`\`${esc(truncateBgCmd(unwrapBgCmd(p.cmd)))}\``);
    lines.push('');
  });
  lines.push('_Tap a number to SIGTERM that process \\(and its descendants\\)\\._');

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
  return { text: lines.join('\n'), keyboard };
}

async function rerenderBg(ctx: Context, sessionKey: string, claudePid: number | undefined): Promise<void> {
  // Brief grace period so killed processes drop out of /proc before we re-read.
  await new Promise((r) => setTimeout(r, 200));
  const procs = claudePid !== undefined ? getBgProcesses(claudePid) : [];
  const { text, keyboard } = renderBgList(sessionKey, claudePid, procs);
  try {
    await ctx.editMessageText(text, {
      parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: keyboard },
    });
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
  const { text, keyboard } = renderBgList(keyInfo.sessionKey, claudePid, procs);
  await ctx.reply(text, {
    parse_mode: 'MarkdownV2',
    reply_markup: { inline_keyboard: keyboard },
  });
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
