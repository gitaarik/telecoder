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
 * That second shape is session-scoped, and no probe recovers it. The cost
 * counter lives in the CLI process that spent it: resume the session in a
 * fresh process and it reads zero, because the session log carries no cost
 * field to rebuild it from. So the totals a spawned probe reports are its own,
 * not the conversation's, and `parseCostOutput` says so rather than letting a
 * $0.00 read as this chat having been free.
 *
 * Since the probe is a fresh process either way, it needs no session and no
 * `--resume` — nothing here can append a stray turn to a live conversation,
 * and the command answers before a project is even open.
 *
 * What the probe can't have, the chat's own claude still holds. In PTY mode
 * there is a live TUI a `/cost` away from drawing exactly those totals, so we
 * ask it too and scrape the Session block off the overlay — the same trick
 * /tasks uses. That is where "Total cost", the durations, the per-model
 * breakdown and the prompt-cache line come from, and it is why the report is
 * fuller in PTY mode than in SDK mode, where the totals stay unanswerable and
 * TeleCoder's own per-turn tally stands in.
 *
 * Two sources, one report, no overlap: the panel's own limits view is left
 * unscraped (it scrolls off the first screenful anyway) and read from the
 * probe, which prints the same numbers in any mode.
 */

import { Context } from 'grammy';
import { spawn } from 'child_process';
import * as fs from 'fs';
import { sessionManager } from '../../../claude/session-manager.js';
import { config } from '../../../config.js';
import { getSessionCost, type SessionCost } from '../../../claude/session-cost.js';
import { scrapeCostSession, type CostSession } from '../../../claude/cost-overlay-scraper.js';
import { getActiveMethod, getPtyProvider } from '../../../providers/claude-provider.js';
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
 * Turn the Session block scraped off the live TUI into report lines.
 *
 * Kept close to the panel's own layout — same labels, same order, the
 * per-model rows still nested under `Usage by model` — because this is the
 * half of the report people already know from typing `/cost` in a terminal.
 */
function renderSessionBlock(session: CostSession): string[] {
  const lines = ['**This session**'];
  for (const row of session.rows) {
    if (row.nested) {
      // A model's own line. Two spaces is the least indentation Telegram will
      // render as a nested bullet rather than flatten into its parent.
      lines.push(`  - \`${row.label}\`: ${row.value}`);
    } else if (row.value) {
      lines.push(`- **${row.label}:** ${row.value}`);
    } else {
      // `Usage by model:` and friends — a label whose value is the rows below.
      lines.push(`- **${row.label}:**`);
    }
  }
  return lines;
}

/**
 * Render `claude -p /cost` output as Telegram markdown.
 *
 * `chatCost` is TeleCoder's own running tally for this conversation, used in
 * SDK mode where nothing else can answer what the chat has spent.
 *
 * `session` is the Session block off the live TUI's `/cost` panel — the real
 * totals for this conversation, present only in PTY mode. When we have it, the
 * probe's own `Total ...` rows are dropped rather than printed alongside: they
 * belong to the process that ran the lookup, and two contradicting sets of
 * totals in one message is worse than the one true set.
 */
export function parseCostOutput(
  raw: string,
  chatCost?: SessionCost,
  session?: CostSession | null,
): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    // The probe failing doesn't make the live totals worthless — they are the
    // part people came for, so show them alone rather than only an error.
    if (session) return ['## 💰 Cost & Usage', '', ...renderSessionBlock(session)].join('\n');
    return '⚠️ No cost output received.';
  }

  const body: string[] = [];
  let recognised = 0;
  let sawTotals = false;
  /**
   * Inside the probe's own `Usage by model:` section, which the live block
   * supersedes. Its rows are indented, and so are the per-period detail rows
   * further down that we do want, so dropping them takes knowing which
   * heading we are under.
   */
  let underSupersededModels = false;

  /** Collapse runs of blank lines, and never open a section with one. */
  const pushBlank = (): void => {
    if (body.length > 0 && body[body.length - 1] !== '') body.push('');
  };

  for (const rawLine of trimmed.split('\n')) {
    const line = rawLine.trim();
    // Any unindented line — or a blank one — closes whatever section we were in.
    if (!line || !/^\s/.test(rawLine)) underSupersededModels = false;
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
      // Recognised either way — the line is understood, it is just superseded.
      if (!session) {
        body.push(`- **${totals[1]}:** ${totals[2].trim()}`);
        sawTotals = true;
      }
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
      if (session) {
        underSupersededModels = true;
      } else {
        pushBlank();
        body.push('**Usage by model**');
      }
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
      if (!underSupersededModels) body.push(`- ${line}`);
      continue;
    }

    // Framing prose ("You are currently using your subscription…", the
    // "Approximate, based on local sessions…" caveat) — kept, because the
    // caveat is the part that says these numbers miss your other machines.
    body.push(`_${line}_`);
  }

  const lines = ['## 💰 Cost & Usage', ''];
  if (session) {
    lines.push(...renderSessionBlock(session), '');
  }
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

