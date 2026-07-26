/**
 * PTY-mode side questions for `/btw`.
 *
 * SDK mode answers side questions through the live `Query` object's
 * `askSideQuestion()`. PTY mode has no such handle — the conversation lives
 * inside a real `claude` CLI process driven through a pseudo-terminal, and
 * typing into it mid-turn would just queue a normal prompt (i.e. interrupt the
 * task, which is exactly what `/btw` promises not to do).
 *
 * Instead we answer from a throwaway fork of the live session:
 *
 *   claude -p "<question>" --resume <id> --fork-session --no-session-persistence
 *          --output-format stream-json --verbose
 *
 * `--resume` replays the session JSONL, which claude flushes after every
 * assistant message and tool call — so the fork sees the conversation right up
 * to whatever the live turn has produced so far. `--fork-session` gives it a
 * fresh session id and `--no-session-persistence` keeps it entirely off disk,
 * so the live session's transcript is never touched.
 *
 * `stream-json` makes the fork narrate its own tool calls on stdout, which is
 * how `/btw` shows live progress. Nothing else is needed for that — no hooks,
 * no MCP, no IPC — because we already own the child process.
 */

import { execFile } from 'child_process';
import { sessionJsonlPath } from './session-jsonl.js';
import { config } from '../config.js';
import * as fs from 'fs';

/** Same shape claude uses for session ids; also guards the execFile argv. */
const SESSION_ID_RE = /^[a-zA-Z0-9_-]{8,128}$/;

const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/**
 * Tools the fork must not touch. A side question is a read; it should never
 * edit the working tree out from under the turn that's actually running.
 */
const DISALLOWED_TOOLS = ['Write', 'Edit', 'NotebookEdit'];

const SIDE_QUESTION_PROMPT = [
  'You are answering a SIDE QUESTION about the conversation you just resumed.',
  'A separate agent is still working on the main task in this session — you are a read-only fork.',
  'Do not modify files, do not run state-changing commands, and do not start work.',
  'Answer the question directly and concisely using the conversation context.',
].join(' ');

export interface SideQuestionResult {
  /** The answer text. */
  response: string;
  /** Session id of the ephemeral fork, when claude reported one. */
  forkSessionId?: string;
  /** Tool calls the fork made, for the one-line receipt. */
  toolCount?: number;
  /** Wall-clock duration of the run. */
  elapsedMs?: number;
}

/** Live progress while the fork works, driven off its `stream-json` output. */
export interface SideQuestionProgress {
  /** Tool calls started so far. */
  toolCount: number;
  /** Name of the most recent tool, e.g. `Bash`. */
  currentTool?: string;
  /** One-line detail for the running tool; cleared once it finishes. */
  currentHint?: string;
  elapsedMs: number;
}

export class SideQuestionError extends Error {}

/** True if the CLI rejected one of our flags rather than failing the query. */
function isUnknownOptionError(message: string): boolean {
  return /unknown option|unknown argument|unrecognized option/i.test(message);
}

/** Turn one parsed result record into the value we hand back. */
function resultRecordToAnswer(parsed: {
  result?: unknown;
  session_id?: unknown;
  is_error?: unknown;
  error?: unknown;
}): SideQuestionResult {
  const result = typeof parsed.result === 'string' ? parsed.result.trim() : '';
  if (parsed.is_error === true) {
    throw new SideQuestionError(result || String(parsed.error ?? 'claude reported an error'));
  }
  return {
    response: result,
    forkSessionId: typeof parsed.session_id === 'string' ? parsed.session_id : undefined,
  };
}

/**
 * Pull the answer out of claude's stdout. Handles both output formats:
 * `stream-json` (newline-delimited records, the last one being the result) and
 * the single-object `json` we fall back to on older CLIs. Anything that isn't
 * recognisable JSON is handed back verbatim rather than swallowed.
 */
export function extractAnswer(stdout: string): SideQuestionResult {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith('{')) {
    return { response: trimmed };
  }

  // stream-json: scan for the final `result` record. Deliberately tolerant —
  // interleaved non-JSON noise is skipped rather than failing the whole parse.
  let lastResult: SideQuestionResult | undefined;
  let sawRecord = false;
  for (const line of trimmed.split('\n')) {
    const candidate = line.trim();
    if (!candidate.startsWith('{')) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(candidate) as Record<string, unknown>;
    } catch {
      continue;
    }
    sawRecord = true;
    // stream-json tags every record with `type`; the single-object `json`
    // format has none, so a typeless record carrying any result field is the
    // legacy shape. Requiring one of those fields keeps stray objects in a
    // stream from being mistaken for the answer.
    const isLegacyBlob = parsed.type === undefined
      && ('result' in parsed || 'is_error' in parsed || 'error' in parsed);
    if (parsed.type === 'result' || isLegacyBlob) {
      lastResult = resultRecordToAnswer(parsed);
    }
  }

  if (lastResult) return lastResult;
  // No result record — a stream cut short, or output we don't recognise.
  // Hand back what claude printed rather than losing it.
  if (sawRecord) console.warn('[btw] stream ended with no result record');
  return { response: trimmed };
}

/**
 * Best-effort one-line description of what a tool call is doing, for the
 * progress line. Mirrors the field precedence pty-provider uses when it
 * describes async tool calls.
 */
