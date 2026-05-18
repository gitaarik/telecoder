import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface RecapExchange {
  user: string;
  assistant: string;
}

interface ContentBlock {
  type?: string;
  text?: string;
}

interface JsonlMessage {
  role?: string;
  content?: string | ContentBlock[];
}

interface JsonlRecord {
  type?: string;
  message?: JsonlMessage;
}

/** Build the path Claude Code uses to store a session's JSONL log. */
export function sessionJsonlPath(workingDirectory: string, sessionId: string): string {
  const encoded = workingDirectory.replace(/\//g, '-');
  return path.join(os.homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`);
}

/** True if Claude Code has an on-disk session log for `id` under `cwd`. */
export function claudeSessionFileExists(workingDirectory: string, sessionId: string): boolean {
  return fs.existsSync(sessionJsonlPath(workingDirectory, sessionId));
}

/** Pull joined text from a record's content blocks, ignoring tool/thinking blocks. */
function extractText(content: JsonlMessage['content']): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => (c.text as string).trim())
    .filter((t) => t.length > 0)
    .join('\n\n');
}

/**
 * Read the JSONL log for a session and return the last `n` user/assistant
 * exchanges. Tool calls, tool results, and thinking blocks are skipped so the
 * recap reads like a conversation transcript.
 */
export function readRecentExchanges(
  workingDirectory: string,
  sessionId: string,
  n: number,
): RecapExchange[] {
  const filePath = sessionJsonlPath(workingDirectory, sessionId);
  if (!fs.existsSync(filePath)) return [];

  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n');

  // Build an alternating list of {role, text} turns. Multiple consecutive
  // records of the same role (e.g. assistant emits thinking + text in
  // separate records) collapse into a single turn.
  type Turn = { role: 'user' | 'assistant'; text: string };
  const turns: Turn[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    let rec: JsonlRecord;
    try {
      rec = JSON.parse(line) as JsonlRecord;
    } catch {
      continue;
    }
    const role = rec.type === 'user' ? 'user' : rec.type === 'assistant' ? 'assistant' : null;
    if (!role) continue;

    const text = extractText(rec.message?.content);
    if (!text) continue; // pure tool_result / tool_use / thinking — skip

    const last = turns[turns.length - 1];
    if (last && last.role === role) {
      last.text += '\n\n' + text;
    } else {
      turns.push({ role, text });
    }
  }

  // Pair user → assistant exchanges. Skip an unpaired trailing user turn
  // (in-flight question with no response yet).
  const exchanges: RecapExchange[] = [];
  for (let i = 0; i < turns.length; i++) {
    if (turns[i].role !== 'user') continue;
    const next = turns[i + 1];
    if (!next || next.role !== 'assistant') continue;
    exchanges.push({ user: turns[i].text, assistant: next.text });
    i++;
  }

  return exchanges.slice(-n);
}
