/**
 * `/cost` — Claude Code's own cost report, delivered to the chat.
 *
 * What `/cost` reports depends on how the account pays, and the difference
 * decides how much of it TeleCoder can honour:
 *
 *   - subscription: the limits view — how much of the session and weekly
 *     windows is spent, and when each resets. Account-wide, and the same text
 *     `/usage` prints. Asking it in a process that has just spent $0.10
 *     returns exactly that view with no session figure in it.
 *   - API billing: the session's own totals — dollars, durations, per-model
 *     token counts.
 *
 * That second shape is session-scoped, and no amount of care here recovers it.
 * The cost counter lives in the CLI process that spent it: resume the session
 * in a fresh process and it reads zero, because the session log carries no
 * cost field to rebuild it from. So the totals a spawned probe reports are its
 * own, not the conversation's, and `parseCostOutput` says so rather than
 * letting a $0.00 read as this chat having been free. The per-turn figure
 * TeleCoder caches from its own result messages fills that gap.
 *
 * Since the probe is a fresh process either way, it needs no session and no
 * `--resume` — nothing here can append a stray turn to a live conversation,
 * and the command answers before a project is even open.
 */

import { Context } from 'grammy';
import { spawn } from 'child_process';
import * as fs from 'fs';
import { sessionManager } from '../../../claude/session-manager.js';
import { config } from '../../../config.js';
import { getSessionCost, type SessionCost } from '../../../claude/session-cost.js';
import { messageSender } from '../../../telegram/message-sender.js';
import { getProgressBar } from '../../../utils/format.js';
import { resolveActiveClaudeExecutable } from '../../../utils/resolve-claude-bin.js';
import { sanitizeError } from '../../../utils/sanitize.js';
import { getSessionKeyFromCtx } from '../../../utils/session-key.js';
import { getWorkspaceRoot } from '../../../utils/workspace-guard.js';

/** The probe answers in ~2s; the ceiling matches `/context`'s. */
const COST_TIMEOUT_MS = 20_000;

/** Output cap, standing in for `execFile`'s `maxBuffer`. */
const MAX_OUTPUT_BYTES = 1024 * 1024;

/** `Current session: 39% used · resets Aug 31, 5:09pm (UTC)` */
const LIMIT_RE = /^(.+?):\s*(\d+(?:\.\d+)?)%\s+used\b(?:\s*[·•-]\s*resets\s+(.+?))?$/i;

/** `Total cost:            $0.1234` — the API-billing shape's label/value rows. */
const TOTALS_RE = /^(Total\s+[^:]+):\s*(.+)$/i;

/** `Last 24h · 1608 requests · 89 sessions` */
const PERIOD_RE = /^(Last\s+\S+)(\s*[·•].*)$/i;

/**
 * Render `claude -p /cost` output as Telegram markdown.
 *
 * `chatCost` is TeleCoder's own running tally for this conversation — the one
 * figure here the CLI cannot produce, since its counter dies with each turn's
 * process. Omitted when no turn has been tallied, which is every PTY-mode
 * chat: that mode never receives a cost figure to add up.
 */
export function parseCostOutput(raw: string, chatCost?: SessionCost): string {
  const trimmed = raw.trim();
  if (!trimmed) return '⚠️ No cost output received.';

  const body: string[] = [];
  let recognised = 0;
  let sawTotals = false;

  /** Collapse runs of blank lines, and never open a section with one. */
  const pushBlank = (): void => {
    if (body.length > 0 && body[body.length - 1] !== '') body.push('');
  };

  for (const rawLine of trimmed.split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      pushBlank();
      continue;
    }

    const limit = line.match(LIMIT_RE);
    if (limit) {
      const pct = Math.round(Number(limit[2]));
      // "Current session" reads better as "session" once the bar carries the number.
      const label = limit[1].replace(/^current\s+/i, '');
      const resets = limit[3] ? ` — resets ${limit[3]}` : '';
      body.push(`${getProgressBar(pct)} **${pct}%** ${label}${resets}`);
      recognised++;
      continue;
    }

    const totals = line.match(TOTALS_RE);
    if (totals) {
      body.push(`- **${totals[1]}:** ${totals[2].trim()}`);
      sawTotals = true;
      recognised++;
      continue;
    }

    const period = line.match(PERIOD_RE);
    if (period) {
      pushBlank();
      body.push(`**${period[1]}**${period[2]}`);
      recognised++;
      continue;
    }

    if (/^usage by model:?$/i.test(line)) {
      pushBlank();
      body.push('**Usage by model**');
      recognised++;
      continue;
    }

    if (/^what's contributing/i.test(line)) {
      pushBlank();
      body.push(`**${line}**`);
      recognised++;
      continue;
    }

    // The CLI indents the detail rows under each heading — as bullets they
    // survive Telegram's whitespace collapsing, which would otherwise flatten
    // them into the heading above.
    if (/^\s+\S/.test(rawLine)) {
      body.push(`- ${line}`);
      continue;
    }

    // Framing prose ("You are currently using your subscription…", the
    // "Approximate, based on local sessions…" caveat) — kept, because the
    // caveat is the part that says these numbers miss your other machines.
    body.push(`_${line}_`);
  }

  const lines = ['## 💰 Cost & Usage', ''];
  if (recognised === 0) {
    // A CLI whose wording we don't know. Show what came back rather than
    // dressing up output we failed to understand — as a sentence when that is
    // all it is (older builds answer `/cost` with a single line), as a block
    // when there is a shape worth preserving.
    lines.push(trimmed.includes('\n') ? `\`\`\`\n${trimmed}\n\`\`\`` : `_${trimmed}_`);
  } else {
    lines.push(...body);
  }
  if (sawTotals) {
    // These totals belong to the process that just answered, which has done
    // nothing but answer. Left unqualified, an API-billed account reads its
    // $0.00 as a conversation that cost nothing.
    if (lines[lines.length - 1] !== '') lines.push('');
    lines.push('_Totals cover this lookup only — Claude Code keeps no per-conversation cost once a turn ends._');
  }
  if (chatCost && chatCost.turns > 0) {
    if (lines[lines.length - 1] !== '') lines.push('');
    const turns = chatCost.turns === 1 ? '1 turn' : `${chatCost.turns} turns`;
    lines.push(`**This chat:** $${chatCost.usd.toFixed(4)} across ${turns} — TeleCoder's own tally, since the CLI keeps none.`);
  }
  return lines.join('\n').trimEnd();
}

