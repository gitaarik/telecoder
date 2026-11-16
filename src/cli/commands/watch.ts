/**
 * `telecoder watch` — the live Claude Code screen behind a chat, read-only.
 *
 * The bot drives a real `claude` per chat and serves its screen on
 * a socket (claude/pty-watch.ts). This command connects to it and shows that
 * screen in this terminal as it changes: what you'd see had you typed the
 * chat's messages into Claude Code yourself.
 *
 * It keeps its own copy of the screen and paints that row by row, so it works
 * in a terminal of any size: a larger one shows the screen in its corner, a
 * smaller one a part of it.
 */

import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import headless from '@xterm/headless';
import type { CliIo, CommandResult } from '../dispatch.js';
import { getWatchDir, type WatchSessionInfo } from '../../claude/pty-watch.js';
import { renderRows } from '../../claude/screen-render.js';

const { Terminal } = headless;

const POLL_MS = 500;
const FRAME_MS = 33;
const CONNECT_TIMEOUT_MS = 1500;

export interface FoundSession extends WatchSessionInfo {
  bot: string;
  socket: string;
}

export function usage(): string[] {
  return [
    'Usage: telecoder watch [<project>] [--list]',
    '',
    'Shows the live Claude Code screen of a chat, read-only: what Claude Code looks like',
    'while TeleCoder drives it. With several chats running it shows the most recently',
    'active one; with none it waits for the next message. Ctrl+C leaves.',
    '',
    '  <project>  only a chat in this project (its folder name), or of this bot (@name)',
    '  --list     list the running Claude Code sessions and exit',
    '',
    'PTY_WATCH=false in the .env turns it off.',
  ];
}

/** The project a session works in: its folder's name. */
export function projectOf(session: Pick<WatchSessionInfo, 'cwd'>): string {
  return path.basename(session.cwd) || session.cwd;
}

/** The session to show: the most recently active one that matches `filter`. */
export function pickSession(sessions: FoundSession[], filter?: string): FoundSession | undefined {
  const wanted = filter?.replace(/^@/, '').toLowerCase();
  return sessions
    .filter((s) => !wanted || projectOf(s).toLowerCase() === wanted || s.bot.toLowerCase() === wanted || s.key === wanted)
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

export function formatList(sessions: FoundSession[], now: number = Date.now()): string[] {
  if (sessions.length === 0) return ['No Claude Code session is running. One starts when a chat picks its project or gets its next message.'];
  const rows = [...sessions]
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    .map((s) => [`@${s.bot}`, projectOf(s), `chat ${s.key}`, `active ${ago(now - s.lastActiveAt)} ago`]);
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd());
}

/**
 * Which screen row goes at the top when only `visible` of `rows` fit. Claude
 * Code fills its screen from the top, so the part to keep is the one that ends
 * at the last row with something on it.
 */
export function cropStart(rows: number, visible: number, lastUsedRow: number): number {
  if (visible >= rows) return 0;
  return Math.max(0, Math.min(lastUsedRow + 1 - visible, rows - visible));
}

/** Ask one bot's socket for its sessions. Resolves with none when nothing answers. */
function listSocket(socketFile: string): Promise<FoundSession[]> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketFile);
    let buffered = '';
    const done = (sessions: FoundSession[]) => {
      socket.destroy();
      resolve(sessions);
    };
    socket.setEncoding('utf8');
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => done([]));
    socket.on('error', () => done([]));
    socket.on('connect', () => socket.write('{"op":"list"}\n'));
    socket.on('data', (data: string) => {
      buffered += data;
      const newline = buffered.indexOf('\n');
      if (newline === -1) return;
      try {
        const reply = JSON.parse(buffered.slice(0, newline)) as { bot?: string; sessions?: WatchSessionInfo[] };
        done((reply.sessions ?? []).map((s) => ({ ...s, bot: reply.bot ?? '', socket: socketFile })));
      } catch {
        done([]);
      }
    });
  });
}

export interface Discovery {
  /** How many bots answered. */
  bots: number;
  sessions: FoundSession[];
}

export async function discover(dir: string = getWatchDir()): Promise<Discovery> {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.sock'));
  } catch {
    return { bots: 0, sessions: [] };
  }
  let bots = 0;
  const all = await Promise.all(names.map(async (name) => {
    const file = path.join(dir, name);
    const alive = await new Promise<boolean>((resolve) => {
      const probe = net.createConnection(file);
      probe.on('connect', () => { probe.destroy(); resolve(true); });
      probe.on('error', () => resolve(false));
    });
    if (!alive) return [];
    bots++;
    return listSocket(file);
  }));
  return { bots, sessions: all.flat() };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Paints one session's screen into the terminal until it ends or `signal` aborts. */
