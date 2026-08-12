/**
 * Terminal-style rendering for Telegram messages.
 * Provides emoji icons, spinners, and progress indicators for a terminal-like experience.
 */

import { formatDuration } from '../utils/agent-timer.js';

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

  // TeleCoder MCP tools — keys are the SDK-reported full names so
  // updateToolOperation/getToolIcon match without any extra normalization.
  'mcp__claudegram-tools__claudegram_ask_user': '❓',
  'mcp__claudegram-tools__claudegram_set_topic': '🏷️',
  'mcp__claudegram-tools__claudegram_send_file': '📎',
  'mcp__claudegram-tools__claudegram_fetch_reddit': '🔴',
  'mcp__claudegram-tools__claudegram_fetch_medium': '📰',
  'mcp__claudegram-tools__claudegram_extract_media': '🎬',
  'mcp__claudegram-tools__claudegram_list_projects': '📂',
  'mcp__claudegram-tools__claudegram_switch_project': '🔀',
  'mcp__claudegram-tools__publish_telegraph': '📄',

  // Status indicators
  thinking: '💭',
  complete: '✅',
  error: '❌',
  warning: '⚠️',
  info: 'ℹ️',
};

/**
 * Strip the `mcp__<server>__` prefix from a tool name so it can be displayed
 * concisely (e.g. `mcp__claudegram-tools__claudegram_ask_user` → `claudegram_ask_user`).
 * Returns the original name when no prefix is present.
 */
function stripMcpPrefix(toolName: string): string {
  if (!toolName.startsWith('mcp__')) return toolName;
  const lastSep = toolName.lastIndexOf('__');
  return lastSep > 0 ? toolName.slice(lastSep + 2) : toolName;
}

// Spinner frames. Telegram throttles edits to ~5/min, so a fast-cycling braille
// spinner just looks static. An hourglass is clearer at slow refresh rates.
export const SPINNER_FRAMES = ['⏳'];

