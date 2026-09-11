/**
 * A time-boxed window in which the permission gate approves instead of asking.
 *
 * The gate costs one button tap per guarded tool call, which is right when the
 * calls are rare and wrong when someone is doing a job made of them — a
 * dependency bump that runs `rm -rf node_modules` four times, a rebase that
 * force-pushes twice. The person supervising ends up tapping a prompt they had
 * already decided about before the run started, and a guardrail people tap
 * without reading is worse than one that isn't there.
 *
 * So the decision can be made once, in advance, for a stated length of time.
 * What a window is *not* is a mode: it does not change what the gate matches,
 * it does not reach the charter judge, and it cannot be opened by a guest. It
 * only answers the prompts that would otherwise be posted, and says so in the
 * chat each time, so the window trades a tap for a line in the log rather than
 * for silence.
 *
 * Three properties make that trade safe, and all three are load-bearing:
 *
 *   - It expires on its own, and the expiry is announced. A supervision hole
 *     nobody remembers opening is the failure mode to avoid.
 *   - It is per chat and lives only in memory, so a restart closes every
 *     window. The safe direction to fail is closed.
 *   - The irreversible patterns still prompt. Tedium is the problem being
 *     solved; `mkfs` and `DROP DATABASE` are not tedium.
 */

/** Shortest window worth opening. Below this the tap would have been cheaper. */
export const MIN_WINDOW_MS = 60 * 1000;

/**
 * Longest window. Four hours is about a working session; a window that can
 * outlive the attention of the person who opened it is the thing this cap
 * exists to prevent, and re-opening one is a single command.
 */
export const MAX_WINDOW_MS = 4 * 60 * 60 * 1000;

/** What `/autoapprove` with no duration means. */
export const DEFAULT_WINDOW_MS = 30 * 60 * 1000;

export interface AutoApproveWindow {
  chatId: number;
  /** Who opened it. Named in the announcement and in every approval line. */
  openedBy: number;
  openedByName: string;
  openedAt: number;
  expiresAt: number;
  /** How many calls it has waved through. Reported when it closes. */
  approved: number;
}

interface Entry {
  window: AutoApproveWindow;
  timer?: NodeJS.Timeout;
  onExpire?: (window: AutoApproveWindow) => void;
  /** Guards against announcing an expiry twice when both paths notice it. */
  finished: boolean;
}

/**
 * Deliberately a plain Map and deliberately not persisted. A window is a
 * statement about the next half hour by someone who is present; surviving a
 * restart would make it a statement about a half hour nobody was watching.
 */
const entries = new Map<number, Entry>();

/**
 * Gate reasons that a window never answers for.
 *
 * The line is not "dangerous" — everything the gate matches is dangerous, or
 * it would not be matched. It is whether a wrong call can be walked back. A
 * force-push can be undone from a reflog, a dropped *database* cannot, and
 * neither can a filesystem written over. Those keep their prompt, so a window
 * left open by accident still cannot cost you the machine.
 */
const ALWAYS_PROMPT_REASONS = new Set([
  'destructive disk op',
  'DROP DATABASE',
  'terraform destroy',
]);

/**
 * The scope guard's credential verdict, which arrives as
 * `"reads a credential or bot-state path — <path>"`. Reading `~/.ssh/id_rsa` is
 * not tedium either, and a window is not consent to it.
 */
const CREDENTIAL_REASON = 'reads a credential or bot-state path';

/** True when this gate reason must be asked about even inside a window. */
export function alwaysPrompts(reason: string): boolean {
  if (ALWAYS_PROMPT_REASONS.has(reason)) return true;
  return reason.startsWith(CREDENTIAL_REASON);
}

/**
 * What a window never covers, phrased for the person reading the chat rather
 * than for the matcher. `alwaysPrompts()` above is the matcher; these are
 * labels, and the two are meant to drift apart — "destructive disk op" is an
 * accurate reason and a poor thing to read in a list of what is still guarded.
 */
export function listAlwaysPrompted(): string[] {
  return [
    'mkfs, or dd writing to a device',
    'DROP DATABASE',
    'terraform destroy',
    'reading a credential or bot-state path',
  ];
}

/** Close an entry and tell whoever asked to be told. Idempotent. */
function finish(chatId: number, notify: boolean): AutoApproveWindow | null {
  const entry = entries.get(chatId);
  if (!entry) return null;

  entries.delete(chatId);
  if (entry.timer) clearTimeout(entry.timer);
  if (entry.finished) return entry.window;
  entry.finished = true;

  if (notify && entry.onExpire) {
    try {
      entry.onExpire(entry.window);
    } catch {
      // The announcement is best-effort: a chat that has gone away must not
      // keep a window alive, and this runs on a bare timer with no catcher.
    }
  }
  return entry.window;
}