function show(session: FoundSession, out: NodeJS.WriteStream, signal: AbortSignal): Promise<'ended' | 'aborted'> {
  return new Promise((resolve) => {
    const socket = net.createConnection(session.socket);
    let mirror: headless.Terminal | null = null;
    let painted: string[] = [];
    let paintedFooter = '';
    let dirty = false;
    let buffered = '';
    let settled = false;

    const paint = () => {
      if (!mirror || !dirty) return;
      dirty = false;
      const width = out.columns || mirror.cols;
      const height = out.rows || mirror.rows + 1;
      const visible = Math.max(1, Math.min(mirror.rows, height - 1));
      const cols = Math.min(mirror.cols, width);
      const buffer = mirror.buffer.active;
      let lastUsed = 0;
      // Trimmed by hand: the snapshot fills every row with spaces.
      for (let y = mirror.rows - 1; y >= 0; y--) {
        if (buffer.getLine(buffer.baseY + y)?.translateToString(true).trim()) {
          lastUsed = y;
          break;
        }
      }
      const start = cropStart(mirror.rows, visible, lastUsed);
      const rows = renderRows(mirror, { maxCols: cols }).slice(start, start + visible);
      const clear = cols < width ? '\x1b[K' : '';
      let frame = '';
      rows.forEach((row, i) => {
        if (painted[i] === row) return;
        painted[i] = row;
        frame += `\x1b[${i + 1};1H${row}${clear}`;
      });
      const cropped = cols < mirror.cols || visible < mirror.rows;
      const footer = [
        ' telecoder watch',
        `@${session.bot}`,
        projectOf(session),
        'read-only',
        'Ctrl+C leaves',
        cropped ? `part of ${mirror.cols}x${mirror.rows} shown, enlarge the terminal for all` : '',
      ].filter(Boolean).join(' · ').concat(' ').slice(0, width);
      if (footer !== paintedFooter && height > visible) {
        paintedFooter = footer;
        frame += `\x1b[${visible + 1};1H\x1b[0;7m${footer}\x1b[0m\x1b[K`;
      }
      if (frame) out.write(frame);
    };

    const timer = setInterval(paint, FRAME_MS);
    const repaintAll = () => {
      painted = [];
      paintedFooter = '';
      dirty = true;
      out.write('\x1b[2J');
    };
    out.on('resize', repaintAll);

    const finish = (how: 'ended' | 'aborted') => {
      if (settled) return;
      settled = true;
      paint();
      clearInterval(timer);
      out.off('resize', repaintAll);
      signal.removeEventListener('abort', onAbort);
      socket.destroy();
      resolve(how);
    };
    const onAbort = () => finish('aborted');
    signal.addEventListener('abort', onAbort);

    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify({ op: 'watch', key: session.key })}\n`));
    socket.on('error', () => finish('ended'));
    socket.on('close', () => finish('ended'));
    socket.on('data', (data: string) => {
      buffered += data;
      let newline: number;
      while ((newline = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        let message: { type?: string; data?: string; cols?: number; rows?: number };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.type === 'screen') {
          mirror = new Terminal({ cols: message.cols ?? 120, rows: message.rows ?? 40, scrollback: 0, allowProposedApi: true });
          repaintAll();
        }
        if ((message.type === 'screen' || message.type === 'data') && mirror && message.data) {
          mirror.write(message.data, () => { dirty = true; });
        } else if (message.type === 'end' || message.type === 'error') {
          // Let what was written reach the screen before leaving.
          if (mirror) mirror.write('', () => { dirty = true; finish('ended'); });
          else finish('ended');
        }
      }
    });
  });
}

export async function run(args: string[], io: CliIo): Promise<CommandResult> {
  const filter = args.find((arg) => !arg.startsWith('--'));
  const unknown = args.find((arg) => arg.startsWith('--') && arg !== '--list');
  if (unknown) {
    io.err(`Unknown option: ${unknown}`);
    for (const line of usage()) io.err(line);
    return 2;
  }

  if (args.includes('--list')) {
    const found = await discover();
    if (found.bots === 0) {
      io.err('No running bot to watch. Start one with "telecoder start" or "telecoder service install".');
      return 1;
    }
    for (const line of formatList(found.sessions)) io.out(line);
    return 0;
  }

  const out = process.stdout;
  const input = process.stdin;
  if (!out.isTTY) {
    io.err('telecoder watch draws a live screen, so it needs a terminal. "telecoder watch --list" works anywhere.');
    return 1;
  }
  if ((await discover()).bots === 0) {
    io.err('No running bot to watch. Start one with "telecoder start" or "telecoder service install".');
    io.err('(A bot with PTY_WATCH=false, or one that runs as another user, can\'t be watched.)');
    return 1;
  }

  const abort = new AbortController();
  const leave = () => abort.abort();
  const onKey = (key: Buffer) => {
    // Ctrl+C, Ctrl+D, q
    if (key[0] === 3 || key[0] === 4 || key.toString() === 'q') leave();
  };
  if (input.isTTY) {
    input.setRawMode(true);
    input.resume();
    input.on('data', onKey);
  }
  process.on('SIGINT', leave);
  process.on('SIGTERM', leave);

  // The alternate screen, so leaving gives the terminal back as it was; no
  // cursor and no wrapping, since every row is placed where it belongs.
  out.write('\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[2J\x1b[H');
  const notice = (text: string) => {
    const row = out.rows || 1;
    out.write(`\x1b[${row};1H\x1b[0;2m${text.slice(0, out.columns || 80)}\x1b[0m\x1b[K`);
  };

  try {
    let waitingSaid = false;
    while (!abort.signal.aborted) {
      const session = pickSession((await discover()).sessions, filter);
      if (!session) {
        if (!waitingSaid) {
          notice(filter
            ? ` Waiting for a Claude Code session in "${filter}". Send that chat a message. Ctrl+C leaves.`
            : ' Waiting for a Claude Code session. Send your bot a message. Ctrl+C leaves.');
          waitingSaid = true;
        }
        await Promise.race([sleep(POLL_MS), new Promise<void>((resolve) => abort.signal.addEventListener('abort', () => resolve(), { once: true }))]);
        continue;
      }
      waitingSaid = false;
      const how = await show(session, out, abort.signal);
      if (how === 'ended') {
        notice(' That Claude Code session ended. Waiting for the next one. Ctrl+C leaves.');
        waitingSaid = true;
        await sleep(POLL_MS);
      }
    }
  } finally {
    out.write('\x1b[0m\x1b[?7h\x1b[?25h\x1b[?1049l');
    if (input.isTTY) {
      input.off('data', onKey);
      input.setRawMode(false);
      input.pause();
    }
    process.off('SIGINT', leave);
    process.off('SIGTERM', leave);
  }
  return 0;
}
