/**
 * The conversations Claude Code has on disk, listed the way its own /resume
 * picker lists them — so a session started in a terminal, in another bot or
 * in a PTY this chat no longer remembers can be picked up from Telegram too.
 *
 * Claude Code writes one transcript per session under
 * ~/.claude/projects/<encoded cwd>/<id>.jsonl. Its picker leaves out the ones
 * the SDK wrote (`entrypoint` sdk-ts/sdk-py/sdk-cli) and its daemon sessions;
 * we do the same, except that a TeleCoder chat's own SDK conversations stay
 * in — the caller says which ids those are.
 *
 * Only the head and tail of a transcript are read: the head has the
 * entrypoint, the cwd and the first prompt, the tail the latest title and
 * reply. A transcript only grows, so what was read is cached per file until
 * its size or mtime changes.
 */

import * as fs from 'fs';
import * as path from 'path';
import { extractText, isSyntheticUserRecord, sessionJsonlPath, userTextKind, type JsonlRecord } from './session-jsonl.js';

/** How much of each end of a transcript to read. Claude Code's own listing reads 64KB too. */
const CHUNK_BYTES = 64 * 1024;

const SDK_ENTRYPOINTS = new Set(['sdk-ts', 'sdk-py', 'sdk-cli']);
const DAEMON_KINDS = new Set(['daemon', 'daemon-worker']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ScannedSession {
  sessionId: string;
  /** The transcript itself. */
  file: string;
  /** The directory the session ran in, as its records give it. */
  projectPath: string;
  mtimeMs: number;
  /** A title the user gave it with /rename. */
  customTitle?: string;
  /** The title Claude Code generated for it. */
  aiTitle?: string;
  /** The first thing the user typed. */
  firstPrompt?: string;
  entrypoint?: string;
  sessionKind?: string;
  /** Model of the newest reply in the tail: `deepseek-…` when CCR ran it. */
  lastModel?: string;
}

/** ~/.claude/projects, found the way the rest of TeleCoder finds transcripts. */
function projectsRoot(): string {
  return path.dirname(path.dirname(sessionJsonlPath('/', 'x')));
}

/** Where Claude Code keeps `projectPath`'s transcripts. */
function dirFor(projectPath: string): string {
  return path.dirname(sessionJsonlPath(projectPath, 'x'));
}

export function isSessionId(text: string): boolean {
  return UUID_RE.test(text);
}

// ── Reading one transcript ───────────────────────────────────────────────

const scanCache = new Map<string, { size: number; mtimeMs: number; scanned: ScannedSession | null }>();

/** Whole lines of `buf`, dropping the partial first (`fromMiddle`) and last ones. */
function wholeLines(buf: string, fromMiddle: boolean, toEnd: boolean): string[] {
  const lines = buf.split('\n');
  if (fromMiddle) lines.shift();
  if (!toEnd) lines.pop();
  return lines;
}

function parse(line: string): JsonlRecord & Record<string, unknown> | undefined {
  if (!line.trim()) return undefined;
  try {
    return JSON.parse(line) as JsonlRecord & Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function readChunk(fd: number, start: number, length: number): string {
  const buf = Buffer.alloc(length);
  const read = fs.readSync(fd, buf, 0, length, start);
  return buf.subarray(0, read).toString('utf-8');
}

function firstPromptOf(rec: JsonlRecord & Record<string, unknown>): string | undefined {
  if (rec.type !== 'user' || rec.isSidechain || rec.isMeta || isSyntheticUserRecord(rec)) return undefined;
  const text = extractText(rec.message?.content).trim();
  return text && userTextKind(text) === 'prompt' ? text : undefined;
}

/** Read what the picker needs from one transcript, or null if it isn't a session file. */
export function scanTranscript(file: string): ScannedSession | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const cached = scanCache.get(file);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.scanned;

  const sessionId = path.basename(file, '.jsonl');
  let scanned: ScannedSession | null = null;
  if (isSessionId(sessionId)) {
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, 'r');
      const whole = stat.size <= 2 * CHUNK_BYTES;
      const head = wholeLines(readChunk(fd, 0, whole ? stat.size : CHUNK_BYTES), false, whole);
      const tail = whole ? [] : wholeLines(readChunk(fd, stat.size - CHUNK_BYTES, CHUNK_BYTES), true, true);
      scanned = summarize(sessionId, file, stat.mtimeMs, head, tail);
    } catch {
      scanned = null;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  scanCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, scanned });
  return scanned;
}

function summarize(sessionId: string, file: string, mtimeMs: number, head: string[], tail: string[]): ScannedSession | null {
  const out: Partial<ScannedSession> = { sessionId, file, mtimeMs };
  // Titles and the model are rewritten as the session goes on, so the last
  // one in the file wins: head first, then the tail over it.
  for (const line of [...head, ...tail]) {
    const rec = parse(line);
    if (!rec) continue;
    if (out.entrypoint === undefined && typeof rec.entrypoint === 'string') out.entrypoint = rec.entrypoint;
    if (out.sessionKind === undefined && typeof rec.sessionKind === 'string') out.sessionKind = rec.sessionKind;
    if (out.projectPath === undefined && typeof rec.cwd === 'string') out.projectPath = rec.cwd;
    if (rec.type === 'custom-title' && typeof rec.customTitle === 'string' && rec.customTitle.trim()) {
      out.customTitle = rec.customTitle.trim();
    } else if (rec.type === 'ai-title' && typeof rec.aiTitle === 'string' && rec.aiTitle.trim()) {
      out.aiTitle = rec.aiTitle.trim();
    } else if (rec.type === 'assistant') {
      const model = (rec.message as { model?: unknown } | undefined)?.model;
      if (typeof model === 'string' && model !== '<synthetic>') out.lastModel = model;
    } else if (out.firstPrompt === undefined) {
      out.firstPrompt = firstPromptOf(rec);
    }
  }
  if (!out.projectPath) return null;
  return out as ScannedSession;
}

