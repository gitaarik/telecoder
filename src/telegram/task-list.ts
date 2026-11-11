/**
 * Claude Code's task list, mirrored into the chat.
 *
 * Claude Code keeps the list with four tools: TaskCreate and TaskUpdate write
 * it, TaskList and TaskGet read it. None of their inputs carries the whole list
 * (TodoWrite, which they replaced, sent the complete array on every call), so
 * the list is read from where Claude Code stores it: one JSON file per task in
 * `~/.claude/tasks/<session id>/`. That works the same for both transports, and
 * it is also what lets a restored session show the list it left off with.
 *
 * The rendering copies the CLI's own task panel (2.1.322, the component that
 * draws `N tasks (X done, Y in progress, Z open)`):
 *
 *   3 tasks (1 done, 1 in progress, 1 open)
 *   ✔ Write the changelog              completed: struck through, dimmed
 *   ◼ Run the tests                    in progress: bold
 *   ◻ Tag the release › blocked by #2  pending; the note lists open blockers
 *
 * The rows show the subject (never `activeForm`), sorted by numeric id. The
 * header is dimmed with its counts in bold, and "in progress" is left out when
 * nothing is. Telegram has no dim, so dimmed text is italic here; the TUI's
 * colours (green tick, orange square) have no equivalent either.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GrammyError, type Api } from 'grammy';
import { EntityText, type EntityMessage } from './entities.js';
import { sendFormatted, editFormatted } from './send.js';
import { parseSessionKey } from '../utils/session-key.js';
import { sessionManager } from '../claude/session-manager.js';

export type TaskStatus = 'pending' | 'in_progress' | 'completed';

export interface TaskItem {
  id: string;
  subject: string;
  description?: string;
  activeForm?: string;
  status: TaskStatus;
  blocks: string[];
  blockedBy: string[];
  owner?: string;
}

export interface TaskListRead {
  tasks: TaskItem[];
  /** A task file could not be read or parsed — most likely caught mid-write. */
  partial: boolean;
}

/** The tools that change the list; a call to one means the card is stale. */
export const TASK_WRITE_TOOLS: ReadonlySet<string> = new Set(['TaskCreate', 'TaskUpdate']);

/** Every task-list tool, reads included. */
export const TASK_TOOLS: ReadonlySet<string> = new Set(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);

// Claude Code's `figures`: tick, squareSmallFilled, squareSmall, pointerSmall.
// Each square and the tick also exist as emoji, which some Telegram clients
// draw in colour at emoji size; U+FE0E asks for the text glyph the TUI shows.
const TEXT_STYLE = '\uFE0E';
const GLYPHS: Record<TaskStatus, string> = {
  completed: `✔${TEXT_STYLE}`,
  in_progress: `◼${TEXT_STYLE}`,
  pending: `◻${TEXT_STYLE}`,
};
const POINTER_SMALL = '›';

/** Where Claude Code keeps a session's task list (its `tasks/<id>` directory). */
export function taskListDir(claudeSessionId: string): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  // Claude Code sanitises the list id the same way before using it as a name.
  return path.join(configDir, 'tasks', claudeSessionId.replace(/[^a-zA-Z0-9_-]/g, '-'));
}

/** Claude Code's own order: numeric ids numerically, anything else by name. */
function compareIds(a: string, b: string): number {
  const x = parseInt(a, 10);
  const y = parseInt(b, 10);
  if (!Number.isNaN(x) && !Number.isNaN(y)) return x - y;
  return a.localeCompare(b);
}

const STATUSES: ReadonlySet<string> = new Set(['pending', 'in_progress', 'completed']);

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** One task file's contents, or null if it isn't a task. */
export function parseTask(raw: string): TaskItem | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const t = data as Record<string, unknown>;
  if (typeof t.id !== 'string' || typeof t.subject !== 'string') return null;
  if (typeof t.status !== 'string' || !STATUSES.has(t.status)) return null;
  return {
    id: t.id,
    subject: t.subject,
    description: typeof t.description === 'string' ? t.description : undefined,
    activeForm: typeof t.activeForm === 'string' ? t.activeForm : undefined,
    status: t.status as TaskStatus,
    blocks: stringList(t.blocks),
    blockedBy: stringList(t.blockedBy),
    owner: typeof t.owner === 'string' ? t.owner : undefined,
  };
}

