import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import headless from '@xterm/headless';
import {
  startWatchServer,
  stopWatchServer,
  watchData,
  watchRegister,
  watchUnregister,
} from '../../src/claude/pty-watch.js';
import { renderRows, screenSnapshot } from '../../src/claude/screen-render.js';

const { Terminal } = headless;

const written = (term: headless.Terminal, data: string) =>
  new Promise<void>((resolve) => term.write(data, () => resolve()));

const text = (term: headless.Terminal, row: number) =>
  term.buffer.active.getLine(term.buffer.active.baseY + row)?.translateToString(true).trimEnd();

/** A client that collects the server's messages. */
function connect(file: string) {
  const socket = net.createConnection(file);
  const messages: Array<Record<string, unknown>> = [];
  let buffered = '';
  socket.setEncoding('utf8');
  socket.on('data', (data: string) => {
    buffered += data;
    let newline: number;
    while ((newline = buffered.indexOf('\n')) !== -1) {
      messages.push(JSON.parse(buffered.slice(0, newline)));
      buffered = buffered.slice(newline + 1);
    }
  });
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
    if (!check()) throw new Error(`timed out; got ${JSON.stringify(messages)}`);
  };
  return { socket, messages, until, say: (m: unknown) => socket.write(`${JSON.stringify(m)}\n`) };
}

describe('screen-render', () => {
  it('redraws a screen with its colours and cursor in a second terminal', async () => {
    const a = new Terminal({ cols: 20, rows: 4, allowProposedApi: true });
    await written(a, 'plain \x1b[1;31mred\x1b[0m \x1b[48;2;1;2;3mbg\x1b[0m\r\n\x1b[38;5;200mpal\x1b[0m 漢字 x');
    const b = new Terminal({ cols: 20, rows: 4, allowProposedApi: true });
    await written(b, screenSnapshot(a));
    expect(renderRows(b)).toEqual(renderRows(a));
    expect(text(b, 0)).toBe('plain red bg');
    expect(text(b, 1)).toBe('pal 漢字 x');
    expect(b.buffer.active.cursorX).toBe(a.buffer.active.cursorX);
    expect(b.buffer.active.cursorY).toBe(a.buffer.active.cursorY);
    expect(renderRows(a)[0]).toBe('plain \x1b[1;38;5;1mred\x1b[0m \x1b[48;2;1;2;3mbg\x1b[0m        ');
  });

  it('shows only the screen, not what scrolled off, and crops to maxCols', async () => {
    const a = new Terminal({ cols: 10, rows: 2, scrollback: 50, allowProposedApi: true });
    await written(a, 'one\r\ntwo\r\nthree\r\nabcdefghij');
    const rows = renderRows(a, { maxCols: 4 });
    expect(rows).toEqual(['thre', 'abcd']);
  });
});

describe('pty-watch', () => {
  let dir: string;
  afterEach(() => {
    stopWatchServer();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const start = async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-'));
    const file = await startWatchServer('demo_bot', path.join(dir, 'watch'));
    return file!;
  };

  it('serves an owner-only socket named after the bot', async () => {
    const file = await start();
    expect(path.basename(file)).toBe('demo_bot.sock');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  });

  it('lists sessions, then sends the screen and what follows it', async () => {
    const file = await start();
    const term = new Terminal({ cols: 30, rows: 5, allowProposedApi: true });
    watchRegister('42:7', '/home/alex/mealplan', term);
    // Written but not yet parsed when the watcher joins: it must still be in the snapshot.
    term.write('hello ');
    watchData(term, 'hello ');

    const client = connect(file);
    client.say({ op: 'list' });
    await client.until(() => client.messages.length === 1);
    expect(client.messages[0]).toMatchObject({ type: 'sessions', bot: 'demo_bot', sessions: [{ key: '42:7', cwd: '/home/alex/mealplan', cols: 30, rows: 5 }] });

    client.say({ op: 'watch', key: '42:7' });
    // Arrives between the request and the snapshot, or right after: either way once.
    term.write('world');
    watchData(term, 'world');
    await written(term, '');
    term.write('!');
    watchData(term, '!');
    await client.until(() => client.messages.some((m) => m.type === 'data' && m.data === '!'));

    const mirror = new Terminal({ cols: 30, rows: 5, allowProposedApi: true });
    for (const m of client.messages.slice(1)) await written(mirror, m.data as string);
    expect(client.messages[1].type).toBe('screen');
    expect(text(mirror, 0)).toBe('hello world!');

    watchUnregister('42:7', term);
    await client.until(() => client.messages.at(-1)?.type === 'end');
    client.socket.destroy();
  });

  it('answers an unknown session with an error and ignores what a watcher types', async () => {
    const file = await start();
    const client = connect(file);
    client.say({ op: 'watch', key: 'nope' });
    await client.until(() => client.messages.length === 1);
    expect(client.messages[0]).toMatchObject({ type: 'error' });
    client.say({ op: 'write', data: 'rm -rf' });
    await client.until(() => client.messages.length === 2);
    expect(client.messages[1]).toMatchObject({ type: 'error' });
    client.socket.destroy();
  });

  it("a replaced claude's late output and exit don't touch its successor", async () => {
    await start();
    const old = new Terminal({ cols: 10, rows: 2, allowProposedApi: true });
    const next = new Terminal({ cols: 10, rows: 2, allowProposedApi: true });
    watchRegister('1', '/p', old);
    watchRegister('1', '/p', next);
    watchData(old, 'late');
    watchUnregister('1', old);
    const client = connect(path.join(dir, 'watch', 'demo_bot.sock'));
    client.say({ op: 'list' });
    await client.until(() => client.messages.length === 1);
    expect((client.messages[0].sessions as unknown[]).length).toBe(1);
    client.socket.destroy();
  });
});
