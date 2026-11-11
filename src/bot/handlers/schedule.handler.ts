import type { Context } from 'grammy';
import { Cron } from 'croner';
import { sessionManager } from '../../claude/session-manager.js';
import { scheduler, HARD_LIMITS, type ScheduleSpec, type Schedule } from '../../claude/scheduler.js';
import { getSessionKeyFromCtx } from '../../utils/session-key.js';
import { EntityText, joinMessages, type EntityMessage } from '../../telegram/entities.js';
import { replyFormatted } from '../../telegram/send.js';

/** Text with `inline code` spans and nothing else — the parser errors below are written that way. */
function withCode(text: string): EntityMessage {
  const b = new EntityText();
  text.split(/(`[^`]+`)/).forEach((part, i) => (i % 2 === 1 ? b.code(part.slice(1, -1)) : b.add(part)));
  return b.build();
}

const EXAMPLES = [
  '/schedule every 5m check the dev server',
  '/schedule every 1h summarize git log since last hour',
  '/schedule daily 9am give me my morning standup',
  '/schedule weekdays 14:00 ping team about standups',
  '/schedule mon,wed,fri 10:30 review open PRs',
];

const USAGE: EntityMessage = (() => {
  const b = new EntityText().bold('Usage:').add(' ').code('/schedule <when> <prompt>').newline(2);
  b.bold('Examples:').newline();
  for (const example of EXAMPLES) b.code(example).newline();
  b.code('/schedule 0 9 * * * morning summary').add(' (raw cron)').newline(2);
  b.bold('Options').add(' (append at the end):').newline();
  b.code('--max-runs N').add(' cap total fires (default 50, max 500)').newline();
  b.code('--label "..."').add(' short title shown in the fire header').newline(2);
  b.add(`Hard limits: max ${HARD_LIMITS.MAX_PER_SESSION} active schedules per chat, `
    + `${HARD_LIMITS.MIN_INTERVAL_MS / 1000}s minimum interval, `
    + `${HARD_LIMITS.DEFAULT_MAX_RUNS} fires by default.`);
  return b.build();
})();

type ParsedWhen =
  | { kind: 'interval'; intervalMs: number; humanDescription: string }
  | { kind: 'cron'; cronExpr: string; humanDescription: string };

const INTERVAL_UNITS: Record<string, number> = {
  s: 1000,
  sec: 1000,
  m: 60_000,
  min: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  d: 86_400_000,
};

const DAY_OF_WEEK: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

function parseTimeOfDay(raw: string): { hour: number; minute: number } | null {
  // `9am`, `9:30am`, `14:00`, `9pm`, `12:30`
  const ampmMatch = raw.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)$/i);
  if (ampmMatch) {
    let hour = parseInt(ampmMatch[1], 10);
    const minute = ampmMatch[2] ? parseInt(ampmMatch[2], 10) : 0;
    const ampm = ampmMatch[3].toLowerCase();
    if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return null;
    if (ampm === 'pm' && hour !== 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    return { hour, minute };
  }
  const hhmmMatch = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (hhmmMatch) {
    const hour = parseInt(hhmmMatch[1], 10);
    const minute = parseInt(hhmmMatch[2], 10);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return { hour, minute };
  }
  return null;
}

/**
 * Pull `--max-runs N` and `--label "..."` out of the prompt. Mutates the
 * returned `prompt` to drop the consumed flag pairs. Quoting on `--label`
 * is required when the value spans multiple words.
 */
function extractOptions(prompt: string): { prompt: string; maxRuns?: number; label?: string } {
  let working = prompt;
  let maxRuns: number | undefined;
  let label: string | undefined;

  const maxRunsMatch = working.match(/(?:^|\s)--max-runs\s+(\d+)\b/);
  if (maxRunsMatch) {
    maxRuns = parseInt(maxRunsMatch[1], 10);
    working = (working.slice(0, maxRunsMatch.index ?? 0) + working.slice((maxRunsMatch.index ?? 0) + maxRunsMatch[0].length)).trim();
  }

  const labelMatch = working.match(/(?:^|\s)--label\s+(?:"([^"]+)"|(\S+))/);
  if (labelMatch) {
    label = labelMatch[1] ?? labelMatch[2];
    working = (working.slice(0, labelMatch.index ?? 0) + working.slice((labelMatch.index ?? 0) + labelMatch[0].length)).trim();
  }

  return { prompt: working, maxRuns, label };
}

/**
 * Parse the part of the command between `/schedule` and the prompt. Tries
 * (in order): raw 5-field cron, `every <N><unit>`, day-keyword + time-of-day.
 * Returns the consumed token count so the caller can slice the prompt off.
 */
function parseWhen(tokens: string[]): { parsed: ParsedWhen; consumed: number } | { error: string } {
  if (tokens.length === 0) return { error: 'Missing schedule specification.' };

  // Raw 5-field cron: m h dom mon dow
  if (tokens.length >= 5) {
    const candidate = tokens.slice(0, 5).join(' ');
    const looksLikeCron = /^[\d\*\-,\/\?]+(\s+[\d\*\-,\/\?A-Za-z]+){4}$/.test(candidate);
    if (looksLikeCron) {
      try {
        const job = new Cron(candidate);
        const next = job.nextRun();
        job.stop();
        if (next) {
          return {
            parsed: { kind: 'cron', cronExpr: candidate, humanDescription: candidate },
            consumed: 5,
          };
        }
      } catch { /* fall through to NL parsing */ }
    }
  }

  const first = tokens[0].toLowerCase();
  const second = tokens[1]?.toLowerCase();

  if (first === 'every') {
    if (!second) return { error: 'Missing interval after `every`.' };
    const intervalMatch = second.match(/^(\d+)([a-z]+)$/);
    if (!intervalMatch) return { error: `Unrecognized interval \`${second}\`. Try \`every 5m\`, \`every 1h\`.` };
    const amount = parseInt(intervalMatch[1], 10);
    const unitKey = intervalMatch[2];
    const unitMs = INTERVAL_UNITS[unitKey];
    if (!unitMs) return { error: `Unknown unit \`${unitKey}\`. Use s/m/h/d.` };
    const intervalMs = amount * unitMs;
    if (intervalMs < HARD_LIMITS.MIN_INTERVAL_MS) {
      return { error: `Interval must be at least ${HARD_LIMITS.MIN_INTERVAL_MS / 1000}s.` };
    }
    return {
      parsed: { kind: 'interval', intervalMs, humanDescription: `every ${amount}${unitKey}` },
      consumed: 2,
    };
  }

  // Day-of-week keywords / lists → cron with time-of-day
  let dowField: string | null = null;
  let dowLabel = first;
  if (first === 'daily') dowField = '*';
  else if (first === 'weekdays') { dowField = '1-5'; dowLabel = 'weekdays'; }
  else if (first === 'weekends') { dowField = '0,6'; dowLabel = 'weekends'; }
  else {
    // Comma-separated list of day names like `mon,wed,fri`
    const parts = first.split(',').map((p) => p.trim());
    if (parts.length > 0 && parts.every((p) => p in DAY_OF_WEEK)) {
      dowField = parts.map((p) => String(DAY_OF_WEEK[p])).join(',');
      dowLabel = parts.join(',');
    }
  }

  if (dowField !== null) {
    if (!second) return { error: 'Missing time of day. Try `daily 9am`, `weekdays 14:00`.' };
    const time = parseTimeOfDay(second);
    if (!time) return { error: `Unrecognized time \`${second}\`. Try \`9am\`, \`14:00\`, \`9:30pm\`.` };
    const cronExpr = `${time.minute} ${time.hour} * * ${dowField}`;
    return {
      parsed: {
        kind: 'cron',
        cronExpr,
        humanDescription: `${dowLabel} at ${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`,
      },
      consumed: 2,
    };
  }

  return { error: `Couldn't parse schedule. Type \`/schedule\` with no args to see examples.` };
}

