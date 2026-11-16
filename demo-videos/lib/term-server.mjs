// A terminal pane for the recordings: a page with xterm.js, wired to a real
// shell over a websocket. Playwright types into it like a person would.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { WebSocketServer } from 'ws';
import pty from 'node-pty';

const require = createRequire(import.meta.url);
const assets = {
  '/xterm.js': [require.resolve('@xterm/xterm/lib/xterm.js'), 'text/javascript'],
  '/xterm.css': [require.resolve('@xterm/xterm/css/xterm.css'), 'text/css'],
  '/fit.js': [require.resolve('@xterm/addon-fit/lib/addon-fit.js'), 'text/javascript'],
};

const page = (title) => `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<link rel="stylesheet" href="/xterm.css">
<style>
  html, body { margin: 0; height: 100%; background: #0f1319; }
  body { display: flex; flex-direction: column; }
  .bar { height: 34px; flex: none; display: flex; align-items: center; gap: 8px; padding: 0 14px;
         background: #161c24; color: #939aa6; font: 13px system-ui, sans-serif; }
  .bar i { width: 11px; height: 11px; border-radius: 50%; background: #2a323d; }
  .bar span { margin-left: 8px; }
  #t { flex: 1; min-height: 0; padding: 10px 12px; }
</style></head>
<body>
<div class="bar"><i></i><i></i><i></i><span>${title}</span></div>
<div id="t"></div>
<script src="/xterm.js"></script><script src="/fit.js"></script>
<script>
  const term = new Terminal({
    fontFamily: '"IBM Plex Mono", "DejaVu Sans Mono", monospace', fontSize: 17, lineHeight: 1.25,
    cursorBlink: false,
    theme: { background: '#0f1319', foreground: '#e8e6e3', cursor: '#e08a6b',
             green: '#7fc98f', blue: '#5fb0f5', yellow: '#e0b56b', red: '#e0706b', cyan: '#6bc9c9' },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(document.getElementById('t'));
  fit.fit();
  const ws = new WebSocket('ws://' + location.host + '/pty?cols=' + term.cols + '&rows=' + term.rows);
  ws.onmessage = (e) => term.write(e.data);
  term.onData((d) => ws.send(d));
  // A change of size goes to the shell too, marked so it can't be mistaken for typing.
  term.onResize(({ cols, rows }) => ws.readyState === 1 && ws.send(String.fromCharCode(1) + 'size:' + cols + ',' + rows));
  /** Another text size, for a screen that needs more columns than the pane has at 17px. */
  window.setFont = (px) => { term.options.fontSize = px; fit.fit(); return term.cols + 'x' + term.rows; };
  ws.onopen = () => { term.focus(); window.termReady = true; };
  window.term = term;
</script>
</body></html>`;

/**
 * @param {{ command: string, args?: string[], cwd?: string, env?: object, title?: string }} opts
 * @returns {Promise<{ url: string, close: () => void }>}
 */
export async function startTerminal({ command, args = [], cwd, env, title = 'Terminal', port = 0 }) {
  const server = createServer(async (req, res) => {
    const asset = assets[req.url];
    if (asset) {
      res.writeHead(200, { 'content-type': asset[1] });
      return res.end(await readFile(asset[0]));
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page(title));
  });
  const shells = new Set();
  new WebSocketServer({ server, path: '/pty' }).on('connection', (ws, req) => {
    const q = new URL(req.url, 'http://x').searchParams;
    const shell = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols: Number(q.get('cols')) || 100,
      rows: Number(q.get('rows')) || 28,
      cwd,
      env: { ...process.env, ...env },
    });
    shells.add(shell);
    shell.onData((d) => ws.readyState === 1 && ws.send(d));
    shell.onExit(() => { shells.delete(shell); ws.close(); });
    ws.on('message', (d) => {
      const text = d.toString();
      const size = /^\x01size:(\d+),(\d+)$/.exec(text);
      if (size) shell.resize(Number(size[1]), Number(size[2]));
      else shell.write(text);
    });
    ws.on('close', () => { try { shell.kill(); } catch {} });
  });
  await new Promise((ok) => server.listen(port, '127.0.0.1', ok));
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    close: () => { for (const s of shells) { try { s.kill(); } catch {} } server.close(); },
  };
}
