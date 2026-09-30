/**
 * The fork tree: every transcript that grew out of one conversation, arranged
 * by where each one split off.
 *
 * Nothing records that tree, and nothing has to. A fork is a copy of its
 * source's transcript up to the fork point with every record id intact —
 * loadFork rewrites only the session id — so transcripts that start with the
 * same record grew out of the same conversation, and the last record two of
 * them share is where they split. Reading the tree off the transcripts covers
 * forks made before this module existed, forks handed between bots (they all
 * write under the one ~/.claude/projects), and branches that fell out of every
 * /resume list long ago but are still on disk.
 *
 * Structure is kept here and wording is not: which prompts are real turns, and
 * how a point is labelled, is for the handler to decide.
 */

import * as fs from 'fs';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';
import { extractText, isSyntheticUserRecord, sessionJsonlPath, type JsonlRecord } from './session-jsonl.js';

/** A record that takes part in the conversation: one Claude Code gave a uuid. */
interface ChainRecord {
  uuid: string;
  /**
   * Lines of the file up to and including this record — what to keep to cut
   * the transcript here. Counted the way countJsonlLines and the fork slicer
   * count them, so a cut made here matches one made from a fork button.
   */
  lineCount: number;
  timestamp?: string;
  /** What the user typed, when this record is a prompt. Capped at PROMPT_KEEP_CHARS. */
  prompt?: string;
}

interface Transcript {
  sessionId: string;
  records: ChainRecord[];
  mtimeMs: number;
}

export interface ForkNode {
  /** uuid of the last record in this node's stretch: the point it stands for, and its id. */
  id: string;
  /** Its stretch of records, as indexes into the records of any transcript through it: [start, end). */
  start: number;
  end: number;
  /** Every transcript that runs through this node, whether it ends here or further on. */
  sessionIds: string[];
  /**
   * Transcripts that end exactly here — a branch you can carry on. Usually one;
   * more when the same point was copied more than once and never taken further.
   */
  endsHere: string[];
  /** The user's prompts in this stretch, raw and in order. */
  prompts: string[];
  children: ForkNode[];
  parent?: ForkNode;
}

export interface ForkTree {
  projectPath: string;
  /** uuid of the first record, the one every transcript in the tree starts with. */
  rootId: string;
  root: ForkNode;
  /** Most recent modification of any transcript in the tree, in ms. */
  lastActiveMs: number;
  transcripts: Map<string, Transcript>;
}

/** A conversation that has been forked at least once, before its tree is built. */
export interface ForkedConversation {
  rootId: string;
  sessionIds: string[];
  lastActiveMs: number;
}

/**
 * How much of a prompt to keep. A label needs a line; stripping a paste's tags
 * or skipping a quoted passage to find the user's own words needs more, and
 * past this the rest is never shown.
 */
const PROMPT_KEEP_CHARS = 4000;

/**
 * Transcripts kept parsed between calls. A long transcript parses to a few
 * hundred KB, and every bot keeps its own cache; this holds a tree or two,
 * which is what a run of taps on one message reads again.
 */
const PARSE_CACHE_MAX = 16;

/**
 * How much of a transcript to read at a time looking for its first record.
 * That record is almost always within the first few KB, and a project can
 * hold thousands of transcripts, so the first read is kept small.
 */
const ROOT_SCAN_CHUNK_BYTES = 8 * 1024;

/** How far into a transcript to look for its first record before giving up on it. */
const ROOT_SCAN_MAX_BYTES = 8 * 1024 * 1024;

/** Where Claude Code keeps the transcripts of conversations run in `projectPath`. */
export function transcriptDir(projectPath: string): string {
  return path.dirname(sessionJsonlPath(projectPath, 'x'));
}

// ── Which conversation each transcript grew out of ───────────────────────

/**
 * First record uuid per transcript file. A transcript only ever grows, so once
 * found its first record never changes and isn't looked up again; a file that
 * has none yet is retried once it changes.
 */
const rootCache = new Map<string, { root: string } | { root: null; mtimeMs: number; size: number }>();

function firstRecordUuid(file: string): string | undefined {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return undefined;
  }
  try {
    const decoder = new StringDecoder('utf8');
    const buf = Buffer.alloc(ROOT_SCAN_CHUNK_BYTES);
    let pending = '';
    let read = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, read);
      const atEof = n === 0;
      read += n;
      pending += atEof ? decoder.end() : decoder.write(buf.subarray(0, n));
      const lines = pending.split('\n');
      // The last piece is a line still being read — unless the file is done.
      pending = atEof ? '' : lines.pop()!;
      for (const line of lines) {
        const uuid = uuidOf(line);
        if (uuid) return uuid;
      }
      if (atEof || read >= ROOT_SCAN_MAX_BYTES) return undefined;
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** The record's own uuid, or undefined for a bookkeeping line that has none. */
function uuidOf(line: string): string | undefined {
  // Bookkeeping lines (mode, titles, file snapshots) carry no uuid, and there
  // is no point parsing them to find that out.
  if (!line.includes('"uuid"')) return undefined;
  try {
    const rec = JSON.parse(line) as { uuid?: unknown };
    return typeof rec.uuid === 'string' ? rec.uuid : undefined;
  } catch {
    return undefined;
  }
}