/**
 * The open window for this chat, or null.
 *
 * Expiry is decided here rather than trusted to the timer, so a timer that was
 * never scheduled, or fired late, can only ever close a window early — never
 * leave a lapsed one answering prompts.
 */
export function getWindow(chatId: number): AutoApproveWindow | null {
  const entry = entries.get(chatId);
  if (!entry) return null;
  if (Date.now() >= entry.window.expiresAt) {
    finish(chatId, true);
    return null;
  }
  return entry.window;
}

export interface OpenOptions {
  openedBy: number;
  openedByName: string;
  durationMs: number;
  /** Called when the window lapses of its own accord. Not called by close(). */
  onExpire?: (window: AutoApproveWindow) => void;
}

/**
 * Open a window on this chat, replacing any window already open.
 *
 * Replacing rather than extending: someone re-running the command has a length
 * in mind, and reading "50 min left" after asking for 30 is the kind of
 * surprise a supervision feature cannot afford.
 */
export function openWindow(chatId: number, opts: OpenOptions): AutoApproveWindow {
  finish(chatId, false);

  const now = Date.now();
  const window: AutoApproveWindow = {
    chatId,
    openedBy: opts.openedBy,
    openedByName: opts.openedByName,
    openedAt: now,
    expiresAt: now + opts.durationMs,
    approved: 0,
  };

  const entry: Entry = { window, onExpire: opts.onExpire, finished: false };
  // unref so a pending window never holds the process open through a shutdown.
  entry.timer = setTimeout(() => finish(chatId, true), opts.durationMs);
  entry.timer.unref?.();
  entries.set(chatId, entry);

  return window;
}

/**
 * Close a window early. Returns what was closed, or null if nothing was open.
 * The expiry announcement is suppressed — whoever ran the command is already
 * being answered.
 */
export function closeWindow(chatId: number): AutoApproveWindow | null {
  const entry = entries.get(chatId);
  if (!entry) return null;
  return finish(chatId, false);
}

/**
 * Decide whether an open window answers this prompt, and count it if so.
 *
 * Returns the window — with `approved` already incremented — when the call may
 * proceed without asking, and null when the gate should post its prompt as
 * usual. Null covers all three of: no window, a lapsed one, and a reason no
 * window ever answers for.
 */
export function consumeAutoApproval(chatId: number, reason: string): AutoApproveWindow | null {
  if (alwaysPrompts(reason)) return null;
  const window = getWindow(chatId);
  if (!window) return null;
  window.approved += 1;
  return window;
}

export type DurationResult =
  | { ok: true; ms: number }
  | { ok: false; error: string };

/**
 * Parse `30m`, `2h`, `90s`, or a bare number read as minutes.
 *
 * Bare numbers are minutes rather than milliseconds because this is typed into
 * a chat by a person: `/autoapprove 30` means half an hour to everyone who
 * would type it.
 */
export function parseWindowDuration(raw: string): DurationResult {
  const text = raw.trim().toLowerCase();
  if (!text) return { ok: true, ms: DEFAULT_WINDOW_MS };

  const match = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|m|min|mins|h|hr|hrs)?$/.exec(text);
  if (!match) {
    return { ok: false, error: 'I could not read that as a length of time. Try 30m, 2h or 90s.' };
  }

  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) {
    return { ok: false, error: 'That has to be a positive length of time.' };
  }

  const unit = match[2] ?? 'm';
  const perUnit = unit.startsWith('s') ? 1000 : unit.startsWith('h') ? 3600_000 : 60_000;
  const ms = Math.round(value * perUnit);

  if (ms < MIN_WINDOW_MS) {
    return { ok: false, error: `The shortest window is ${formatDuration(MIN_WINDOW_MS)} — below that, tapping the prompt is quicker.` };
  }
  if (ms > MAX_WINDOW_MS) {
    return { ok: false, error: `The longest window is ${formatDuration(MAX_WINDOW_MS)}. Open another one when it lapses.` };
  }
  return { ok: true, ms };
}

/** "45 min", "2 h", "1 h 30 min" — for announcements and status lines. */
export function formatDuration(ms: number): string {
  const totalMinutes = Math.max(1, Math.round(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  if (minutes === 0) return `${hours} h`;
  return `${hours} h ${minutes} min`;
}

/** How long this window has left, already formatted. */
export function formatRemaining(window: AutoApproveWindow): string {
  return formatDuration(Math.max(0, window.expiresAt - Date.now()));
}

/** Test seam — production keeps windows for the life of the process. */
export function resetAutoApprove(): void {
  for (const chatId of [...entries.keys()]) finish(chatId, false);
}
