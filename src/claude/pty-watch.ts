/**
 * Lets `telecoder watch` look at a running claude's screen.
 *
 * Each chat's claude draws its screen into a terminal that exists
 * only in this process. This module serves those screens, read-only, over a
 * Unix socket: a watcher gets the screen as it is now and then everything
 * claude writes after it. Nothing a watcher sends reaches claude.
 *
 * The socket is `~/.telecoder/watch/<bot username>.sock`, one per bot (several
 * bots can share a process, as worker threads), in a directory only the owner
 * can enter. So only the user the bot runs as can watch, which is the user who
 * can already read every transcript.
 *
 * Protocol: one JSON object per line.
 *   → {"op":"list"}            ← {"type":"sessions","bot":…,"sessions":[…]}
 *   → {"op":"watch","key":…}   ← {"type":"screen","key","cols","rows","data"}
 *                              ← {"type":"data","data"} …
 *                              ← {"type":"end"}            (claude exited)
 *                              ← {"type":"error","message"}
 */

import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import type headless from '@xterm/headless';
import { getStateDir } from '../utils/json-store.js';
import { screenSnapshot } from './screen-render.js';

export const WATCH_DIR_NAME = 'watch';

/** A watcher this far behind is dropped rather than buffered for without end. */
const MAX_BACKLOG_BYTES = 8 * 1024 * 1024;

export interface WatchSessionInfo {
  /** The bot's session key: chat id, or chat id and thread id. */
  key: string;
  cwd: string;
  cols: number;
  rows: number;
  startedAt: number;
  lastActiveAt: number;
}

interface Watcher {
  socket: net.Socket;
  /** Output that arrived before the snapshot was taken; null once live. */
  pending: string[] | null;
}

interface Watched {
  info: WatchSessionInfo;
  xterm: headless.Terminal;
  watchers: Set<Watcher>;
}

const watched = new Map<string, Watched>();
const byTerm = new WeakMap<headless.Terminal, Watched>();
let server: net.Server | null = null;
let socketPath: string | null = null;
let botName = '';

export function getWatchDir(): string {
  return path.join(getStateDir(), WATCH_DIR_NAME);
}

function send(socket: net.Socket, message: Record<string, unknown>): void {
  if (socket.destroyed) return;
  if (socket.writableLength > MAX_BACKLOG_BYTES) {
    socket.destroy();
    return;
  }
  socket.write(`${JSON.stringify(message)}\n`);
}

/** A claude has started: its screen can be watched from now on. */
export function watchRegister(key: string, cwd: string, xterm: headless.Terminal): void {
  watchUnregister(key);
  const now = Date.now();
  const entry: Watched = {
    info: { key, cwd, cols: xterm.cols, rows: xterm.rows, startedAt: now, lastActiveAt: now },
    xterm,
    watchers: new Set(),
  };
  watched.set(key, entry);
  byTerm.set(xterm, entry);
}

/**
 * Output from the claude that draws into `xterm`. Call it right after the same
 * chunk went into that xterm, so a snapshot and the chunks after it line up.
 */
export function watchData(xterm: headless.Terminal, chunk: string): void {
  // Not found for a claude replaced at its key (/clear) that still writes as it exits.
  const entry = byTerm.get(xterm);
  if (!entry) return;
  entry.info.lastActiveAt = Date.now();
  for (const watcher of entry.watchers) {
    if (watcher.pending) watcher.pending.push(chunk);
    else send(watcher.socket, { type: 'data', data: chunk });
  }
}

/** `key`'s claude is gone. With `xterm`, only if it is still that one. */
export function watchUnregister(key: string, xterm?: headless.Terminal): void {
  const entry = watched.get(key);
  if (!entry || (xterm && entry.xterm !== xterm)) return;
  watched.delete(key);
  byTerm.delete(entry.xterm);
  for (const watcher of entry.watchers) send(watcher.socket, { type: 'end' });
  entry.watchers.clear();
}

function subscribe(socket: net.Socket, key: string): Watcher | null {
  const entry = watched.get(key);
  if (!entry) {
    send(socket, { type: 'error', message: 'No such session.' });
    return null;
  }
  const watcher: Watcher = { socket, pending: [] };
  entry.watchers.add(watcher);
  // xterm parses what it is given a little later. An empty write's callback
  // runs once everything given before it is on the screen, so the snapshot
  // holds exactly the output up to here, and `pending` everything after.
  entry.xterm.write('', () => {
    if (!entry.watchers.has(watcher)) return;
    send(socket, {
      type: 'screen',
      key,
      cols: entry.xterm.cols,
      rows: entry.xterm.rows,
      data: screenSnapshot(entry.xterm),
    });
    for (const chunk of watcher.pending ?? []) send(socket, { type: 'data', data: chunk });
    watcher.pending = null;
  });
  return watcher;
}

function unsubscribe(watcher: Watcher | null): void {
  if (!watcher) return;
  for (const entry of watched.values()) entry.watchers.delete(watcher);
}

function onConnection(socket: net.Socket): void {
  let buffered = '';
  let watcher: Watcher | null = null;
  socket.setEncoding('utf8');
  socket.on('error', () => socket.destroy());
  socket.on('close', () => unsubscribe(watcher));
  socket.on('data', (data: string) => {
    buffered += data;
    // Requests are a few dozen bytes. Anything long is not a watcher.
    if (buffered.length > 4096) {
      socket.destroy();
      return;
    }
    let newline: number;
    while ((newline = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      let request: { op?: unknown; key?: unknown };
      try {
        request = JSON.parse(line);
      } catch {
        socket.destroy();
        return;
      }
      if (request?.op === 'list') {
        send(socket, { type: 'sessions', bot: botName, sessions: [...watched.values()].map((e) => e.info) });
      } else if (request?.op === 'watch' && typeof request.key === 'string') {
        unsubscribe(watcher);
        watcher = subscribe(socket, request.key);
      } else {
        send(socket, { type: 'error', message: 'Unknown request.' });
      }
    }
  });
}

/**
 * Start serving this process's claude screens. `name` is the bot's username,
 * shown to a watcher choosing between several bots.
 */
export async function startWatchServer(name: string, dir: string = getWatchDir()): Promise<string | null> {
  if (server) return socketPath;
  botName = name;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, `${name.replace(/[^A-Za-z0-9_-]/g, '_') || 'bot'}.sock`);
  // One left by an earlier run of this bot: nothing listens on it any more.
  try { fs.unlinkSync(file); } catch { /* not there */ }

  const created = net.createServer(onConnection);
  await new Promise<void>((resolve, reject) => {
    created.once('error', reject);
    created.listen(file, () => {
      created.off('error', reject);
      resolve();
    });
  });
  fs.chmodSync(file, 0o600);
  // The socket must not keep a stopping bot alive.
  created.unref();
  server = created;
  socketPath = file;
  return file;
}

export function stopWatchServer(): void {
  for (const key of [...watched.keys()]) watchUnregister(key);
  server?.close();
  server = null;
  if (socketPath) {
    try { fs.unlinkSync(socketPath); } catch { /* already gone */ }
  }
  socketPath = null;
}