function formatSchedule(s: Schedule): EntityMessage {
  const status = s.disabled ? ' (disabled)' : '';
  const when = s.kind === 'interval'
    ? `every ${Math.round((s.intervalMs ?? 0) / 1000)}s`
    : (s.cronExpr ?? '?');
  const next = scheduler.nextFireAt(s.id);
  const nextLine = next ? `\nnext: ${new Date(next).toLocaleString()}` : '';
  const labelLine = s.label ? `\nlabel: ${s.label}` : '';
  const promptPreview = s.prompt.length > 80 ? s.prompt.slice(0, 77) + '...' : s.prompt;
  return new EntityText()
    .code(s.id)
    .add(`${status}\n${when}${labelLine}\nruns: ${s.runs}/${s.maxRuns}${nextLine}\nprompt: ${promptPreview}`)
    .build();
}

export async function handleSchedule(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const text = (ctx.message?.text ?? '').trim();
  const stripped = text.replace(/^\/schedule(?:@\w+)?\s*/i, '');
  if (!stripped) {
    await replyFormatted(ctx, USAGE);
    return;
  }

  // Session required so the schedule can resume into a real project later.
  const session = sessionManager.getSession(sessionKey)
    ?? sessionManager.getOrRestoreSession(sessionKey).session;
  if (!session) {
    await replyFormatted(ctx, withCode('⚠️ No project set. Use `/project` or `/continue` first, then create the schedule.'));
    return;
  }

  // Split off options first so they don't get eaten by the `when` parser.
  const { prompt: promptWithoutOpts, maxRuns, label } = extractOptions(stripped);

  // Honor `--` separator if present.
  const sepIdx = promptWithoutOpts.indexOf(' -- ');
  let whenPart: string;
  let promptPart: string;
  if (sepIdx >= 0) {
    whenPart = promptWithoutOpts.slice(0, sepIdx).trim();
    promptPart = promptWithoutOpts.slice(sepIdx + 4).trim();
  } else {
    whenPart = promptWithoutOpts;
    promptPart = '';
  }

  const whenTokens = whenPart.split(/\s+/).filter(Boolean);
  const parseResult = parseWhen(whenTokens);
  if ('error' in parseResult) {
    await replyFormatted(ctx, joinMessages([withCode(`❌ ${parseResult.error}`), USAGE]));
    return;
  }
  const { parsed, consumed } = parseResult;

  if (sepIdx < 0) {
    // No explicit `--` — take the remaining tokens as the prompt.
    promptPart = whenTokens.slice(consumed).join(' ').trim();
  }
  if (!promptPart) {
    await replyFormatted(ctx, '❌ Missing prompt. After the schedule spec, add the prompt to run on each fire.');
    return;
  }

  const spec: ScheduleSpec = {
    sessionKey,
    cwd: session.workingDirectory,
    claudeSessionId: session.claudeSessionId,
    prompt: promptPart,
    label,
    maxRuns,
    ...(parsed.kind === 'interval'
      ? { kind: 'interval' as const, intervalMs: parsed.intervalMs }
      : { kind: 'cron' as const, cronExpr: parsed.cronExpr }),
  };

  let created: Schedule;
  try {
    created = scheduler.createSchedule(spec);
  } catch (err) {
    await replyFormatted(ctx, `❌ ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const next = scheduler.nextFireAt(created.id);
  const b = new EntityText()
    .add('✅ ').bold('Schedule created').newline()
    .add('id: ').code(created.id).newline()
    .add(`when: ${parsed.humanDescription}\n`)
    .add(`max runs: ${created.maxRuns}`);
  if (next) b.add('\nNext fire: ').code(new Date(next).toLocaleString());
  b.newline(2).add('Use ').code('/schedules').add(' to list, ').code(`/unschedule ${created.id}`).add(' to remove.');
  await replyFormatted(ctx, b.build());
}

export async function handleSchedules(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const list = scheduler.listSchedules(sessionKey);
  if (list.length === 0) {
    await replyFormatted(ctx, withCode('No active schedules. Create one with `/schedule <when> <prompt>`.'));
    return;
  }

  const heading = new EntityText().add('📋 ').bold('Schedules').add(` (${list.length})`).build();
  await replyFormatted(ctx, joinMessages([heading, ...list.map(formatSchedule)]));
}

export async function handleUnschedule(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const text = (ctx.message?.text ?? '').trim();
  const id = text.replace(/^\/unschedule(?:@\w+)?\s*/i, '').trim();
  if (!id) {
    await replyFormatted(ctx, withCode('Usage: `/unschedule <id>`. Use `/schedules` to see ids.'));
    return;
  }

  const target = scheduler.getSchedule(id);
  if (!target || target.sessionKey !== sessionKey) {
    await replyFormatted(ctx, new EntityText().add('❌ No schedule ').code(id).add(' in this chat.').build());
    return;
  }

  scheduler.deleteSchedule(id);
  await replyFormatted(ctx, new EntityText().add('✅ Removed schedule ').code(id).add('.').build());
}
