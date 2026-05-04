/**
 * Terminal-style rendering for Telegram messages.
 * Provides emoji icons, spinners, and progress indicators for a terminal-like experience.
 */

import { formatDuration } from '../utils/agent-timer.js';
import { config } from '../config.js';

// Tool icons (emoji-based for mobile friendliness)
export const TOOL_ICONS: Record<string, string> = {
  // File operations
  Read: '📖',
  Write: '✏️',
  Edit: '🔧',

  // Search and navigation
  Grep: '🔍',
  Glob: '📁',

  // Execution
  Bash: '💻',
  Task: '📋',
  Skill: '🛠️',
  TodoWrite: '📝',

  // Web
  WebFetch: '🌐',
  WebSearch: '🔎',

  // Notebook
  NotebookEdit: '📓',

  // Status indicators
  thinking: '💭',
  complete: '✅',
  error: '❌',
  warning: '⚠️',
  info: 'ℹ️',
};

// Spinner frames. Telegram throttles edits to ~5/min, so a fast-cycling braille
// spinner just looks static. An hourglass is clearer at slow refresh rates.
export const SPINNER_FRAMES = ['⏳'];

// Progress bar characters
export const PROGRESS = {
  empty: '░',
  filled: '█',
  partial: '▓',
};

/**
 * Get icon for a tool name
 */
export function getToolIcon(toolName: string): string {
  return TOOL_ICONS[toolName] || '🔹';
}

/**
 * Get current spinner frame based on index
 */
export function getSpinnerFrame(index: number): string {
  return SPINNER_FRAMES[index % SPINNER_FRAMES.length];
}

/**
 * Render a status line showing current operation
 * Example: "⠹ 📖 Reading src/config.ts... [1m 12s]"
 */
export function renderStatusLine(
  spinnerIndex: number,
  icon: string,
  operation: string,
  detail?: string,
  elapsedMs?: number,
  pausedMs?: number
): string {
  const spinner = getSpinnerFrame(spinnerIndex);
  const detailStr = detail ? ` ${detail}` : '';
  const timerStr = elapsedMs !== undefined && elapsedMs >= 5000
    ? ` [${formatDuration(elapsedMs)}]`
    : '';
  const pausedStr = pausedMs !== undefined && pausedMs > 0
    ? ` ⏸️ paused ${formatDuration(pausedMs)} (Telegram rate limit)`
    : '';
  return `${spinner} ${icon} ${operation}${detailStr}${timerStr}${pausedStr}`;
}

/**
 * Render a progress bar
 * Example: "[████████░░░░] 67%"
 */
export function renderProgressBar(percent: number, width: number = 12): string {
  const clampedPercent = Math.max(0, Math.min(100, percent));
  const filledCount = Math.round((clampedPercent / 100) * width);
  const emptyCount = width - filledCount;

  const filled = PROGRESS.filled.repeat(filledCount);
  const empty = PROGRESS.empty.repeat(emptyCount);

  return `[${filled}${empty}] ${Math.round(clampedPercent)}%`;
}

/**
 * Render a tool operation status
 * Example: "📖 Read → src/config.ts"
 */
export function renderToolOperation(toolName: string, detail?: string): string {
  const icon = getToolIcon(toolName);
  const action = getToolAction(toolName);
  const detailStr = detail ? ` → ${detail}` : '';
  return `${icon} ${action}${detailStr}`;
}

/**
 * Get human-readable action name for a tool
 */
function getToolAction(toolName: string): string {
  const actions: Record<string, string> = {
    Read: 'Reading',
    Write: 'Writing',
    Edit: 'Editing',
    Bash: 'Running',
    Grep: 'Searching',
    Glob: 'Finding',
    Task: 'Task',
    WebFetch: 'Fetching',
    WebSearch: 'Searching',
    NotebookEdit: 'Editing notebook',
  };
  return actions[toolName] || toolName;
}

/**
 * Extract a meaningful detail from tool input for display
 */
