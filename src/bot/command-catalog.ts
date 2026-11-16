/**
 * The bot's command catalog: the `/` menu Telegram shows, and the two ways to
 * find a command in it when the menu's prefix filter doesn't help.
 *
 * Telegram's menu filters on the start of the command name only — `/kill`
 * finds nothing, `/task` finds nothing because the command is `/tasks`. So
 * `/commands <words>` searches names and descriptions (`searchCommands`), and
 * a slash command nobody registered is matched against the catalog for a
 * likely typo (`suggestCommands`) before it would otherwise be typed into
 * Claude as a prompt.
 *
 * The menu list lives here rather than in bot.ts so both lookups read the
 * same names and descriptions Telegram shows. `site/scripts/check-commands.mjs`
 * reads the `{ command: '…' }` entries off this file.
 */

import { config } from '../config.js';
import { isCheckout } from '../utils/install-mode.js';
import { EntityText, type EntityMessage } from '../telegram/entities.js';
import { isClaudeCommand } from '../claude/command-parser.js';

export interface CommandMenuEntry {
  command: string;
  description: string;
}

/** The menu Telegram shows for `/`, for this install's configuration. */
export function buildCommandMenu(): CommandMenuEntry[] {
  return [
    { command: 'start', description: '🚀 Show help and getting started' },
    { command: 'project', description: '📁 Set working directory' },
    { command: 'newproject', description: '📁 Create a new project' },
    { command: 'newbot', description: '🤖 Create a bot for a project' },
    { command: 'status', description: '📊 Show current session status' },
    { command: 'clear', description: '🗑️ Clear conversation history' },
    { command: 'cancel', description: '⏹️ Stop the current request and drop anything queued' },
    { command: 'resume', description: '▶️ Resume a session' },
    { command: 'botstatus', description: '🩺 Show bot process status' },
    { command: 'version', description: '🏷️ Show the running version and whether it is the latest' },
    { command: 'restartbot', description: '🔁 Restart the bot' },
    // An npm install has no source to rebuild; /update replaces it instead.
    ...(isCheckout() ? [{ command: 'rebuildbot', description: '🔄 Rebuild and restart with session restore' }] : []),
    { command: 'context', description: '🧠 Show Claude context usage' },
    { command: 'cost', description: '💰 Show usage limits and cost' },
    { command: 'compact', description: '🗜️ Compact the context window' },
    { command: 'update', description: isCheckout() ? '⬆️ Update the Claude Code CLI' : '⬆️ Update TeleCoder or the Claude Code CLI' },
    { command: 'fork', description: '🍴 Fork this conversation to another bot' },
    { command: 'spinoff', description: '🍴 Split a task off into a new thread' },
    { command: 'deletethread', description: '🗑️ Delete this thread and end its session' },
    { command: 'tree', description: '🌳 Show where this conversation branched, and jump between branches' },
    { command: 'accept', description: '📦 Accept a pending fork from another bot' },
    { command: 'decline', description: '🚫 Discard a pending fork' },
    { command: 'recap', description: '📋 Recap last messages of current session' },
    { command: 'prompts', description: '💬 List the prompts you sent, and branch from any of them' },
    { command: 'sync', description: '📨 Resend any missed reply from the session log' },
    { command: 'handoff', description: '📦 Export the session as a markdown handoff document' },
    { command: 'schedule', description: '🔔 Schedule a recurring prompt (e.g. every 1h, daily 9am)' },
    { command: 'schedules', description: '🔔 List active scheduled tasks' },
    { command: 'unschedule', description: '🔕 Remove a scheduled task by id' },
    { command: 'projectcommands', description: '📜 List slash commands from .claude/commands/' },
    { command: 'permissions', description: '🔐 Show the permission-gate state and guarded patterns' },
    { command: 'users', description: '👥 Show who can use this bot' },
    { command: 'allow', description: '✅ Let someone in — reply to them, or /allow @user' },
    { command: 'deny', description: '🚫 Remove someone admitted with /allow' },
    { command: 'members', description: '👥 Show who may prompt the agent in this group' },
    { command: 'teleport', description: '🚀 Move session to terminal' },
    ...(config.TRANSCRIBE_ENABLED ? [{ command: 'transcribe', description: '🎤 Transcribe audio to text' }] : []),
    { command: 'file', description: '📎 Download a file from project' },
    { command: 'suggestions', description: '💡 Toggle predicted next-prompt buttons' },
    { command: 'model', description: '🤖 Switch AI model' },
    { command: 'effort', description: '🎯 Set reasoning effort level' },
    { command: 'verbosity', description: '🎚️ Set verbosity tier (quiet/normal/verbose/debug)' },
    { command: 'method', description: '🛰️ Switch Claude transport (SDK / PTY)' },
    { command: 'btw', description: '💬 Side question without interrupting' },
    { command: 'later', description: '🔔 Set an idea aside for after the turn' },
    { command: 'steer', description: '⚡ Stop the turn and send this instead' },
    { command: 'tasks', description: '🔄 List active background tasks' },
    { command: 'shells', description: '🔍 List & kill background shells (PTY mode)' },
    ...(config.CCR_ENABLED ? [{ command: 'provider', description: '🔌 Switch AI provider' }] : []),
    ...(config.CCR_ENABLED ? [{ command: 'ccr', description: '🔌 Toggle CCR routing (alt providers)' }] : []),
    { command: 'mode', description: '🔐 How much Claude asks before acting' },
    { command: 'autoapprove', description: '⚡ Approve guarded commands for a while' },
    { command: 'terminalui', description: '🖥️ Toggle terminal-style display' },
    { command: 'statusline', description: '📍 Toggle per-turn status line' },
    { command: 'botname', description: '✏️ Rename the bot (admins)' },
    { command: 'topic', description: '💬 Set the conversation topic' },
    ...(config.TTS_ENABLED ? [{ command: 'tts', description: '🔊 Toggle voice replies' }] : []),
    { command: 'ping', description: '🏓 Check if bot is responsive' },
    { command: 'commands', description: '📜 List all commands' },
  ];
}

