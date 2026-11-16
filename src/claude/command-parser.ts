import { config } from '../config.js';
import { hasGuestUsers } from '../utils/admins.js';
import { isCheckout } from '../utils/install-mode.js';
import { EntityText, type EntityMessage } from '../telegram/entities.js';

export interface ParsedCommand {
  command: string | null;
  args: string;
  model: string | null;
}

const CLAUDE_COMMANDS = ['plan', 'explore', 'model', 'commands', 'loop', 'resume', 'continue', 'sessions', 'provider'] as const;
type ClaudeCommand = (typeof CLAUDE_COMMANDS)[number];

export function parseClaudeCommand(message: string): ParsedCommand {
  const trimmed = message.trim();

  // Check if message starts with a slash command
  if (!trimmed.startsWith('/')) {
    return { command: null, args: trimmed, model: null };
  }

  const firstSpace = trimmed.indexOf(' ');
  const commandPart = firstSpace === -1 ? trimmed.slice(1) : trimmed.slice(1, firstSpace);
  const args = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim();

  // Check if it's a Claude command
  if (CLAUDE_COMMANDS.includes(commandPart as ClaudeCommand)) {
    return { command: commandPart, args, model: null };
  }

  // Not a recognized Claude command - return as regular message
  return { command: null, args: trimmed, model: null };
}

export function isClaudeCommand(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed.startsWith('/')) return false;

  const firstSpace = trimmed.indexOf(' ');
  const commandPart = firstSpace === -1 ? trimmed.slice(1) : trimmed.slice(1, firstSpace);

  return CLAUDE_COMMANDS.includes(commandPart as ClaudeCommand);
}

/**
 * Telegram appends `@BotName` to slash commands sent in group chats
 * (`/compact@MyBot`, `/compact@MyBot keep the plan`). Strip the mention off the
 * leading command token so downstream command detection — and the PTY TUI,
 * which would otherwise type `/compact@MyBot` verbatim — see a clean `/compact`.
 * Only touches a genuine `/word@word` command token; leaves ordinary messages
 * (and slash-prefixed paths like `/some/path@host`) untouched.
 */
export function stripCommandBotMention(text: string): string {
  const m = text.match(/^\/(\w+)@\w+(\s[\s\S]*)?$/);
  return m ? '/' + m[1] + (m[2] ?? '') : text;
}

/**
 * True if `text` is the native Claude Code `/compact` slash command (optionally
 * with a `@BotName` mention or trailing custom-instructions argument). Single
 * source of truth shared by the SDK interceptor (agent.ts) and the PTY provider
 * so both agree on what counts as a manual compaction request.
 */
export function isNativeCompactCommand(text: string): boolean {
  return /^\/compact(?:@\w+)?(?:\s|$)/.test(text.trim());
}

/**
 * The /commands list. Each line is written with `backticks` around what shows
 * as code; section titles go out bold.
 */
