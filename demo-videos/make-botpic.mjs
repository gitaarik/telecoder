// Render the bot's profile picture from the site's logo: assets/botpic.jpg, 640x640.
// Telegram crops it to a circle, so the mark sits in the middle of a full square.
import { firefox } from 'playwright-core';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const svg = await readFile(new URL('../site/public/favicon.svg', import.meta.url), 'utf8');
const paths = svg.match(/<path[^>]*\/>/g).join('');
const bg = svg.match(/<rect[^>]*fill="([^"]+)"/)[1];
const html = `<body style="margin:0;background:${bg}"><svg xmlns="http://www.w3.org/2000/svg" width="640" height="640" viewBox="-8 -8 80 80">${paths}</svg>`;
const browser = await firefox.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 640, height: 640 } });
await page.setContent(html);
const out = new URL('./assets/', import.meta.url).pathname;
await page.screenshot({ path: out + 'botpic.png' });
await browser.close();
execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', out + 'botpic.png', '-q:v', '2', out + 'botpic.jpg']);
console.log(out + 'botpic.jpg');