function toolHint(input: Record<string, unknown>): string | undefined {
  for (const key of ['command', 'file_path', 'pattern', 'path', 'url', 'description', 'prompt'] as const) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * Feed one `stream-json` record to the progress callback. Only two record
 * shapes matter: an assistant message carrying a `tool_use` block (a tool
 * started) and a user message carrying `tool_result` (it finished). Thinking,
 * rate-limit and system records are noise here.
 */
function consumeStreamRecord(
  record: Record<string, unknown>,
  state: { toolCount: number; currentTool?: string; currentHint?: string; startedAt: number },
  onProgress: (p: SideQuestionProgress) => void,
): void {
  const message = record.message as { content?: unknown } | undefined;
  const blocks = Array.isArray(message?.content) ? message.content as Record<string, unknown>[] : [];

  let changed = false;
  for (const block of blocks) {
    if (record.type === 'assistant' && block.type === 'tool_use') {
      state.toolCount += 1;
      state.currentTool = typeof block.name === 'string' ? block.name : 'tool';
      state.currentHint = toolHint((block.input ?? {}) as Record<string, unknown>);
      changed = true;
    } else if (record.type === 'user' && block.type === 'tool_result') {
      // Tool finished; keep the name on screen but drop the "running" detail.
      state.currentHint = undefined;
      changed = true;
    }
  }

  if (changed) {
    onProgress({
      toolCount: state.toolCount,
      currentTool: state.currentTool,
      currentHint: state.currentHint,
      elapsedMs: Date.now() - state.startedAt,
    });
  }
}

function runClaude(
  args: string[],
  cwd: string,
  timeoutMs: number,
  onProgress?: (p: SideQuestionProgress) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.env.CLAUDE_BIN || config.CLAUDE_EXECUTABLE_PATH,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, env: process.env },
      (error, stdout, stderr) => {
        if (error) {
          const message = (stderr || error.message).trim();
          reject(new SideQuestionError(message || 'Failed to run claude'));
          return;
        }
        resolve(stdout || '');
      }
    );

    if (!onProgress) return;

    // Watch the same stdout execFile is buffering for us, so we can report
    // tool calls as they happen without changing how the result is read.
    const state = { toolCount: 0, startedAt: Date.now() } as {
      toolCount: number; currentTool?: string; currentHint?: string; startedAt: number;
    };
    let pending = '';
    child.stdout?.on('data', (chunk: Buffer | string) => {
      pending += chunk.toString();
      const lines = pending.split('\n');
      pending = lines.pop() ?? ''; // keep the partial line for the next chunk
      for (const line of lines) {
        const candidate = line.trim();
        if (!candidate.startsWith('{')) continue;
        try {
          consumeStreamRecord(JSON.parse(candidate) as Record<string, unknown>, state, onProgress);
        } catch {
          // Malformed or unrecognised record — progress is best-effort.
        }
      }
    });
  });
}

/**
 * Answer `question` from a read-only fork of the PTY session `sessionId`.
 * Throws {@link SideQuestionError} with a user-presentable message on failure.
 */
export async function askForkedSideQuestion(opts: {
  question: string;
  sessionId: string;
  cwd: string;
  timeoutMs?: number;
  onProgress?: (p: SideQuestionProgress) => void;
}): Promise<SideQuestionResult> {
  const { question, sessionId, cwd, onProgress } = opts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();

  if (!SESSION_ID_RE.test(sessionId)) {
    throw new SideQuestionError('Invalid session ID format');
  }
  if (!fs.existsSync(sessionJsonlPath(cwd, sessionId))) {
    throw new SideQuestionError('No transcript on disk for this session yet — send a message first.');
  }

  const baseArgs = [
    '-p', question,
    '--resume', sessionId,
    '--fork-session',
    // Mirror PTY mode: project/local settings only, no user-level config.
    '--setting-sources', 'project,local',
    // No MCP servers — the fork must not be able to message Telegram.
    '--strict-mcp-config',
    // The fork inherits the live session's bypassed permissions so tool calls
    // resolve instead of hanging on approval; the disallow list below is what
    // actually keeps it read-only.
    '--dangerously-skip-permissions',
    '--disallowed-tools', ...DISALLOWED_TOOLS,
    '--append-system-prompt', SIDE_QUESTION_PROMPT,
  ];

  // stream-json reports every tool call as it happens, which is what drives the
  // live progress line. `--verbose` is required alongside it in print mode.
  const streamArgs = [...baseArgs, '--output-format', 'stream-json', '--verbose', '--no-session-persistence'];
  // Fallback for CLIs that don't know one of the flags above: one JSON blob at
  // the end, no progress. `--fork-session` alone still protects the live
  // transcript, it just leaves a stray log behind for us to delete.
  const fallbackArgs = [...baseArgs, '--output-format', 'json'];

  // Remember the last progress tick so the caller can render a receipt
  // ("3 tools · 22s") without tracking it itself.
  let toolCount = 0;
  const trackProgress = (p: SideQuestionProgress) => {
    toolCount = p.toolCount;
    onProgress?.(p);
  };

  let result: SideQuestionResult;
  try {
    result = extractAnswer(await runClaude(streamArgs, cwd, timeoutMs, trackProgress));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isUnknownOptionError(message)) throw error;
    console.warn('[btw] CLI rejected the streaming flags — retrying without progress');
    result = extractAnswer(await runClaude(fallbackArgs, cwd, timeoutMs));
    if (result.forkSessionId && result.forkSessionId !== sessionId) {
      try {
        fs.rmSync(sessionJsonlPath(cwd, result.forkSessionId), { force: true });
      } catch {
        // Leftover fork log is harmless — it's never resumed by the bot.
      }
    }
  }

  return { ...result, toolCount, elapsedMs: Date.now() - startedAt };
}