/**
 * Read a session's task list. A missing directory is an empty list. A file
 * that won't parse is left out and reported as `partial`: Claude Code may be
 * writing it at that moment, so the caller can look again shortly.
 */
export function readTaskList(claudeSessionId: string, dir = taskListDir(claudeSessionId)): TaskListRead {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { tasks: [], partial: false };
  }
  const tasks: TaskItem[] = [];
  let partial = false;
  // Claude Code's own filter: `.lock` and its other dotfiles are not tasks.
  for (const name of names) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(dir, name), 'utf-8');
    } catch {
      // Deleted between the listing and the read: Claude Code clears a list
      // file by file. Not partial — the next read won't find it either.
      continue;
    }
    const task = parseTask(raw);
    if (task) tasks.push(task);
    else partial = true;
  }
  tasks.sort((a, b) => compareIds(a.id, b.id));
  return { tasks, partial };
}

/** The list as Claude Code's task panel draws it, or null when there is none. */
export function renderTaskList(tasks: TaskItem[]): EntityMessage | null {
  if (tasks.length === 0) return null;
  const sorted = [...tasks].sort((a, b) => compareIds(a.id, b.id));
  const done = sorted.filter((t) => t.status === 'completed').length;
  const open = sorted.filter((t) => t.status === 'pending').length;
  const inProgress = sorted.length - done - open;
  // A blocker only counts while it is a task on the list that isn't done.
  const unfinished = new Set(sorted.filter((t) => t.status !== 'completed').map((t) => t.id));

  const b = new EntityText();
  b.wrap('italic', (h) => {
    h.bold(String(sorted.length)).add(' tasks (').bold(String(done)).add(' done, ');
    if (inProgress > 0) h.bold(String(inProgress)).add(' in progress, ');
    h.bold(String(open)).add(' open)');
  });

  for (const task of sorted) {
    b.newline().add(`${GLYPHS[task.status]} `);
    const subject = task.subject.trim() || `#${task.id}`;
    if (task.status === 'completed') b.strikethrough(subject);
    else if (task.status === 'in_progress') b.bold(subject);
    else b.add(subject);

    const blockers = task.blockedBy.filter((id) => unfinished.has(id)).sort(compareIds);
    if (blockers.length > 0) {
      b.italic(` ${POINTER_SMALL} blocked by ${blockers.map((id) => `#${id}`).join(', ')}`);
    }
  }
  return b.build();
}

/** Read and render in one step; null when the session has no tasks. */
export function renderSessionTaskList(claudeSessionId: string): EntityMessage | null {
  return renderTaskList(readTaskList(claudeSessionId).tasks);
}

// After a TaskCreate/TaskUpdate starts, look at the files this long after —
// again and again while nothing has changed, since the write lands some time
// after the tool starts and the SDK transport's tool-end signal is not sent
// for every call. A list that renders the same costs a directory read.
const DIRTY_RECHECK_MS = [300, 1000, 2500, 5000];
// A file caught mid-write is read again after this long, this many times;
// after that it is taken to be broken for good and left out.
const PARTIAL_RETRY_MS = 250;
const PARTIAL_RETRY_MAX = 8;

interface LiveState {
  /** The card posted this turn, edited in place on later changes. */
  messageId: number | null;
  lastText: string;
  /** The Claude session the card shows; another one gets a card of its own. */
  shownFor?: string;
  /** Set by startTurn: the next change posts a fresh card below. */
  newTurn: boolean;
  /** A write started and the card hasn't shown a change since. */
  dirty: boolean;
  recheck: number;
  partialRetries: number;
  timer: NodeJS.Timeout | null;
  /** Serialises refreshes so two changes can't both post a first card. */
  chain: Promise<boolean>;
  api: Api | null;
  /** The id the caller passed with the last write, if it passed one. */
  claudeSessionId?: string;
}

export interface TaskListDisplayOptions {
  /** Default: the session manager's Claude session id for the key. */
  getClaudeSessionId?: (sessionKey: string) => string | undefined;
  read?: (claudeSessionId: string) => TaskListRead;
}

function isNotModified(err: unknown): boolean {
  return err instanceof GrammyError && err.description.includes('message is not modified');
}

/**
 * One live task-list card per session: posted on the turn's first change,
 * edited in place on every later one, and posted afresh in the next turn.
 */
export class TaskListDisplay {
  private states = new Map<string, LiveState>();
  private postListener: ((sessionKey: string) => void) | null = null;
  private readonly getClaudeSessionId: (sessionKey: string) => string | undefined;
  private readonly read: (claudeSessionId: string) => TaskListRead;

  constructor(options: TaskListDisplayOptions = {}) {
    this.getClaudeSessionId = options.getClaudeSessionId
      ?? ((sessionKey) => sessionManager.getSession(sessionKey)?.claudeSessionId);
    this.read = options.read ?? ((id) => readTaskList(id));
  }

  /**
   * Called for every new card a live refresh posts, timer-driven ones included
   * — the message sender counts those as posts that bury the status bubble.
   */
  onPost(listener: ((sessionKey: string) => void) | null): void {
    this.postListener = listener;
  }

  private state(sessionKey: string): LiveState {
    let s = this.states.get(sessionKey);
    if (!s) {
      s = {
        messageId: null, lastText: '', newTurn: false, dirty: false, recheck: 0, partialRetries: 0,
        timer: null, chain: Promise.resolve(false), api: null,
      };
      this.states.set(sessionKey, s);
    }
    return s;
  }

  /** A new turn: its first change to the list posts a new card. */
  startTurn(sessionKey: string): void {
    const s = this.states.get(sessionKey);
    if (!s) return;
    s.newTurn = true;
  }

  /**
   * A tool started. A TaskCreate or TaskUpdate marks the card stale and
   * schedules a look at the files; anything else is ignored.
   */
  noteToolStart(api: Api, sessionKey: string, toolName: string, claudeSessionId?: string): void {
    if (!TASK_WRITE_TOOLS.has(toolName)) return;
    const s = this.state(sessionKey);
    s.api = api;
    s.claudeSessionId = claudeSessionId;
    s.dirty = true;
    s.recheck = 0;
    s.partialRetries = 0;
    this.schedule(sessionKey, DIRTY_RECHECK_MS[0]);
  }

  /** A tool finished (no name is known here): refresh now if a write was pending. */
  noteToolEnd(sessionKey: string): void {
    const s = this.states.get(sessionKey);
    if (!s?.dirty || !s.api) return;
    this.schedule(sessionKey, 0);
  }

  /** Stop the timers of a session whose turn is over, after one last look. */
  async flush(sessionKey: string): Promise<boolean> {
    const s = this.states.get(sessionKey);
    if (!s?.dirty || !s.api) return false;
    this.cancelTimer(s);
    const posted = await this.refresh(s.api, sessionKey, s.claudeSessionId);
    s.dirty = false;
    this.cancelTimer(s);
    return posted;
  }

  /** Forget a session entirely (e.g. on /clear). */
  reset(sessionKey: string): void {
    const s = this.states.get(sessionKey);
    if (s) this.cancelTimer(s);
    this.states.delete(sessionKey);
  }

  private cancelTimer(s: LiveState): void {
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
  }

  private schedule(sessionKey: string, delayMs: number): void {
    const s = this.state(sessionKey);
    this.cancelTimer(s);
    s.timer = setTimeout(() => {
      s.timer = null;
      if (!s.api) return;
      this.refresh(s.api, sessionKey, s.claudeSessionId).catch((err) => {
        console.error('[TaskList] Refresh failed:', err instanceof Error ? err.message : err);
      });
    }, delayMs);
    s.timer.unref?.();
  }

  /**
   * Draw the session's list: post it on the turn's first change, edit the card
   * after that, and do nothing when it would read the same. Returns whether a
   * new message was posted.
   */
  refresh(api: Api, sessionKey: string, claudeSessionId?: string): Promise<boolean> {
    const s = this.state(sessionKey);
    s.api = api;
    if (claudeSessionId !== undefined) s.claudeSessionId = claudeSessionId;
    const run = s.chain.then(
      () => this.doRefresh(api, sessionKey, s),
      () => this.doRefresh(api, sessionKey, s),
    );
    s.chain = run.catch(() => false);
    return run;
  }

  private async doRefresh(api: Api, sessionKey: string, s: LiveState): Promise<boolean> {
    // Resolved on every refresh: /resume can move the key to another session.
    const id = s.claudeSessionId ?? this.getClaudeSessionId(sessionKey);
    if (!id) return false;

    const read = this.read(id);
    // A file still unreadable after the retries is broken, not mid-write.
    const partial = read.partial && s.partialRetries < PARTIAL_RETRY_MAX;
    const message = renderTaskList(read.tasks);
    const sameSession = s.shownFor === id;
    const changed = !!message && (!sameSession || message.text !== s.lastText);

    // Called from a timer (or with none pending) while a write is unseen:
    // decide whether to look again.
    if (s.dirty && !s.timer) {
      if (partial) {
        s.partialRetries += 1;
        this.schedule(sessionKey, PARTIAL_RETRY_MS);
      } else if (changed || s.recheck + 1 >= DIRTY_RECHECK_MS.length) {
        s.dirty = false;
      } else {
        s.recheck += 1;
        this.schedule(sessionKey, DIRTY_RECHECK_MS[s.recheck]);
      }
    }
    // Don't draw a list with a task missing because its file was mid-write;
    // the retry above draws it whole.
    if (partial || !message || !changed) return false;

    const { chatId, threadId } = parseSessionKey(sessionKey);
    if (s.messageId !== null && !s.newTurn && sameSession) {
      try {
        await editFormatted(api, chatId, s.messageId, message);
        s.lastText = message.text;
        return false;
      } catch (err) {
        if (isNotModified(err)) {
          s.lastText = message.text;
          return false;
        }
        // Deleted, or too old to edit: post a fresh card below.
        console.warn('[TaskList] Edit failed, posting a new card:', err instanceof Error ? err.message : err);
      }
    }

    const sent = await sendFormatted(api, chatId, message, threadId !== undefined ? { message_thread_id: threadId } : {});
    s.messageId = sent.message_id;
    s.lastText = message.text;
    s.shownFor = id;
    s.newTurn = false;
    this.postListener?.(sessionKey);
    return true;
  }

  /**
   * Post a restored session's whole list, if it has one. The card is not
   * adopted for live edits: the session's next change posts its own, below
   * whatever the restore printed after this. Returns whether it posted.
   */
  async showRestored(api: Api, sessionKey: string, claudeSessionId: string | undefined): Promise<boolean> {
    if (!claudeSessionId) return false;
    const message = renderTaskList(this.read(claudeSessionId).tasks);
    if (!message) return false;
    const { threadId, chatId } = parseSessionKey(sessionKey);
    try {
      await sendFormatted(api, chatId, message, threadId !== undefined ? { message_thread_id: threadId } : {});
    } catch (err) {
      console.error('[TaskList] Failed to show restored list:', err instanceof Error ? err.message : err);
      return false;
    }
    // A live card from before belongs above the restore; the next change gets a new one.
    this.startTurn(sessionKey);
    return true;
  }
}

export const taskListDisplay = new TaskListDisplay();