// Claude Code's TUI spinner verbs, extracted verbatim from the CLI binary
// (v2.1.168 — 187 entries). A random one is shown while Claude works, then
// re-rolled on each refresh so it cycles over a turn.
export const THINKING_VERBS = [
  'Accomplishing',
  'Actioning',
  'Actualizing',
  'Architecting',
  'Baking',
  'Beaming',
  'Beboppin\'',
  'Befuddling',
  'Billowing',
  'Blanching',
  'Bloviating',
  'Boogieing',
  'Boondoggling',
  'Booping',
  'Bootstrapping',
  'Brewing',
  'Bunning',
  'Burrowing',
  'Calculating',
  'Canoodling',
  'Caramelizing',
  'Cascading',
  'Catapulting',
  'Cerebrating',
  'Channeling',
  'Channelling',
  'Choreographing',
  'Churning',
  'Clauding',
  'Coalescing',
  'Cogitating',
  'Combobulating',
  'Composing',
  'Computing',
  'Concocting',
  'Considering',
  'Contemplating',
  'Cooking',
  'Crafting',
  'Creating',
  'Crunching',
  'Crystallizing',
  'Cultivating',
  'Deciphering',
  'Deliberating',
  'Determining',
  'Dilly-dallying',
  'Discombobulating',
  'Doing',
  'Doodling',
  'Drizzling',
  'Ebbing',
  'Effecting',
  'Elucidating',
  'Embellishing',
  'Enchanting',
  'Envisioning',
  'Evaporating',
  'Fermenting',
  'Fiddle-faddling',
  'Finagling',
  'Flambéing',
  'Flibbertigibbeting',
  'Flowing',
  'Flummoxing',
  'Fluttering',
  'Forging',
  'Forming',
  'Frolicking',
  'Frosting',
  'Gallivanting',
  'Galloping',
  'Garnishing',
  'Generating',
  'Gesticulating',
  'Germinating',
  'Gitifying',
  'Grooving',
  'Gusting',
  'Harmonizing',
  'Hashing',
  'Hatching',
  'Herding',
  'Honking',
  'Hullaballooing',
  'Hyperspacing',
  'Ideating',
  'Imagining',
  'Improvising',
  'Incubating',
  'Inferring',
  'Infusing',
  'Ionizing',
  'Jitterbugging',
  'Julienning',
  'Kneading',
  'Leavening',
  'Levitating',
  'Lollygagging',
  'Manifesting',
  'Marinating',
  'Meandering',
  'Metamorphosing',
  'Misting',
  'Moonwalking',
  'Moseying',
  'Mulling',
  'Mustering',
  'Musing',
  'Nebulizing',
  'Nesting',
  'Newspapering',
  'Noodling',
  'Nucleating',
  'Orbiting',
  'Orchestrating',
  'Osmosing',
  'Perambulating',
  'Percolating',
  'Perusing',
  'Philosophising',
  'Photosynthesizing',
  'Pollinating',
  'Pondering',
  'Pontificating',
  'Pouncing',
  'Precipitating',
  'Prestidigitating',
  'Processing',
  'Proofing',
  'Propagating',
  'Puttering',
  'Puzzling',
  'Quantumizing',
  'Razzle-dazzling',
  'Razzmatazzing',
  'Recombobulating',
  'Reticulating',
  'Roosting',
  'Ruminating',
  'Sautéing',
  'Scampering',
  'Schlepping',
  'Scurrying',
  'Seasoning',
  'Shenaniganing',
  'Shimmying',
  'Simmering',
  'Skedaddling',
  'Sketching',
  'Slithering',
  'Smooshing',
  'Sock-hopping',
  'Spelunking',
  'Spinning',
  'Sprouting',
  'Stewing',
  'Sublimating',
  'Swirling',
  'Swooping',
  'Symbioting',
  'Synthesizing',
  'Tempering',
  'Thinking',
  'Thundering',
  'Tinkering',
  'Tomfoolering',
  'Topsy-turvying',
  'Transfiguring',
  'Transmuting',
  'Twisting',
  'Undulating',
  'Unfurling',
  'Unravelling',
  'Vibing',
  'Waddling',
  'Wandering',
  'Warping',
  'Whatchamacalliting',
  'Whirlpooling',
  'Whirring',
  'Whisking',
  'Wibbling',
  'Working',
  'Wrangling',
  'Zesting',
  'Zigzagging',
];

// Progress bar characters
export const PROGRESS = {
  empty: '░',
  filled: '█',
  partial: '▓',
};

/**
 * Get icon for a tool name. MCP tools without an explicit entry fall back
 * to a generic 🛠️ so they're visually distinct from built-in tools (🔹).
 */
export function getToolIcon(toolName: string): string {
  const explicit = TOOL_ICONS[toolName];
  if (explicit) return explicit;
  if (toolName.startsWith('mcp__')) return '🛠️';
  return '🔹';
}

/**
 * Get current spinner frame based on index
 */
export function getSpinnerFrame(index: number): string {
  return SPINNER_FRAMES[index % SPINNER_FRAMES.length];
}

/**
 * Get a random thinking verb.
 */