export function getAvailableCommands(): EntityMessage {
  // Only worth saying on a bot that actually has guests — on a solo bot every
  // user is an admin, so the tag would mark every line without narrowing
  // anything.
  const adminTag = hasGuestUsers() ? ' (admin)' : '';
  // Opening an auto-approve window sits with the people who answer prompts,
  // which is a wider set than the people who own the bot.
  const approverTag = hasGuestUsers() ? ' (admin / approver)' : '';
  const sections: Array<{ title: string; commands: string[] }> = [
    {
      title: 'Claude Commands',
      commands: [
        '• `/plan <task>` - Enter plan mode for complex tasks',
        '• `/explore <question>` - Use explore agent for codebase questions',
        '• `/loop <task>` - Run iteratively until task complete',
        '• `/model [name]` - Show or set AI model',
        "• `/later [text]` - Set an idea aside, and be asked about it after Claude's turn",
        '• `/steer <text>` - Stop the running turn and send this in its place',
        ...(config.CCR_ENABLED ? [`• \`/provider\` - Switch AI provider (Claude / CCR)${adminTag}`] : []),
        '• `/commands` - Show this list',
      ],
    },
    {
      title: 'Session Commands',
      commands: [
        '• `/project <path>` - Set working directory',
        '• `/newproject <name>` - Create a new project',
        '• `/newbot [project]` - Create a bot for a project, named after it and starting in it',
        '• `/resume` - Pick from recent sessions to resume',
        '• `/continue` - Resume most recent session',
        '• `/sessions` - List all sessions',
        '• `/teleport` - Move session to terminal (forked)',
        '• `/clear` - Clear session and start fresh',
        '• `/status` - Show current session info',
        '• `/fork` - Fork current conversation to another bot',
        '• `/spinoff <task>` - Split a task off into a new thread, compacted around it (as a reply: from that message)',
        '• `/deletethread` - Delete this thread and its messages, and end its session',
        '• `/tree` - Show where this conversation branched, and jump between branches',
        '• `/accept` - Accept a pending fork from another bot',
        '• `/decline` - Discard a pending fork',
      ],
    },
    {
      title: 'File Commands',
      commands: [
        '• `/file <path>` - Download a file from project',
      ],
    },
  ];

  const mediaCommands: string[] = [];
  if (config.TRANSCRIBE_ENABLED) {
    mediaCommands.push('• `/transcribe` - Transcribe audio to text (reply to voice/audio, or ForceReply)');
  }
  if (config.TTS_ENABLED) {
    mediaCommands.push('• `/tts` - Toggle voice replies');
  }
  if (mediaCommands.length > 0) {
    sections.push({ title: 'Media Commands', commands: mediaCommands });
  }

  sections.push({
    title: 'Bot Commands',
    commands: [
      '• `/context` - Show Claude context usage',
      '• `/cost` - Show usage limits and cost from Claude Code',
      '• `/compact` - Compact the context window (reports the token reduction)',
      '• `/botstatus` - Show bot process status',
      '• `/version` - Show the running version and whether it\'s the latest',
      `• \`/restartbot\` - Restart the bot process${adminTag}`,
      ...(isCheckout()
        ? [`• \`/rebuildbot\` - Rebuild and restart with auto-resume; \`/rebuildbot idle\` waits for each bot to finish first${adminTag}`]
        : []),
      '• `/ping` - Check if bot is responsive',
      '• `/cancel` - Stop the current request and drop anything queued',
      '• `/mode` - How much Claude asks before acting',
      `• \`/autoapprove [30m|off|status]\` - Let the gate approve instead of asking, for a while${approverTag}`,
      '• `/streaming` - Toggle streaming / wait replies',
      '• `/verbosity` - Pick verbosity tier (quiet / normal / verbose / debug)',
      '• `/terminalui` - Toggle terminal-style display',
      '• `/botname <name>` - Rename the bot (admins)',
      '• `/topic <text>` - Set current work topic in bot name',
    ],
  });

  sections.push({
    title: 'Claude Code Commands',
    commands: [
      'Claude Code\'s own slash commands pass straight through — `/code-review`,',
      '`/security-review`, `/simplify`, `/init`, `/run` and any `.claude/commands/`',
      'command all work by typing them here.',
      '',
      '⚠️ Where a bot command shares the name, the bot wins — `/loop` and',
      '`/schedule` are TeleCoder\'s, not Claude Code\'s. The overlap shifts with',
      'each Claude Code release, so `/projectcommands` reports the current one.',
      '',
      '• `/projectcommands` - List everything this project offers, shadowing included',
    ],
  });

  sections.push({
    title: 'Group Access',
    commands: [
      '• `/members` - Show who may prompt the agent in this group',
      '• `/allow` - Let someone prompt the agent here (reply to them, or pass @handle / id)',
      '• `/deny` - Make someone a spectator here (admin only)',
    ],
  });

  const b = new EntityText();
  sections.forEach((section, i) => {
    if (i > 0) b.newline(2);
    b.bold(`${section.title}:`).newline(2);
    section.commands.forEach((line, j) => {
      if (j > 0) b.newline();
      // Odd segments between backticks are code.
      line.split('`').forEach((segment, k) => (k % 2 === 1 ? b.code(segment) : b.add(segment)));
    });
  });
  return b.build();
}

/**
 * Command names TeleCoder registers with grammY that do NOT reach Claude Code,
 * recorded as they register (see the `cmd()` wrapper in `bot.ts`).
 *
 * A bot command wins over the native Claude Code command of the same name:
 * grammY matches it first and the text never reaches the agent. `/loop` and
 * `/schedule` are TeleCoder's own features rather than Claude Code's skills of
 * those names, and `/model` answers about the bot's state rather than the
 * CLI's. Keeping the list live rather than hand-maintained means
 * `/projectcommands` names the shadowed commands accurately — the overlap
 * shifts with every Claude Code release.
 *
 * `forwardsToAgent` marks the exception: a name registered only so grammY
 * routes it (and its group-chat `@BotName` form) into the normal message
 * pipeline, which hands it to Claude Code unchanged. `/compact` is one. Those
 * are not shadowed and must not be reported as such.
 */
const registeredBotCommands = new Set<string>();
const forwardedBotCommands = new Set<string>();

export function registerBotCommandName(name: string, forwardsToAgent = false): void {
  if (forwardsToAgent) {
    registeredBotCommands.delete(name);
    forwardedBotCommands.add(name);
    return;
  }
  registeredBotCommands.add(name);
}

/** Names registered only to route into the agent, `/compact` among them. */
export function getForwardedCommandNames(): ReadonlySet<string> {
  return forwardedBotCommands;
}

/** Names that shadow a same-named Claude Code command. */
export function getBotCommandNames(): ReadonlySet<string> {
  return registeredBotCommands;
}