export function extractToolDetail(toolName: string, input: Record<string, unknown>): string | undefined {
  const str = (key: string): string | undefined => {
    const val = input[key];
    return typeof val === 'string' ? val : undefined;
  };

  const verbose = config.TERMINAL_UI_VERBOSE;

  switch (toolName) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return verbose ? str('file_path') : truncatePath(str('file_path'));
    case 'Bash':
      return verbose ? extractFirstLine(str('command')) : truncateCommand(str('command'));
    case 'Grep':
      return str('pattern');
    case 'Glob':
      return str('pattern');
    case 'WebFetch':
    case 'WebSearch':
      return verbose ? (str('url') || str('query')) : truncateUrl(str('url') || str('query'));
    case 'Task':
      return verbose ? str('description') : truncateCommand(str('description'));
    default:
      return undefined;
  }
}

/**
 * Extract the first line of a command (no length limit)
 */
function extractFirstLine(command: string | undefined): string | undefined {
  if (!command) return undefined;
  return command.split('\n')[0].trim();
}

/**
 * Truncate a file path for display
 */
function truncatePath(filePath: string | undefined, maxLen: number = 40): string | undefined {
  if (!filePath) return undefined;
  if (filePath.length <= maxLen) return filePath;

  // Keep the last part of the path
  const parts = filePath.split('/');
  let result = parts[parts.length - 1];

  // Truncate filename itself if it exceeds maxLen
  if (result.length > maxLen) {
    return result.substring(0, maxLen - 3) + '...';
  }

  // Add parent dirs if space allows
  for (let i = parts.length - 2; i >= 0; i--) {
    const candidate = `.../${parts.slice(i).join('/')}`;
    if (candidate.length <= maxLen) {
      result = candidate;
    } else {
      break;
    }
  }

  return result;
}

/**
 * Truncate a command for display
 */
function truncateCommand(command: string | undefined, maxLen: number = 50): string | undefined {
  if (!command) return undefined;
  const firstLine = command.split('\n')[0].trim();
  if (firstLine.length <= maxLen) return firstLine;
  return firstLine.substring(0, maxLen - 3) + '...';
}

/**
 * Truncate a URL for display
 */
function truncateUrl(url: string | undefined, maxLen: number = 40): string | undefined {
  if (!url) return undefined;
  if (url.length <= maxLen) return url;
  return url.substring(0, maxLen - 3) + '...';
}

/**
 * Render a compact background-task footer for the streaming status block.
 * - 0 tasks: empty string (caller can unconditionally append).
 * - 1 task: "🔄 Running in background: <description>" (truncated).
 * - N tasks: "🔄 N tasks running in background".
 */
export function renderBackgroundFooter(tasks: Array<{ description: string }>): string {
  if (tasks.length === 0) return '';
  if (tasks.length === 1) {
    const desc = tasks[0].description;
    const truncated = desc.length > 60 ? desc.substring(0, 57) + '...' : desc;
    return `🔄 Running in background: ${truncated}`;
  }
  return `🔄 ${tasks.length} tasks running in background`;
}

/**
 * Render a background task status line
 * Example: "📋 Background: Installing dependencies ✅"
 */
export function renderBackgroundTask(
  name: string,
  status: 'running' | 'complete' | 'error',
  spinnerIndex: number = 0
): string {
  const statusIcon = status === 'complete'
    ? TOOL_ICONS.complete
    : status === 'error'
      ? TOOL_ICONS.error
      : getSpinnerFrame(spinnerIndex);
  return `📋 Background: ${name} ${statusIcon}`;
}

/**
 * Format a terminal-style message with optional status and background tasks
 */
export function formatTerminalMessage(
  content: string,
  options: {
    spinnerIndex?: number;
    currentOperation?: { icon: string; name: string; detail?: string };
    backgroundTasks?: Array<{ name: string; status: 'running' | 'complete' | 'error' }>;
    isComplete?: boolean;
  } = {}
): string {
  const { spinnerIndex = 0, currentOperation, backgroundTasks = [], isComplete = false } = options;

  const parts: string[] = [];

  // Add status line if there's a current operation and not complete
  if (currentOperation && !isComplete) {
    parts.push(renderStatusLine(
      spinnerIndex,
      currentOperation.icon,
      currentOperation.name,
      currentOperation.detail
    ));
    parts.push('');
  }

  // Add main content
  if (content) {
    parts.push(content);
  }

  // Add background tasks if any
  if (backgroundTasks.length > 0) {
    if (content) parts.push('');
    for (const task of backgroundTasks) {
      parts.push(renderBackgroundTask(task.name, task.status, spinnerIndex));
    }
  }

  return parts.join('\n');
}