export function getThinkingVerb(): string {
  return THINKING_VERBS[Math.floor(Math.random() * THINKING_VERBS.length)];
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
  const detailStr = detail ? ` → ${detail}` : '';
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
 * Get human-readable action name for a tool.
 * For MCP tools: explicit map first, then fall back to the de-prefixed
 * name (e.g. `mcp__foo__bar_baz` → `bar_baz`) so the rendered status line
 * stays short instead of dumping the full server-prefixed identifier.
 */
export function getToolAction(toolName: string): string {
  const actions: Record<string, string> = {
    Read: 'Reading',
    Write: 'Writing',
    Edit: 'Editing',
    Bash: 'Running',
    Grep: 'Searching',
    Glob: 'Finding files',
    Task: 'Running task',
    Skill: 'Running skill',
    TodoWrite: 'Todos',
    WebFetch: 'Fetching',
    WebSearch: 'Searching web',
    NotebookEdit: 'Editing notebook',
    'mcp__claudegram-tools__claudegram_ask_user': 'Asking',
    'mcp__claudegram-tools__claudegram_set_topic': 'Setting topic',
    'mcp__claudegram-tools__claudegram_send_file': 'Sending file',
    'mcp__claudegram-tools__claudegram_fetch_reddit': 'Fetching Reddit',
    'mcp__claudegram-tools__claudegram_fetch_medium': 'Fetching Medium',
    'mcp__claudegram-tools__claudegram_extract_media': 'Extracting media',
    'mcp__claudegram-tools__claudegram_list_projects': 'Listing projects',
    'mcp__claudegram-tools__claudegram_switch_project': 'Switching project',
    'mcp__claudegram-tools__publish_telegraph': 'Publishing Telegraph',
  };
  if (actions[toolName]) return actions[toolName];
  if (toolName.startsWith('mcp__')) return stripMcpPrefix(toolName);
  return toolName;
}

/**
 * Extract a meaningful detail from tool input for display.
 * Caller controls truncation via the `verbose` flag (resolved per-chat by
 * the verbosity tier in `utils/verbosity.ts`).
 */
export function extractToolDetail(toolName: string, input: Record<string, unknown>, verbose: boolean): string | undefined {
  const str = (key: string): string | undefined => {
    const val = input[key];
    return typeof val === 'string' ? val : undefined;
  };

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
    case 'Agent': // subagent tool — renamed Task→Agent in newer Claude Code builds
      return verbose ? str('description') : truncateCommand(str('description'));
    case 'mcp__claudegram-tools__claudegram_ask_user':
      return verbose ? str('question') : truncateCommand(str('question'));
    case 'mcp__claudegram-tools__claudegram_set_topic':
      return str('topic');
    case 'mcp__claudegram-tools__claudegram_send_file':
      return verbose ? str('file_path') : truncatePath(str('file_path'));
    case 'mcp__claudegram-tools__claudegram_fetch_reddit':
      return str('target');
    case 'mcp__claudegram-tools__claudegram_fetch_medium':
      return verbose ? str('url') : truncateUrl(str('url'));
    case 'mcp__claudegram-tools__claudegram_extract_media':
      return verbose ? str('url') : truncateUrl(str('url'));
    case 'mcp__claudegram-tools__claudegram_switch_project':
      return str('project_name');
    case 'mcp__claudegram-tools__publish_telegraph':
      return str('title');
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

// Caps for the live Bash command block (terminal UI). While a command runs,
// this block is the user's only window into what's executing, so we show the
// command in full rather than just its first line. Non-verbose applies a tight
// readability cap; verbose only truncates at a high failsafe ceiling — well
// under Telegram's 4096-char message limit, leaving room for the status header
// and background-task footer that share the message. Either way, long commands
// are elided in the MIDDLE so the leading setup (e.g. `cd …`) and the trailing
// work the command is actually spending time on both stay visible.
const BASH_BLOCK_CAP_COMPACT = 300;
const BASH_BLOCK_CAP_VERBOSE = 3500;

/**
 * Format a Bash command for the live status block. Newlines are preserved so
 * the command reads like a shell paste; the result is capped per the `verbose`
 * flag with a middle ellipsis when it exceeds the cap. Returns undefined for
 * empty/whitespace input (so callers can omit the block entirely).
 */
export function formatBashCommandBlock(command: string | undefined, verbose: boolean): string | undefined {
  if (!command) return undefined;
  const trimmed = command.trim();
  if (!trimmed) return undefined;
  const cap = verbose ? BASH_BLOCK_CAP_VERBOSE : BASH_BLOCK_CAP_COMPACT;
  if (trimmed.length <= cap) return trimmed;
  return elideMiddle(trimmed, cap);
}

/**
 * Truncate `text` to at most `maxLen` chars by dropping the middle and
 * inserting an ellipsis marker, keeping ~60% head and ~40% tail.
 */
function elideMiddle(text: string, maxLen: number): string {
  const marker = '\n  …\n';
  if (maxLen <= marker.length) return text.slice(0, maxLen);
  const budget = maxLen - marker.length;
  const headLen = Math.ceil(budget * 0.6);
  const tailLen = budget - headLen;
  return text.slice(0, headLen).trimEnd() + marker + text.slice(text.length - tailLen).trimStart();
}

/**
 * Remove ANSI CSI/OSC escape sequences from tool output.
 *
 * The ESC byte is non-printing, so an unstripped sequence does not merely look
 * wrong in Telegram's plain-text view — the client swallows the ESC and renders
 * the remainder as a literal `[1m`. The bytes also count against the caller's
 * truncation budget, so colourised output loses most of its char cap to codes
 * the reader never sees.
 *
 * Written with `\x1b`/`\x07` escapes rather than literal control bytes on
 * purpose: if a raw ESC is ever lost in transit, `\x1b\][^\x07]*` degrades to
 * `\][^]*`, which matches everything after the first `]` and silently shreds
 * output instead of failing loudly.
 */
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/**
 * Truncate tool/command output for display (action log + inline tool-result
 * posts), bounded by both a line cap and a char cap.
 *
 * Unlike command *input*, output truncation is direction-sensitive and keyed on
 * `isError`. Errors, test summaries and result lines land at the END of output,
 * so error output is TAIL-biased (~1/3 head, ~2/3 tail) — plain head-only
 * truncation drops exactly what the reader needs. Successful output is
 * HEAD-biased (~2/3 head, ~1/3 tail): you usually want the start (a file dump,
 * an `ls`), but the trailing slice still preserves a final summary line. Either
 * way a `[+N more lines]` marker sits between head and tail. The char cap is a
 * secondary guard (e.g. one very long line) and also elides toward the middle
 * with the same bias so the important side survives. The marker is embedded
 * inline — the caller appends no separate trailer.
 */
export function elideToolOutput(
  content: string,
  maxLines: number,
  maxChars: number,
  opts: { isError?: boolean } = {},
): string {
  // Fraction of the budget given to the head. Errors lean tail; success leans head.
  const headFraction = opts.isError ? 1 / 3 : 2 / 3;
  let text = content;

  const lines = text.split('\n');
  if (lines.length > maxLines) {
    if (maxLines >= 3) {
      const budget = maxLines - 1; // reserve one line for the marker
      const headCount = Math.min(budget - 1, Math.max(1, Math.round(budget * headFraction)));
      const tailCount = budget - headCount;
      const hidden = lines.length - headCount - tailCount;
      text = [
        ...lines.slice(0, headCount),
        `[+${hidden} more lines]`,
        ...lines.slice(lines.length - tailCount),
      ].join('\n');
    } else {
      // Too few lines allowed to bother with a head — keep whichever side the
      // bias favors (tail for errors, head for success).
      const keep = Math.max(1, maxLines - 1);
      const slice = opts.isError ? lines.slice(lines.length - keep) : lines.slice(0, keep);
      const marker = `[+${lines.length - slice.length} more lines]`;
      text = (opts.isError ? [marker, ...slice] : [...slice, marker]).join('\n');
    }
  }

  if (text.length > maxChars) {
    const marker = '\n[chars truncated]\n';
    if (maxChars <= marker.length) {
      text = opts.isError ? text.slice(text.length - maxChars) : text.slice(0, maxChars);
    } else {
      const budget = maxChars - marker.length;
      const headLen = Math.round(budget * headFraction);
      const tailLen = budget - headLen;
      text = text.slice(0, headLen).trimEnd() + marker + text.slice(text.length - tailLen).trimStart();
    }
  }

  return text;
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
