import { config } from '../config.js';

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

// Returns MarkdownV2 escaped command list
export function getAvailableCommands(): string {
  const sections: Array<{ title: string; commands: string[] }> = [
    {
      title: 'Claude Commands',
      commands: [
        '• `/plan <task>` \\- Enter plan mode for complex tasks',
        '• `/explore <question>` \\- Use explore agent for codebase questions',
        '• `/loop <task>` \\- Run iteratively until task complete',
        '• `/model \\[name\\]` \\- Show or set AI model',
        ...(config.CCR_ENABLED ? ['• `/provider` \\- Switch AI provider \\(Claude / CCR\\)'] : []),
        '• `/commands` \\- Show this list',
      ],
    },
    {
      title: 'Session Commands',
      commands: [
        '• `/project <path>` \\- Set working directory',
        '• `/newproject <name>` \\- Create a new project',
        '• `/resume` \\- Pick from recent sessions to resume',
        '• `/continue` \\- Resume most recent session',
        '• `/sessions` \\- List all sessions',
        '• `/teleport` \\- Move session to terminal \\(forked\\)',
        '• `/clear` \\- Clear session and start fresh',
        '• `/status` \\- Show current session info',
        '• `/fork` \\- Fork current conversation to another bot',
        '• `/accept` \\- Accept a pending fork from another bot',
        '• `/decline` \\- Discard a pending fork',
      ],
    },
    {
      title: 'File Commands',
      commands: [
        '• `/file <path>` \\- Download a file from project',
        '• `/telegraph <path>` \\- View markdown with Instant View',
      ],
    },
  ];

  const redditCommands: string[] = [];
  if (config.REDDIT_ENABLED) {
    redditCommands.push('• `/reddit <target>` \\- Fetch Reddit posts, subreddits, or user profiles');
  }
  if (config.VREDDIT_ENABLED) {
    redditCommands.push('• `/vreddit <url>` \\- Download Reddit\\-hosted video from a post URL');
  }
  if (redditCommands.length > 0) {
    sections.push({ title: 'Reddit Commands', commands: redditCommands });
  }

  if (config.MEDIUM_ENABLED) {
    sections.push({
      title: 'Medium Commands',
      commands: ['• `/medium <url>` \\- Fetch Medium article with images'],
    });
  }

  const mediaCommands: string[] = [];
  if (config.EXTRACT_ENABLED) {
    mediaCommands.push('• `/extract <url>` \\- Extract text/audio/video from YouTube, Instagram, TikTok');
  }
  if (config.TRANSCRIBE_ENABLED) {
    mediaCommands.push('• `/transcribe` \\- Transcribe audio to text \\(reply to voice/audio, or ForceReply\\)');
  }
  if (mediaCommands.length > 0) {
    sections.push({ title: 'Media Commands', commands: mediaCommands });
  }

  sections.push({
    title: 'Bot Commands',
    commands: [
      '• `/tts` \\- Toggle voice replies',
      '• `/context` \\- Show Claude context usage',
      '• `/compact` \\- Compact the context window \\(PTY mode; reports the token reduction\\)',
      '• `/botstatus` \\- Show bot process status',
      '• `/restartbot` \\- Restart the bot process',
      '• `/rebuildbot` \\- Rebuild and restart with auto\\-resume',
      '• `/ping` \\- Check if bot is responsive',
      '• `/cancel` \\- Cancel current request',
      '• `/mode` \\- Toggle streaming mode',
      '• `/verbosity` \\- Pick verbosity tier \\(quiet / normal / verbose / debug\\)',
      '• `/terminalui` \\- Toggle terminal\\-style display',
      '• `/botname` \\- Toggle dynamic bot name',
      '• `/topic <text>` \\- Set current work topic in bot name',
    ],
  });

  const lines: string[] = [];
  for (const section of sections) {
    lines.push(`*${section.title}:*`, '', ...section.commands, '');
  }

  return lines.join('\n').trimEnd();
}
