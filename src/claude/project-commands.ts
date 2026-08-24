import * as fs from 'fs';
import * as path from 'path';

/**
 * Read project-level slash commands from `.claude/commands/*.md`. Each file
 * defines a command whose name is the basename and whose first non-frontmatter
 * line is the description. Feeds the `/projectcommands` listing only — these
 * are never registered with Telegram's command menu, which would reject the
 * hyphens Claude Code command names routinely use.
 *
 * Returns at most 30 commands sorted by name — enough to fill a Telegram
 * message alongside the rest of the listing. Returns [] silently if the
 * directory doesn't exist — most projects don't have any.
 */

export interface ProjectCommand {
  name: string;
  description: string;
}

const MAX_COMMANDS = 30;  // keeps the listing inside one Telegram message
const DESC_MAX = 80;

export function getProjectCommands(workingDirectory: string): ProjectCommand[] {
  const dir = path.join(workingDirectory, '.claude', 'commands');
  if (!fs.existsSync(dir)) return [];

  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const commands: ProjectCommand[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const name = entry.slice(0, -3);
    // Claude Code's own charset for a command name. Hyphens are fine here
    // because this list is only ever rendered as text.
    if (!/^[a-z0-9_-]+$/i.test(name)) continue;
    let description = '';
    try {
      const content = fs.readFileSync(path.join(dir, entry), 'utf-8');
      description = extractDescription(content);
    } catch {
      // unreadable — skip rather than error
      continue;
    }
    commands.push({ name: name.toLowerCase(), description });
  }

  commands.sort((a, b) => a.name.localeCompare(b.name));
  return commands.slice(0, MAX_COMMANDS);
}

/**
 * Pull a one-line description from a command markdown file. Prefers a
 * `description:` frontmatter field; falls back to the first non-empty
 * non-heading line of the body.
 */
function extractDescription(content: string): string {
  // YAML frontmatter: ---\n...description: foo\n...---
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (frontmatterMatch) {
    const fm = frontmatterMatch[1];
    const descMatch = fm.match(/^description:\s*(.+)$/m);
    if (descMatch) {
      return truncate(descMatch[1].trim().replace(/^["']|["']$/g, ''));
    }
  }

  // Fallback: first non-empty body line that isn't a heading
  const body = frontmatterMatch ? content.slice(frontmatterMatch[0].length) : content;
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#')) continue;
    return truncate(line);
  }
  return '';
}

function truncate(s: string): string {
  return s.length > DESC_MAX ? s.slice(0, DESC_MAX - 1) + '…' : s;
}