// ── Listing ──────────────────────────────────────────────────────────────

/**
 * Whether the picker offers this session: not an SDK or daemon run unless
 * TeleCoder knows it as one of its chats, and something the user said in it.
 */
export function isListable(s: ScannedSession, knownIds: ReadonlySet<string>): boolean {
  if (!knownIds.has(s.sessionId)) {
    if (s.entrypoint && SDK_ENTRYPOINTS.has(s.entrypoint)) return false;
    if (s.sessionKind && DAEMON_KINDS.has(s.sessionKind)) return false;
  }
  return Boolean(s.customTitle || s.aiTitle || s.firstPrompt);
}

interface Candidate { file: string; mtimeMs: number }

function transcriptsIn(dir: string): Candidate[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: Candidate[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const file = path.join(dir, name);
    try {
      out.push({ file, mtimeMs: fs.statSync(file).mtimeMs });
    } catch {
      // Gone between the listing and the stat.
    }
  }
  return out;
}

function allTranscriptDirs(): string[] {
  try {
    return fs.readdirSync(projectsRoot()).map((name) => path.join(projectsRoot(), name));
  } catch {
    return [];
  }
}

export interface ListOptions {
  /** One project, or every project when undefined. */
  projectPath?: string;
  /** Ids TeleCoder's chats know, kept even when the SDK wrote them. */
  knownIds: ReadonlySet<string>;
  /** Keep only the sessions this accepts. */
  match?: (s: ScannedSession) => boolean;
  offset: number;
  limit: number;
}

/**
 * The listable sessions, newest first, from `offset`, at most `limit` of them,
 * and whether there are more after those. Reads transcripts newest-first and
 * stops once the page is full, so a long history costs only what it shows.
 */
export function listSessions(opts: ListOptions): { sessions: ScannedSession[]; more: boolean } {
  const dirs = opts.projectPath ? [dirFor(opts.projectPath)] : allTranscriptDirs();
  const candidates = dirs.flatMap(transcriptsIn).sort((a, b) => b.mtimeMs - a.mtimeMs);

  const sessions: ScannedSession[] = [];
  let skipped = 0;
  for (const { file } of candidates) {
    const s = scanTranscript(file);
    if (!s || !isListable(s, opts.knownIds)) continue;
    if (opts.match && !opts.match(s)) continue;
    // A transcript of a project in a different directory only shows up in
    // the all-projects list, never as this project's.
    if (opts.projectPath && s.projectPath !== opts.projectPath) continue;
    if (skipped < opts.offset) {
      skipped++;
      continue;
    }
    if (sessions.length === opts.limit) return { sessions, more: true };
    sessions.push(s);
  }
  return { sessions, more: false };
}

/** Find a session's transcript by id: `projectPath`'s first, then every project's. */
export function findSession(sessionId: string, projectPath?: string): ScannedSession | null {
  if (!isSessionId(sessionId)) return null;
  const dirs = projectPath ? [dirFor(projectPath), ...allTranscriptDirs()] : allTranscriptDirs();
  for (const dir of dirs) {
    const file = path.join(dir, `${sessionId}.jsonl`);
    if (fs.existsSync(file)) return scanTranscript(file);
  }
  return null;
}

/** True if every word of `query` is in the session's titles, its first prompt or `alsoCalled`. */
export function matchesQuery(s: ScannedSession, query: string, alsoCalled?: string): boolean {
  const hay = [s.customTitle, s.aiTitle, alsoCalled, s.firstPrompt, s.sessionId].filter(Boolean).join('\n').toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((word) => hay.includes(word));
}

// ── Open elsewhere ───────────────────────────────────────────────────────

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: alive, just not ours to signal.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Whether a running Claude Code process has `sessionId` open. Every claude
 * process — a terminal, a PTY of any TeleCoder bot, an SDK turn in flight —
 * registers itself in ~/.claude/sessions/<pid>.json with the session it is
 * on; this is the registry Claude Code itself checks before resuming one.
 */
export function isSessionOpenElsewhere(sessionId: string): boolean {
  const dir = path.join(path.dirname(projectsRoot()), 'sessions');
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return false;
  }
  const wanted = sessionId.toLowerCase();
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let entry: { pid?: unknown; sessionId?: unknown };
    try {
      entry = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8')) as typeof entry;
    } catch {
      continue;
    }
    if (typeof entry.sessionId !== 'string' || entry.sessionId.toLowerCase() !== wanted) continue;
    if (typeof entry.pid === 'number' && entry.pid !== process.pid && processAlive(entry.pid)) return true;
  }
  return false;
}
