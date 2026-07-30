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
  /** Claude Code's per-record id. Used to tell one turn's prompt from the next. */
  uuid?: string;
  timestamp?: string;
  /**
   * Top-level flag Claude Code sets on a synthetic assistant record it writes
   * when its API call fails mid-turn (socket dropped, rate limit, auth, …).
   * The record's `message.model` is `<synthetic>`, usage is zeroed, and the
   * single text block contains the error string ("API Error: ..."). We must
   * filter these out everywhere we read assistant text or usage from the log,
   * otherwise the error leaks into chat as if it were assistant prose and the
   * status line ends up showing 0 tokens / `<synthetic>` model.
   */
  isApiErrorMessage?: boolean;
}

/** True if this record is the synthetic "API Error" stop record Claude Code writes when an in-flight request dies. */
function isApiErrorRecord(rec: JsonlRecord | Record<string, unknown>): boolean {
  return (rec as JsonlRecord).isApiErrorMessage === true;
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

/**
 * Mtime (ms since epoch) of the session's JSONL log, or 0 if it doesn't exist
 * yet. Used by PTY mode as an end-of-turn signal — claude flushes a fresh
 * record to the log for every assistant message, tool call, system event,
 * compaction boundary, etc., so a moving mtime is reliable evidence that
 * claude actually did work for the current prompt (the prior bullet-count
 * heuristic broke on slash commands like /compact that don't emit a `●`).
 */
export function sessionJsonlMtimeMs(workingDirectory: string, sessionId: string): number {
  try {
    return fs.statSync(sessionJsonlPath(workingDirectory, sessionId)).mtimeMs;
  } catch {
    return 0;
  }
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

    // Skip the synthetic API-error record: its usage is all zeros and would
    // wipe out the legitimate cumulative totals from the real assistant turn
    // that ran just before it.
    if (isApiErrorRecord(rec)) continue;

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

export interface CompactionInfo {
  trigger: 'manual' | 'auto';
  preTokens: number;
  postTokens: number;
  /** Epoch ms parsed from the record's `timestamp`, or 0 if unparseable. */
  timestampMs: number;
}

/** First numeric value among `keys` on `obj`, or 0. Tolerates snake/camel drift. */
function numField(obj: Record<string, unknown> | undefined, ...keys: string[]): number {
  if (!obj) return 0;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number') return v;
  }
  return 0;
}

/**
 * Return the most recent `compact_boundary` record from a session log, or
 * undefined if the log has none. Claude Code appends one of these whenever the
 * context is compacted — manually (`/compact`) or automatically near the limit
 * — but renders no `●` glyph for it, so PTY-mode screen scraping can't see that
 * a compaction happened. Reading it back from the JSONL lets the PTY provider
 * surface the same "Context Compacted" feedback the SDK path already gives.
 *
 * On-disk shape (Claude Code 2.1.x):
 *   {"type":"system","subtype":"compact_boundary",
 *    "compactMetadata":{"trigger":"manual","preTokens":445116,"postTokens":15617,...},
 *    "timestamp":"2026-07-22T07:09:43.860Z"}
 * Older builds used snake_case `compact_metadata`/`pre_tokens`; both are handled.
 */
export function readLastCompactionFromJsonl(
  workingDirectory: string,
  sessionId: string,
): CompactionInfo | undefined {
  const filePath = sessionJsonlPath(workingDirectory, sessionId);
  if (!fs.existsSync(filePath)) return undefined;

  let raw: string;
  try { raw = fs.readFileSync(filePath, 'utf-8'); }
  catch { return undefined; }

  let last: CompactionInfo | undefined;
  for (const line of raw.split('\n')) {
    // Cheap pre-filter — these records are rare, skip the JSON.parse otherwise.
    if (!line.includes('compact_boundary')) continue;
    let rec: Record<string, unknown>;
    try { rec = JSON.parse(line) as Record<string, unknown>; }
    catch { continue; }
    if (rec.type !== 'system' || rec.subtype !== 'compact_boundary') continue;

    const meta = (rec.compactMetadata ?? rec.compact_metadata) as Record<string, unknown> | undefined;
    const ts = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN;
    last = {
      trigger: meta?.trigger === 'auto' ? 'auto' : 'manual',
      preTokens: numField(meta, 'preTokens', 'pre_tokens'),
      postTokens: numField(meta, 'postTokens', 'post_tokens'),
      timestampMs: Number.isNaN(ts) ? 0 : ts,
    };
  }
  return last;
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
 * Return the joined text of every assistant content block emitted since the
 * most recent `type:'user'` record. PTY-mode end-of-turn extraction uses this
 * instead of scraping the xterm buffer because a single turn can produce
 * multiple `●` text blocks interleaved with tool calls — screen-scrape only
 * picks the last `●`, silently dropping the earlier blocks. Returns undefined
 * if the log isn't on disk yet or has no assistant text since the last user
 * record (caller should fall back to whatever signal it has).
 */
export function readLastAssistantTurnText(
  workingDirectory: string,
  sessionId: string,
): string | undefined {
  const filePath = sessionJsonlPath(workingDirectory, sessionId);
  if (!fs.existsSync(filePath)) return undefined;

  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n');

  // Walk forward; remember where the last real user prompt sits, then collect
  // text from every assistant record after it. extractText filters out
  // tool_use / tool_result / thinking blocks so we only keep prose.
  //
  // Crucial subtlety: `type:'user'` records aren't only user prompts — every
  // tool_result is also delivered as a user-role record. If we treated each
  // user record as a turn boundary we'd slice from the LAST tool_result,
  // dropping all assistant text emitted earlier in the same turn. Filtering
  // user records by `text.length > 0` discards tool_result-only records
  // (extractText returns '' for those) and isolates real prompts.
  let lastPromptIdx = -1;
  const records: { role: 'user' | 'assistant'; text: string }[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let rec: JsonlRecord;
    try { rec = JSON.parse(line) as JsonlRecord; }
    catch { continue; }
    const role = rec.type === 'user' ? 'user' : rec.type === 'assistant' ? 'assistant' : null;
    if (!role) continue;
    // Synthetic API-error records carry the "API Error: ..." string as a
    // plain text block — drop them so the error doesn't get joined into the
    // assistant response shown to the user. The caller surfaces the error
    // separately via readLastApiErrorFromJsonl.
    if (isApiErrorRecord(rec)) continue;
    const text = extractText(rec.message?.content);
    records.push({ role, text });
    if (role === 'user' && text.length > 0) lastPromptIdx = records.length - 1;
  }

  if (lastPromptIdx === -1) return undefined;

  const assistantTexts = records
    .slice(lastPromptIdx + 1)
    .filter((r) => r.role === 'assistant' && r.text.length > 0)
    .map((r) => r.text);

  if (assistantTexts.length === 0) return undefined;
  return assistantTexts.join('\n\n');
}

/** Identity of a user prompt record in the log. */
export interface UserPromptMarker {
  /** Record uuid, or a timestamp+text digest when Claude Code wrote none. */
  id: string;
  text: string;
}

/**
 * Identity of the last real user prompt in the log — the same turn boundary
 * readLastAssistantTurnText slices from. Snapshotted just before a prompt is
 * submitted so end-of-turn can tell "claude answered us" apart from "claude
 * never received the prompt and the log still ends on the previous turn".
 *
 * That second case is not hypothetical: a pty respawned against a large session
 * replays the whole transcript, and while it renders, the editor can swallow
 * the Enter that submits our prompt. The log then still holds the *previous*
 * turn, and reading assistant text out of it hands the user a stale answer as
 * if it were a fresh one.
 *
 * tool_result records are user-role too, so real prompts are isolated the same
 * way as above: by requiring non-empty prose after tool blocks are filtered.
 */
export function readLastUserPromptMarker(
  workingDirectory: string,
  sessionId: string,
): UserPromptMarker | undefined {
  const filePath = sessionJsonlPath(workingDirectory, sessionId);
  if (!fs.existsSync(filePath)) return undefined;

  let raw: string;
  try { raw = fs.readFileSync(filePath, 'utf-8'); }
  catch { return undefined; }

  let last: UserPromptMarker | undefined;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec: JsonlRecord;
    try { rec = JSON.parse(line) as JsonlRecord; }
    catch { continue; }
    if (rec.type !== 'user') continue;
    const text = extractText(rec.message?.content);
    if (!text) continue;
    last = { id: rec.uuid ?? `${rec.timestamp ?? ''}|${text.slice(0, 120)}`, text };
  }
  return last;
}

/**
 * If the most recent assistant record after the last user prompt is the
 * synthetic API-error record (Claude Code's stop marker when its in-flight
 * request died), return its text. Otherwise undefined.
 *
 * Used by the PTY provider to detect that the turn we just resolved actually
 * ended in an API failure and to throw rather than silently returning whatever
 * partial assistant text was streamed before the socket dropped.
 */
export function readLastApiErrorFromJsonl(
  workingDirectory: string,
  sessionId: string,
): string | undefined {
  const filePath = sessionJsonlPath(workingDirectory, sessionId);
  if (!fs.existsSync(filePath)) return undefined;

  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n');

  let lastPromptIdx = -1;
  type Rec = { role: 'user' | 'assistant'; apiError: boolean; text: string };
  const records: Rec[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    let rec: JsonlRecord;
    try { rec = JSON.parse(line) as JsonlRecord; }
    catch { continue; }
    const role = rec.type === 'user' ? 'user' : rec.type === 'assistant' ? 'assistant' : null;
    if (!role) continue;
    const text = extractText(rec.message?.content);
    records.push({ role, apiError: isApiErrorRecord(rec), text });
    if (role === 'user' && text.length > 0 && !isApiErrorRecord(rec)) {
      lastPromptIdx = records.length - 1;
    }
  }

  if (lastPromptIdx === -1) return undefined;

  // Walk the post-prompt window newest-first: the FIRST assistant record we
  // see going backwards is the "most recent assistant record". If that record
  // is the API-error one, the turn ended with a failure.
  for (let i = records.length - 1; i > lastPromptIdx; i--) {
    if (records[i].role !== 'assistant') continue;
    if (records[i].apiError) return records[i].text || 'API Error';
    return undefined; // most recent assistant record is a real reply — no error
  }
  return undefined;
}

/**
 * Read the most recent `type:'ai-title'` record's `aiTitle` field from the
 * session log. Claude Code writes this as a session-level label (visible in
 * its resume picker); empirically it locks in early and doesn't track topic
 * shifts, so treat it as a session label, not a live focus tracker. Useful
 * as a seed when our own topic state is empty (resume path, or Haiku failure
 * with no prior topic).
 */
export function readLastAiTitle(
  workingDirectory: string,
  sessionId: string,
): string | undefined {
  const filePath = sessionJsonlPath(workingDirectory, sessionId);
  if (!fs.existsSync(filePath)) return undefined;

  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n');

  let lastTitle: string | undefined;
  for (const line of lines) {
    if (!line.trim()) continue;
    // Cheap pre-filter — these records are dense, no point parsing every line.
    if (!line.includes('"ai-title"')) continue;
    let rec: Record<string, unknown>;
    try { rec = JSON.parse(line) as Record<string, unknown>; }
    catch { continue; }
    if (rec.type !== 'ai-title') continue;
    const title = rec.aiTitle;
    if (typeof title === 'string' && title.trim().length > 0) {
      lastTitle = title.trim();
    }
  }
  return lastTitle;
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
    if (isApiErrorRecord(rec)) continue;

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

/**
 * True if the session log contains a thinking block whose `signature` looks
 * fabricated rather than a genuine Anthropic signature. CCR mints placeholder
 * signatures for DeepSeek's reasoning — a Unix-ms timestamp (e.g.
 * "1780826242641") or an empty string — because DeepSeek has no signature
 * concept. Genuine Anthropic signatures are long base64 blobs (60+ chars,
 * mixed case with +//=). Replaying a fabricated one against the real Anthropic
 * API trips `400 Invalid signature in thinking block`, so the agent uses this
 * to fork a poisoned session instead of resuming it.
 *
 * Heuristic and cheap (a single regex sweep). Used only as a last-resort guard
 * for sessions with no recorded owner provider (e.g. created before ownership
 * tracking existed, or after a restart dropped the in-memory owner).
 */
/**
 * Classify a thinking-block `signature` value as fabricated (not from the real
 * Anthropic API). CCR uses an empty string or a Unix-ms timestamp as a
 * placeholder for DeepSeek's reasoning; genuine Anthropic signatures are long
 * base64 blobs containing non-digit characters.
 */
export function isForeignThinkingSignature(sig: string): boolean {
  return sig.length === 0 || /^\d+$/.test(sig);
}

export function hasForeignThinkingSignatures(workingDirectory: string, sessionId: string): boolean {
  const filePath = sessionJsonlPath(workingDirectory, sessionId);
  if (!fs.existsSync(filePath)) return false;

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return false;
  }

  const sigRe = /"signature"\s*:\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = sigRe.exec(raw)) !== null) {
    if (isForeignThinkingSignature(m[1])) return true;
  }
  return false;
}
