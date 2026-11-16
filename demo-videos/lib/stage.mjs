// Shared plumbing for scenes: the demo repo, the panes and the run log.
import { firefox } from 'playwright-core';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { startTerminal } from './term-server.mjs';
import { openTelegram } from './telegram.mjs';
import { installCursor } from './cursor.mjs';
import { REMOTE, PORTS, acquireBrowser, releaseBrowser, closeAndSaveVideo } from './browser.mjs';

/** The right half of the picture: the terminal or the app, one at a time. */
const SIDE = { width: 900, height: 1000 };

export const BOT = 'telecoder_demo_bot';
// The box reaches this machine's ports through a tunnel bound to 127.0.0.1.
export const APP_URL = REMOTE ? 'http://127.0.0.1:4321/' : 'http://localhost:4321/';
export const DEMO_USER = 'telecoder-test';
/** The shell prompt in the terminal pane. */
export const PROMPT = '\\[\\e[38;5;75m\\]alex@home\\[\\e[0m\\]:\\w$ ';
/** Run a shell snippet as the demo user, in its home. */
export const asDemo = (script) =>
  execFileSync('sudo', ['-u', DEMO_USER, '-H', 'bash', '-lc', `cd ~ && ${script}`], { encoding: 'utf8' });

/** Run a shell snippet as the demo user, in the demo project. */
export const inDemo = (script) =>
  execFileSync('sudo', ['-u', DEMO_USER, '-H', 'bash', '-lc', `cd ~/mealplan && ${script}`], { encoding: 'utf8' });

/** Put the demo project back to its starting point and make sure the app runs. */
export function resetDemo() {
  inDemo('git reset -q --hard demo-start && git clean -qfdx && git push -q -f origin main');
  // Watch mode, so the app pane shows Claude's changes without a restart.
  // Every old watcher has to go, not only the process on the port: a leftover
  // watcher restarts its own stale copy, and the pane then shows old pages.
  // pkill -f must not match this very command line, hence the [n] and the $W below.
  inDemo(`pkill -u $(id -u) -f '[n]ode --watch server.js'; pkill -u $(id -u) -f '[n]ode server.js$'; sleep 0.5; pid=$(ss -ltnpH 'sport = :4321' | grep -o 'pid=[0-9]*' | cut -d= -f2 | head -1); [ -n "$pid" ] && kill $pid; sleep 0.5; W=--watch; (setsid node $W server.js >/dev/null 2>&1 &); sleep 1.5; curl -fs -m 2 -o /dev/null http://localhost:4321/`);
}

/**
 * @param {string} name
 * @param {{ app?: boolean, chat?: string, terminal?: { args?: string[], title?: string }, layout?: object }} [opts]
 *   `layout` overrides pane positions in the composed video, as { pane: [x, y] }.
 *   `wide` gives Telegram 940 px, enough for its chat list or a bot's threads beside the chat.
 */
export async function openStage(name, { app: withApp = true, chat = BOT, terminal: termOpts = {}, layout, wide = false } = {}) {
  const out = new URL(`../out/${name}/`, import.meta.url).pathname;
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const t0 = Date.now();
  const log = [];
  // Wide: Telegram Web needs 926 px before it shows the chat list (or a bot's threads) beside the chat.
  const TELEGRAM = { width: wide ? 940 : 640, height: 1000 };
  const RIGHT = wide ? { width: 920, height: 1000 } : SIDE;
  if (wide) log.push({ canvas: '1920x1040' }, { layout: { terminal: [980, 20], app: [980, 20] } });
  if (layout) log.push({ layout });
  const now = () => Date.now() - t0;
  const mark = (what) => { log.push({ t: now(), what }); return now(); };
  const cut = (from, to) => { if (to - from > 1500) log.push({ cut: [from, to] }); };

  const terminalServer = await startTerminal({
    command: 'sudo',
    args: termOpts.args ?? ['-u', DEMO_USER, '-i', 'env', `PS1=${PROMPT}`, 'bash', '--norc'],
    title: termOpts.title ?? 'alex@home: ~/mealplan',
    port: REMOTE ? PORTS.terminal : 0,
  });
  const browser = REMOTE ? await acquireBrowser() : await firefox.launch({ headless: true });
  const side = async (pane, url, size = RIGHT) => {
    const context = await browser.newContext({ viewport: size, recordVideo: { dir: out + pane, size } });
    await context.addInitScript(installCursor);
    const page = await context.newPage();
    mark(`${pane}:start`);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    return { pane, context, page };
  };
  const terminal = await side('terminal', terminalServer.url);
  await terminal.page.waitForFunction(() => window.termReady);
  const app = withApp ? await side('app', APP_URL) : null;

  mark('telegram:start');
  const telegram = await openTelegram({
    chat,
    width: TELEGRAM.width,
    recordVideo: { dir: out + 'telegram', size: TELEGRAM },
  });

  /** Put the terminal or the app in the right half from now on. */
  const show = (pane) => { log.push({ t: now(), show: pane }); };
  show('terminal');
  const type = async (text) => {
    await terminal.page.keyboard.type(text, { delay: 45 });
    await terminal.page.keyboard.press('Enter');
  };
  /** What the terminal shows, scrollback included, without trailing blank lines. */
  const termText = () => terminal.page.evaluate(() => {
    const b = window.term.buffer.active;
    const lines = [];
    for (let i = 0; i < b.length; i++) lines.push(b.getLine(i).translateToString(true));
    while (lines.length && !lines.at(-1)) lines.pop();
    return lines.join('\n');
  });
  /** Wait until the terminal's text matches, and return the text. */
  const waitTerm = async (pattern, timeout = 120_000) => {
    const end = Date.now() + timeout;
    for (;;) {
      const text = await termText();
      if (pattern.test(text)) return text;
      if (Date.now() > end) throw new Error(`Terminal never showed ${pattern}. Last lines:\n${text.split('\n').slice(-8).join('\n')}`);
      await terminal.page.waitForTimeout(300);
    }
  };

  /** Stop recording, write the log, and build the video. */
  const finish = async () => {
    for (const p of [{ pane: 'telegram', ...telegram }, terminal, app].filter(Boolean)) {
      log.push({ video: p.pane, path: await closeAndSaveVideo(p.page, p.context, `${out}${p.pane}/video.webm`) });
    }
    if (REMOTE) await releaseBrowser();
    else await browser.close();
    terminalServer.close();
    await writeFile(out + 'log.json', JSON.stringify(log, null, 2));
    const r = spawnSync('node', [new URL('../compose.mjs', import.meta.url).pathname, out], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('compose failed');
    return out + 'video.mp4';
  };

  return {
    out, log, now, mark, cut, telegram: telegram.page, terminal: terminal.page, app: app?.page,
    type, show, termText, waitTerm, finish,
  };
}
