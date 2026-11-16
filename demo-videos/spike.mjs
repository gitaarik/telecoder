// Trial run of the recording pipeline, without a Telegram account:
// three panes recorded separately, then combined by ffmpeg (see compose.sh).
import { firefox } from 'playwright-core';
import { writeFile, rm, mkdir } from 'node:fs/promises';
import { startTerminal } from './lib/term-server.mjs';

const out = new URL('./out/spike/', import.meta.url).pathname;
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const appUrl = process.env.APP_URL ?? 'http://localhost:4321/';
const terminal = await startTerminal({
  command: 'sudo',
  args: ['-u', 'telecoder-test', '-i', 'env', 'PS1=\\[\\e[38;5;75m\\]alex@home\\[\\e[0m\\]:\\w$ ', 'bash', '--norc'],
  title: 'alex@home: ~/mealplan',
});

const browser = await firefox.launch({ headless: true });
const log = [];
const t0 = Date.now();
const mark = (what) => log.push({ t: Date.now() - t0, what });

async function pane(name, width, height, url) {
  const context = await browser.newContext({
    viewport: { width, height },
    recordVideo: { dir: out + name, size: { width, height } },
    colorScheme: 'dark',
  });
  const page = await context.newPage();
  mark(`${name}:start`);
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch((e) => mark(`${name}:goto failed ${e.message}`));
  return { name, context, page };
}

const telegram = await pane('telegram', 440, 900, 'https://web.telegram.org/k/');
const term = await pane('terminal', 1000, 440, terminal.url);
const app = await pane('app', 1000, 440, appUrl);

await term.page.waitForFunction(() => window.termReady);
const type = async (text) => { await term.page.keyboard.type(text, { delay: 55 }); await term.page.keyboard.press('Enter'); };

await term.page.waitForTimeout(1500);
mark('type:cd'); await type('cd mealplan && git log --oneline | head -5');
await term.page.waitForTimeout(1500);
mark('type:ls'); await type('ls recipes');
await term.page.waitForTimeout(1200);
mark('app:click'); await app.page.click('text=Pancakes');
await app.page.waitForTimeout(2000);
mark('app:back'); await app.page.goBack();
await telegram.page.waitForTimeout(3000);
mark('end');

for (const p of [telegram, term, app]) {
  await p.page.screenshot({ path: `${out}${p.name}.png` });
  const video = p.page.video();
  await p.context.close();
  log.push({ video: p.name, path: await video.path() });
}
await browser.close();
terminal.close();
await writeFile(out + 'log.json', JSON.stringify(log, null, 2));
console.log(log.map((l) => JSON.stringify(l)).join('\n'));
