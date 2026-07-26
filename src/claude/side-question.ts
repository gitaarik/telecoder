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
 *
 * `--resume` replays the session JSONL, which claude flushes after every
 * assistant message and tool call — so the fork sees the conversation right up
 * to whatever the live turn has produced so far. `--fork-session` gives it a
 * fresh session id and `--no-session-persistence` keeps it entirely off disk,
 * so the live session's transcript is never touched.
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
}

export class SideQuestionError extends Error {}

/** True if the CLI rejected one of our flags rather than failing the query. */
function isUnknownOptionError(message: string): boolean {
  return /unknown option|unknown argument|unrecognized option/i.test(message);
}

/**
 * Parse `--output-format json` output. Older CLIs (or a hard failure that
 * still exits 0) may print plain text, so fall back to the raw stdout.
 */
function extractAnswer(stdout: string): SideQuestionResult {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith('{')) {
    return { response: trimmed };
  }
  try {
    const parsed = JSON.parse(trimmed) as {
      result?: unknown;
      session_id?: unknown;
      is_error?: unknown;
      error?: unknown;
    };
    const result = typeof parsed.result === 'string' ? parsed.result.trim() : '';
    if (parsed.is_error === true) {
      throw new SideQuestionError(result || String(parsed.error ?? 'claude reported an error'));
    }
    return {
      response: result,
      forkSessionId: typeof parsed.session_id === 'string' ? parsed.session_id : undefined,
    };
  } catch (error) {
    if (error instanceof SideQuestionError) throw error;
    // Not the JSON we expected — hand back whatever claude printed.
    return { response: trimmed };
  }
}

function runClaude(args: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
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
}): Promise<SideQuestionResult> {
  const { question, sessionId, cwd } = opts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

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
    '--output-format', 'json',
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

  let stdout: string;
  try {
    stdout = await runClaude([...baseArgs, '--no-session-persistence'], cwd, timeoutMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isUnknownOptionError(message)) throw error;
    // Older CLI without --no-session-persistence: --fork-session alone still
    // protects the live transcript, it just leaves a stray log behind.
    const result = extractAnswer(await runClaude(baseArgs, cwd, timeoutMs));
    if (result.forkSessionId && result.forkSessionId !== sessionId) {
      try {
        fs.rmSync(sessionJsonlPath(cwd, result.forkSessionId), { force: true });
      } catch {
        // Leftover fork log is harmless — it's never resumed by the bot.
      }
    }
    return result;
  }

  return extractAnswer(stdout);
}