/**
 * Which CLI to ask, best first.
 *
 * Every candidate is spawned as a fresh process with nothing spent in it, so
 * the substance of the answer does not depend on which one asks. What does
 * depend on it is how much gets printed: the copy bundled with the SDK trails
 * the user's own install by many releases, and older builds reply with a
 * single sentence where current ones break every limit down with its reset
 * time. So ask the install the user maintains — the same `claude` they would
 * type `/cost` into — and keep the bundled binary as the fallback for setups
 * with no CLI on PATH at all.
 */
function costExecutables(): string[] {
  const preferred = process.env.CLAUDE_BIN || config.CLAUDE_EXECUTABLE_PATH;
  const bundled = resolveActiveClaudeExecutable();
  return preferred === bundled ? [preferred] : [preferred, bundled];
}

/** A CLI that never started, as opposed to one that ran and failed. */
function isSpawnFailure(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'EACCES';
}

async function runClaudeCost(executables: string[], cwd: string): Promise<string> {
  let lastError: Error | undefined;
  for (const executable of executables) {
    try {
      return await runOne(executable, cwd);
    } catch (error) {
      // Only a CLI that could not be started is worth retrying elsewhere. One
      // that ran and failed has given its answer, and trying an older copy
      // would just bury the reason.
      if (!isSpawnFailure(error)) throw error;
      lastError = error as Error;
    }
  }
  throw lastError ?? new Error('No Claude Code CLI found');
}

function runOne(executable: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // stdin is 'ignore' rather than the pipe `execFile` would hand it: an idle
    // stdin pipe makes the CLI wait three seconds for input that will never
    // arrive, then warn about it on stderr. Closing it up front takes the
    // round trip from ~5.4s to ~2.5s and keeps the warning out of the output.
    const child = spawn(executable, ['-p', '/cost'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (error: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      if (error) reject(error);
      else resolve((stdout || stderr).trim());
    };

    const timer = setTimeout(
      () => finish(new Error(`Timed out after ${COST_TIMEOUT_MS / 1000}s`)),
      COST_TIMEOUT_MS,
    );

    const collect = (into: 'out' | 'err') => (chunk: Buffer): void => {
      const text = chunk.toString('utf-8');
      if (into === 'out') stdout += text;
      else stderr += text;
      // Standing in for execFile's maxBuffer: take what we have rather than
      // growing without bound if some future build streams into `-p`.
      if (stdout.length + stderr.length > MAX_OUTPUT_BYTES) finish(null);
    };

    child.stdout.on('data', collect('out'));
    child.stderr.on('data', collect('err'));
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      // A non-zero exit that still printed the report is worth showing; only
      // an exit with nothing to show is an error.
      if (code === 0 || stdout.trim()) finish(null);
      else finish(new Error(stderr.trim() || `claude exited with code ${code}`));
    });
  });
}

/**
 * A directory the CLI can actually start in.
 *
 * A spawn whose `cwd` does not exist fails as `ENOENT <executable>` — an error
 * that sends you looking for a binary that was never the problem. Falling back
 * costs nothing here: `/cost` reports account-wide numbers, so the working
 * directory only has to be somewhere the process can stand.
 */
function resolveSpawnCwd(sessionCwd: string | undefined): string {
  for (const candidate of [sessionCwd, getWorkspaceRoot()]) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return process.cwd();
}

export async function handleCost(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  // Deliberately no session guard: limits are account-wide, so the answer is
  // the same — and just as useful — in a chat that has never opened a project.
  const session = sessionManager.getSession(sessionKey);
  const cwd = resolveSpawnCwd(session?.workingDirectory);
  const typing = ctx.replyWithChatAction?.('typing');

  try {
    const raw = await runClaudeCost(costExecutables(), cwd);
    await typing?.catch(() => { /* chat action is best-effort */ });
    await messageSender.sendMessage(ctx, parseCostOutput(raw, getSessionCost(sessionKey)));
  } catch (error) {
    console.error('[Cost] Failed to run /cost:', sanitizeError(error));
    const message = error instanceof Error ? error.message : 'Unknown error';
    const hint = /unknown|unrecognized|command/i.test(message)
      ? '\n\nThis Claude Code build may not support `/cost` yet.'
      : '';
    await messageSender.sendMessage(ctx, `❌ Failed to fetch cost: ${message}${hint}`);
  }
}
