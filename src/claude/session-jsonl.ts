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

export interface JsonlUsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  model: string;
  /** Number of `type:'user'` records in the log — proxy for SDK's numTurns. */
  numTurns: number;
}

/**
 * Read the most recent assistant-message usage block from a Claude Code session
 * log. Returns undefined if the log doesn't exist or has no usage records.
 *
 * Claude writes the JSONL append-only with usage attached to each assistant
 * message (`message.usage = {input_tokens, cache_read_input_tokens, ...}`).
 * We scan newest-first to find the last usage block — that represents the
 * cumulative token state after the last turn.
 */
export function readLastUsageFromJsonl(workingDirectory: string, sessionId: string): JsonlUsageSnapshot | undefined {
  const filePath = sessionJsonlPath(workingDirectory, sessionId);
  if (!fs.existsSync(filePath)) return undefined;

  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n');

  let numTurns = 0;
  let lastUsage: JsonlUsageSnapshot | undefined;

  for (const line of lines) {
    if (!line) continue;
    let rec: Record<string, unknown>;
    try { rec = JSON.parse(line) as Record<string, unknown>; }
    catch { continue; }

    if (rec.type === 'user') numTurns++;

    const msg = rec.message as Record<string, unknown> | undefined;
    const usage = msg?.usage as Record<string, unknown> | undefined;
    if (!usage) continue;

    lastUsage = {
      inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
      outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
      cacheReadTokens: typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0,
      cacheWriteTokens: typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0,
      model: typeof msg?.model === 'string' ? msg.model as string : '',
      numTurns: 0, // filled in after the loop
    };
  }

  if (!lastUsage) return undefined;
  lastUsage.numTurns = numTurns;
  return lastUsage;
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
