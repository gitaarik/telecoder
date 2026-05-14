/**
 * Pty-driven Claude Code prototype.
 *
 * Goal: validate that we can drive `claude` (interactive REPL, not -p) under a
 * pseudo-terminal, send a prompt, detect end-of-turn reliably, and extract the
 * response text. If this works on current Claude Code, it's the foundation for
 * a third Claudegram provider that uses the user's Max subscription instead of
 * the programmatic credit pool.
 *
 * Usage:
 *   pnpm install   (or npm install)
 *   pnpm run -- "your prompt here"
 *   pnpm run -- --resume <session-id> "follow up"
 *   pnpm run -- --debug "your prompt"        # dump raw pty bytes alongside parsed output
 *
 * What this is NOT:
 *   - Production code. The parser here is intentionally simple to test the
 *     premise. A real implementation would render via xterm-headless and use
 *     quorum-based end-of-turn detection (see the design discussion).
 */

import { spawn, type IPty } from 'node-pty';
import stripAnsi from 'strip-ansi';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ---- Config ---------------------------------------------------------------

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
// Default to a known-trusted dir to avoid the first-run trust dialog
// intercepting our typed prompt. The user works in claudegram interactively,
// so that folder is already on Claude Code's trust list.
const CWD = process.env.CLAUDEGRAM_PTY_CWD || '/home/rik/dev/claudegram';
const COLS = 120;
const ROWS = 40;

// Idle window: how long stdout must be quiet before we consider the REPL
// has settled (either ready to receive input, or finished a turn).
// 1200ms is a starting point — tune against real sessions.
const IDLE_MS = 1200;

// Hard ceiling per turn so a stuck process can't hang the prototype.
const MAX_TURN_MS = 5 * 60_000;

// Max time to wait for the REPL banner to settle before we start typing.
const STARTUP_MAX_MS = 15_000;

// ---- Argument parsing -----------------------------------------------------

const argv = process.argv.slice(2);
let resumeId: string | undefined;
let debug = false;
const promptParts: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--resume') {
    resumeId = argv[++i];
  } else if (a === '--debug') {
    debug = true;
  } else {
    promptParts.push(a);
  }
}
const userPrompt = promptParts.join(' ').trim();
if (!userPrompt) {
  console.error('Usage: tsx prototype.ts [--resume <id>] [--debug] "prompt text"');
  process.exit(2);
}

// ---- Spawn ----------------------------------------------------------------

const args = ['--dangerously-skip-permissions'];
if (resumeId) {
  args.push('--resume', resumeId);
}

const debugLog = debug
  ? fs.createWriteStream(path.join(os.tmpdir(), `claudegram-pty-debug-${Date.now()}.log`))
  : null;
if (debugLog) {
  console.error(`[debug] writing raw pty bytes to ${(debugLog as any).path}`);
}

const term: IPty = spawn(CLAUDE_BIN, args, {
  name: 'xterm-256color',
  cols: COLS,
  rows: ROWS,
  cwd: CWD,
  env: { ...process.env, TERM: 'xterm-256color' },
});

let buffer = '';
let lastChunkAt = Date.now();
let turnStartedAt = 0;
let endOfTurnResolver: ((text: string) => void) | null = null;
let endOfTurnRejector: ((err: Error) => void) | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let hardTimer: NodeJS.Timeout | null = null;

term.onData((chunk: string) => {
  lastChunkAt = Date.now();
  buffer += chunk;
  if (debugLog) debugLog.write(chunk);

  if (endOfTurnResolver) {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(checkEndOfTurn, IDLE_MS);
  }
});

term.onExit(({ exitCode, signal }) => {
  if (endOfTurnRejector) {
    endOfTurnRejector(new Error(`claude exited (code=${exitCode}, signal=${signal}) mid-turn`));
  } else {
    process.exit(exitCode ?? 0);
  }
});

function checkEndOfTurn() {
  // Quorum-of-one (prototype): stdout has been quiet for IDLE_MS.
  // A real impl would also confirm the input prompt glyph is on screen
  // and the cursor is parked there.
  if (!endOfTurnResolver) return;
  const idleFor = Date.now() - lastChunkAt;
  if (idleFor < IDLE_MS) {
    idleTimer = setTimeout(checkEndOfTurn, IDLE_MS - idleFor);
    return;
  }
  const turnBytes = buffer.slice(turnStartBufferLen);
  const resolved = endOfTurnResolver;
  endOfTurnResolver = null;
  endOfTurnRejector = null;
  if (hardTimer) clearTimeout(hardTimer);
  resolved(turnBytes);
}

// ---- Turn machinery -------------------------------------------------------

let turnStartBufferLen = 0;

function awaitEndOfTurn(): Promise<string> {
  return new Promise((resolve, reject) => {
    turnStartedAt = Date.now();
    turnStartBufferLen = buffer.length;
    endOfTurnResolver = resolve;
    endOfTurnRejector = reject;
    idleTimer = setTimeout(checkEndOfTurn, IDLE_MS);
    hardTimer = setTimeout(() => {
      if (endOfTurnRejector) {
        const r = endOfTurnRejector;
        endOfTurnResolver = null;
        endOfTurnRejector = null;
        r(new Error(`turn exceeded ${MAX_TURN_MS}ms`));
      }
    }, MAX_TURN_MS);
  });
}

async function waitMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Wait until the REPL goes idle (no stdout for IDLE_MS) or we hit a hard cap.
 * Used to detect "ready to type" without relying on banner-specific text.
 */
async function waitForIdle(idleMs: number, capMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < capMs) {
    const since = Date.now() - lastChunkAt;
    if (since >= idleMs) return;
    await waitMs(Math.max(50, idleMs - since));
  }
}

// ---- Main -----------------------------------------------------------------

async function main() {
  // Wait for the REPL to settle before typing. This dodges the timing bug
  // where our prompt got eaten by a startup dialog (e.g. folder-trust check).
  await waitForIdle(IDLE_MS, STARTUP_MAX_MS);

  // Type the prompt, then submit. Claude Code's REPL accepts \r to submit.
  // (Some TUIs require \n or a specific key sequence — if this doesn't work,
  // we may need to send Ctrl+Enter or similar.)
  term.write(userPrompt + '\r');

  const rawTurn = await awaitEndOfTurn();
  const elapsed = Date.now() - turnStartedAt;

  // Strip ANSI; collapse runs of whitespace lines for readability.
  const stripped = stripAnsi(rawTurn);
  const cleaned = stripped
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  console.log('─'.repeat(60));
  console.log(`elapsed: ${elapsed}ms  raw bytes: ${rawTurn.length}  stripped chars: ${stripped.length}`);
  console.log('─'.repeat(60));
  console.log(cleaned);
  console.log('─'.repeat(60));

  // Clean exit: send Ctrl+C twice (Claude Code's quit gesture) or just kill.
  term.kill();
}

main().catch((err) => {
  console.error('prototype failed:', err);
  try {
    term.kill();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