function rootOf(file: string): string | undefined {
  const cached = rootCache.get(file);
  if (cached?.root) return cached.root;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return undefined;
  }
  if (cached?.root === null && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return undefined;

  const root = firstRecordUuid(file);
  rootCache.set(file, root ? { root } : { root: null, mtimeMs: stat.mtimeMs, size: stat.size });
  return root;
}

/** Session ids in the project, grouped by the conversation they grew out of. */
function conversationsIn(projectPath: string): Map<string, string[]> {
  const dir = transcriptDir(projectPath);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return new Map();
  }

  const byRoot = new Map<string, string[]>();
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const root = rootOf(path.join(dir, name));
    if (!root) continue;
    const sessionId = name.slice(0, -'.jsonl'.length);
    const members = byRoot.get(root);
    if (members) members.push(sessionId);
    else byRoot.set(root, [sessionId]);
  }
  return byRoot;
}

function mtimeMsOf(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Conversations in the project that have been forked — more than one
 * transcript starting from the same record — most recently active first.
 */
export function forkedConversations(projectPath: string): ForkedConversation[] {
  const dir = transcriptDir(projectPath);
  const out: ForkedConversation[] = [];
  for (const [rootId, sessionIds] of conversationsIn(projectPath)) {
    if (sessionIds.length < 2) continue;
    const lastActiveMs = Math.max(...sessionIds.map((id) => mtimeMsOf(path.join(dir, `${id}.jsonl`))));
    out.push({ rootId, sessionIds, lastActiveMs });
  }
  return out.sort((a, b) => b.lastActiveMs - a.lastActiveMs);
}

// ── Reading a transcript ─────────────────────────────────────────────────

const parseCache = new Map<string, { mtimeMs: number; size: number; transcript: Transcript }>();

function readTranscript(projectPath: string, sessionId: string): Transcript | undefined {
  const file = sessionJsonlPath(projectPath, sessionId);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return undefined;
  }

  const cached = parseCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    // Refresh its place: the cache drops whatever was used longest ago.
    parseCache.delete(file);
    parseCache.set(file, cached);
    return cached.transcript;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return undefined;
  }

  const records: ChainRecord[] = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.includes('"uuid"')) continue;
    let rec: JsonlRecord & { uuid?: unknown; timestamp?: unknown };
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof rec.uuid !== 'string') continue;

    const record: ChainRecord = { uuid: rec.uuid, lineCount: i + 1 };
    if (typeof rec.timestamp === 'string') record.timestamp = rec.timestamp;
    if (rec.type === 'user' && !isSyntheticUserRecord(rec)) {
      // tool_result records are user records too, with no prose — extractText
      // leaves those empty, so only what the user typed gets through.
      const text = extractText(rec.message?.content);
      if (text) record.prompt = text.slice(0, PROMPT_KEEP_CHARS);
    }
    records.push(record);
  }

  const transcript: Transcript = { sessionId, records, mtimeMs: stat.mtimeMs };
  parseCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, transcript });
  while (parseCache.size > PARSE_CACHE_MAX) {
    parseCache.delete(parseCache.keys().next().value!);
  }
  return transcript;
}

/** The prompts typed in a transcript, raw and in order — to name a conversation before its tree is built. */
export function promptsIn(projectPath: string, sessionId: string): string[] {
  return readTranscript(projectPath, sessionId)?.records.flatMap((r) => (r.prompt ? [r.prompt] : [])) ?? [];
}

// ── Building the tree ────────────────────────────────────────────────────

/**
 * The node covering what `sessionIds` share from `start` on, with a child per
 * way they part. Every transcript passed in shares its records up to `start`,
 * and — for a child — record `start` too, which is what grouped them.
 */