/**
 * Why the live totals aren't in this report, in the chat's own terms.
 *
 * Every one of these means the report still goes out, carrying the limits view
 * it has always carried. But saying nothing was worse than the missing
 * numbers: a blank where a Session block should be looks like the feature is
 * broken, when three of the four causes clear by themselves.
 *
 * `no-session` under SDK mode is the exception, and the only silent one — that
 * transport has no TUI to read and never will, so there is no news in saying
 * so on every `/cost`.
 */
export function explainMissingTotals(
  reason: 'no-session' | 'turn-active' | 'not-ready' | 'unreadable',
  method: 'sdk' | 'pty',
): string | null {
  switch (reason) {
    case 'turn-active':
      return "This session's totals need the TUI, which is mid-turn — ask again when it finishes.";
    case 'not-ready':
      return "This session's totals need the TUI, which isn't at its prompt — a dialog may be waiting. Ask again in a moment.";
    case 'no-session':
      return method === 'pty'
        ? "This chat has no live session yet, so there are no totals to read — send a message first."
        : null;
    case 'unreadable':
      // The panel is a Claude Code implementation detail and can move between
      // releases. Say that plainly rather than leave a silent gap.
      return "Couldn't read this session's totals — Claude Code may have changed its `/cost` panel.";
  }
}

/**
 * The chat's own totals, read off the live TUI's `/cost` panel.
 *
 * PTY-only, and best-effort in every failure it can meet: no live session, a
 * turn holding the keyboard, a panel whose layout has moved on. None is worth
 * failing the command over — but each is worth naming, in the log for us and
 * in the report for whoever is looking at the gap.
 */
async function readLiveSessionTotals(
  sessionKey: string,
  method: 'sdk' | 'pty',
): Promise<{ session: CostSession | null; note: string | null }> {
  const miss = (reason: 'no-session' | 'turn-active' | 'not-ready' | 'unreadable') => {
    console.warn(`[Cost] no live session totals for ${sessionKey}: ${reason} (method=${method})`);
    return { session: null, note: explainMissingTotals(reason, method) };
  };

  try {
    const result = await getPtyProvider().runOverlayCommand(sessionKey, '/cost');
    if (!result.ok) return miss(result.reason);
    const session = scrapeCostSession(result.screen);
    return session ? { session, note: null } : miss('unreadable');
  } catch (error) {
    console.warn('[Cost] Could not read the live /cost panel:', sanitizeError(error));
    return { session: null, note: explainMissingTotals('unreadable', method) };
  }
}

export async function handleCost(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { chatId, sessionKey } = keyInfo;

  // Deliberately no session guard: limits are account-wide, so the answer is
  // the same — and just as useful — in a chat that has never opened a project.
  const session = sessionManager.getSession(sessionKey);
  const cwd = resolveSpawnCwd(session?.workingDirectory);
  const typing = ctx.replyWithChatAction?.('typing');

  try {
    // Concurrently: the probe is a process launch, the panel is a keystroke
    // into a process already running, and neither waits on the other.
    const [raw, live] = await Promise.all([
      runClaudeCost(costExecutables(), cwd),
      readLiveSessionTotals(sessionKey, getActiveMethod(chatId)),
    ]);
    await typing?.catch(() => { /* chat action is best-effort */ });
    let report = parseCostOutput(raw, getSessionCost(sessionKey), live.session);
    if (live.note) report += `\n\n_${live.note}_`;
    await messageSender.sendMessage(ctx, report);
  } catch (error) {
    console.error('[Cost] Failed to run /cost:', sanitizeError(error));
    const message = error instanceof Error ? error.message : 'Unknown error';
    const hint = /unknown|unrecognized|command/i.test(message)
      ? '\n\nThis Claude Code build may not support `/cost` yet.'
      : '';
    await messageSender.sendMessage(ctx, `❌ Failed to fetch cost: ${message}${hint}`);
  }
}