let catalog: CommandMenuEntry[] = [];

/** Remember the menu as registered, for the lookups below. */
export function setCommandCatalog(entries: CommandMenuEntry[]): void {
  catalog = [...entries];
}

export function getCommandCatalog(): readonly CommandMenuEntry[] {
  return catalog;
}

/** Leading emoji and other symbols off a menu description, lower-cased. */
function plainWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s/.-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Damerau–Levenshtein distance (optimal string alignment): one insertion,
 * deletion, substitution or adjacent swap each count one.
 */
export function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i++) d[i][0] = i;
  for (let j = 0; j < cols; j++) d[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/** How many edits a typo of `token` may be away and still count. */
function typoBudget(token: string): number {
  return token.length >= 5 ? 2 : 1;
}

/**
 * Commands a mistyped `/token` probably meant: a name the token is the start
 * of (`/sched` → `/schedule`, `/schedules`), or one within a couple of edits
 * (`/satus` → `/status`). Closest first, at most `limit`. Names outside the
 * menu (aliases such as `/stop`) come with an empty description.
 */
export function suggestCommands(
  token: string,
  names: Iterable<string>,
  entries: readonly CommandMenuEntry[] = catalog,
  limit = 3,
): CommandMenuEntry[] {
  const typo = token.toLowerCase();
  if (!typo) return [];
  const described = new Map(entries.map((e) => [e.command, e.description]));
  const candidates = new Set([...described.keys(), ...names]);
  const scored: { name: string; score: number }[] = [];
  for (const name of candidates) {
    let score: number | undefined;
    if (name === typo) {
      // Only a case variant gets here (`/Tasks`): the real name was never registered as typed.
      score = -1;
    } else if (typo.length >= 3 && name.startsWith(typo)) {
      // A prefix is the strongest signal; a shorter completion ranks higher.
      score = (name.length - typo.length) / 100;
    } else {
      const d = editDistance(typo, name);
      if (d <= typoBudget(typo)) score = d;
    }
    if (score !== undefined) scored.push({ name, score });
  }
  scored.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  return scored.slice(0, limit).map(({ name }) => ({ command: name, description: described.get(name) ?? '' }));
}

export interface CommandFix {
  /** The command as typed, without the slash. */
  token: string;
  /** Whatever followed it, trimmed. */
  args: string;
  suggestions: CommandMenuEntry[];
}

/**
 * Is `text` a slash command the bot never registered that looks like a typo of
 * one it did? Pure: the caller still has to check Claude Code doesn't know the
 * name either, since anything the bot doesn't own is Claude's to run.
 */
export function findCommandFix(
  text: string,
  opts: {
    botNames: Iterable<string>;
    forwarded: Iterable<string>;
    entries?: readonly CommandMenuEntry[];
  },
): CommandFix | null {
  const m = text.match(/^\/([\w:-]+)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const token = m[1];
  if (isClaudeCommand(text)) return null;
  const names = new Set(opts.botNames);
  if (names.has(token) || new Set(opts.forwarded).has(token)) return null;
  const suggestions = suggestCommands(token, names, opts.entries ?? catalog);
  return suggestions.length ? { token, args: (m[2] ?? '').trim(), suggestions } : null;
}

/**
 * Menu entries matching every word of `query`, by name or description. A
 * word matches a name it is part of, a description word it starts, or either
 * within one edit when the word is long enough for that to mean something.
 * Name matches rank above description matches.
 */
export function searchCommands(
  query: string,
  entries: readonly CommandMenuEntry[] = catalog,
): CommandMenuEntry[] {
  const terms = plainWords(query.replace(/^\//, ''));
  if (terms.length === 0) return [];
  // Spelling tolerance is for when nothing matches as typed; next to a real
  // match it only adds noise (`model` would drag in `mode` and "PTY mode").
  return rank(terms, entries, false) ?? rank(terms, entries, true) ?? [];
}

function rank(terms: string[], entries: readonly CommandMenuEntry[], fuzzy: boolean): CommandMenuEntry[] | undefined {
  const scored: { entry: CommandMenuEntry; score: number }[] = [];
  for (const entry of entries) {
    const name = entry.command.toLowerCase();
    const words = plainWords(entry.description);
    let total = 0;
    let all = true;
    for (const term of terms) {
      const s = termScore(term, name, words, fuzzy);
      if (s === undefined) { all = false; break; }
      total += s;
    }
    if (all) scored.push({ entry, score: total });
  }
  if (scored.length === 0) return undefined;
  scored.sort((a, b) => a.score - b.score || a.entry.command.localeCompare(b.entry.command));
  return scored.map(({ entry }) => entry);
}

/** Lower is better; undefined is no match. */
function termScore(term: string, name: string, words: string[], fuzzy: boolean): number | undefined {
  if (name === term) return 0;
  if (name.startsWith(term)) return 1;
  if (name.includes(term)) return 2;
  if (words.some((w) => w.startsWith(term))) return 3;
  if (!fuzzy || term.length < 4) return undefined;
  if (editDistance(term, name) <= 1) return 4;
  if (words.some((w) => w.length >= 4 && editDistance(term, w) <= 1)) return 5;
  return undefined;
}

/** A listing line per entry; the command is tappable in Telegram as typed. */
function listEntries(b: EntityText, entries: readonly CommandMenuEntry[]): void {
  entries.forEach((e, i) => {
    if (i > 0) b.newline();
    b.add(`/${e.command}`);
    if (e.description) b.add(` — ${e.description}`);
  });
}

/** What `/commands <query>` replies. */
export function buildCommandSearchMessage(query: string, matches: readonly CommandMenuEntry[]): EntityMessage {
  const b = new EntityText();
  if (matches.length === 0) {
    return b.add('🔎 No command matches ').italic(query).add('. ')
      .code('/commands').add(' lists them all; ').code('/projectcommands')
      .add(" lists Claude Code's own.").build();
  }
  b.add('🔎 Commands matching ').italic(query).add(':').newline(2);
  listEntries(b, matches);
  return b.build();
}

/**
 * What a mistyped command gets instead of a trip to Claude. The buttons
 * underneath run a suggestion with the arguments as typed.
 */
export function buildUnknownCommandMessage(
  token: string,
  suggestions: readonly CommandMenuEntry[],
): EntityMessage {
  const b = new EntityText();
  b.add('🤔 ').code(`/${token}`).add(" isn't a command here. Did you mean:").newline(2);
  listEntries(b, suggestions);
  return b.build();
}