function buildNode(
  sessionIds: string[],
  transcripts: Map<string, Transcript>,
  start: number,
  parent?: ForkNode,
): ForkNode {
  const recordsOf = (id: string) => transcripts.get(id)!.records;
  const base = recordsOf(sessionIds[0]!);

  // Run on while every transcript still has the same record.
  let end = Math.min(...sessionIds.map((id) => recordsOf(id).length));
  for (const id of sessionIds.slice(1)) {
    const records = recordsOf(id);
    let i = start;
    while (i < end && records[i]!.uuid === base[i]!.uuid) i++;
    end = i;
  }

  const node: ForkNode = {
    id: base[end - 1]!.uuid,
    start,
    end,
    sessionIds,
    endsHere: [],
    prompts: base.slice(start, end).flatMap((r) => (r.prompt ? [r.prompt] : [])),
    children: [],
    parent,
  };

  const ways = new Map<string, string[]>();
  for (const id of sessionIds) {
    const records = recordsOf(id);
    if (records.length === end) {
      node.endsHere.push(id);
      continue;
    }
    const next = records[end]!.uuid;
    const way = ways.get(next);
    if (way) way.push(id);
    else ways.set(next, [id]);
  }

  // Branches in the order they were started, so the older a branch, the
  // earlier its letter, and starting a new one doesn't reshuffle the rest.
  const startedAt = (ids: string[]) => recordsOf(ids[0]!)[end]!.timestamp ?? '';
  node.children = [...ways.values()]
    .sort((a, b) => startedAt(a).localeCompare(startedAt(b)))
    .map((ids) => buildNode(ids, transcripts, end, node));
  // The most recently written copy first, so it is the one a caller reaching
  // for "the" branch at this point gets.
  node.endsHere.sort((a, b) => transcripts.get(b)!.mtimeMs - transcripts.get(a)!.mtimeMs);
  return node;
}

function buildTree(projectPath: string, rootId: string, sessionIds: string[]): ForkTree | undefined {
  const transcripts = new Map<string, Transcript>();
  for (const id of sessionIds) {
    const transcript = readTranscript(projectPath, id);
    // A transcript whose first record moved on since the index was taken is
    // not part of this tree any more; leave it out rather than misplace it.
    if (transcript?.records[0]?.uuid === rootId) transcripts.set(id, transcript);
  }
  if (transcripts.size === 0) return undefined;

  // Oldest first, so the transcript that starts the root is the original.
  const ordered = [...transcripts.keys()].sort(
    (a, b) => (transcripts.get(a)!.records[0]!.timestamp ?? '').localeCompare(transcripts.get(b)!.records[0]!.timestamp ?? ''),
  );
  return {
    projectPath,
    rootId,
    root: buildNode(ordered, transcripts, 0),
    lastActiveMs: Math.max(...[...transcripts.values()].map((t) => t.mtimeMs)),
    transcripts,
  };
}

/** The tree the transcript `sessionId` belongs to — just itself, if it was never forked. */
export function treeOf(projectPath: string, sessionId: string): ForkTree | undefined {
  const rootId = rootOf(sessionJsonlPath(projectPath, sessionId));
  if (!rootId) return undefined;
  const members = conversationsIn(projectPath).get(rootId) ?? [sessionId];
  return buildTree(projectPath, rootId, members);
}

/**
 * The tree whose first record's uuid is `rootId` — or starts with it, since a
 * button's callback data has no room for a whole uuid next to a node's. Two
 * roots can share a prefix, so given the point a button is for, it is the
 * tree holding that point that comes back.
 */
export function treeByRoot(projectPath: string, rootId: string, nodeId?: string): ForkTree | undefined {
  let first: ForkTree | undefined;
  for (const [id, members] of conversationsIn(projectPath)) {
    if (!id.startsWith(rootId)) continue;
    const tree = buildTree(projectPath, id, members);
    if (!tree) continue;
    if (!nodeId || nodeById(tree, nodeId)) return tree;
    first ??= tree;
  }
  return first;
}

// ── Walking it ───────────────────────────────────────────────────────────

/** Every node, parents before children: the order a tree is read and lettered in. */
export function preorder(tree: ForkTree): ForkNode[] {
  const out: ForkNode[] = [];
  const walk = (node: ForkNode) => {
    out.push(node);
    node.children.forEach(walk);
  };
  walk(tree.root);
  return out;
}

export function nodeById(tree: ForkTree, id: string): ForkNode | undefined {
  return preorder(tree).find((node) => node.id === id);
}

/** Where `sessionId`'s transcript ends: the node it is carried on from. */
export function nodeWhereEnds(tree: ForkTree, sessionId: string): ForkNode | undefined {
  return preorder(tree).find((node) => node.endsHere.includes(sessionId));
}

/**
 * The transcript cut at `node`: everything up to and including its last
 * record, read from one of the transcripts running through it. That is what a
 * branch from this point starts with. Undefined if the file has gone.
 */
export function transcriptUpTo(tree: ForkTree, node: ForkNode): string | undefined {
  for (const sessionId of node.sessionIds) {
    const record = tree.transcripts.get(sessionId)?.records[node.end - 1];
    if (!record || record.uuid !== node.id) continue;
    let raw: string;
    try {
      raw = fs.readFileSync(sessionJsonlPath(tree.projectPath, sessionId), 'utf-8');
    } catch {
      continue;
    }
    const lines = raw.split('\n').slice(0, record.lineCount);
    return lines.join('\n') + '\n';
  }
  return undefined;
}
