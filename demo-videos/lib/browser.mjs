// Where the recording browsers run: on this machine, or with DEMO_BOX=1 on the
// temporary box that `node box.mjs up` rents (see box.mjs for why).
import { firefox } from 'playwright-core';
import { chmodSync, existsSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { WS, PORTS } from '../box.mjs';

export const REMOTE = Boolean(process.env.DEMO_BOX);
export { PORTS };

const session = new URL('../.session/', import.meta.url).pathname;
const STATE = session + 'telegram-state.json';

let shared = null; // the one connection to the box, and how many are using it
let users = 0;

/** The box's browser. Every acquire needs a release; the last one hangs up. */
export async function acquireBrowser() {
  shared ??= firefox.connect(WS, { timeout: 30_000 }).catch((error) => {
    shared = null;
    throw new Error('No browser on the box. Is it up? (node box.mjs up)\n' + error.message.split('\n')[0]);
  });
  users++;
  return shared;
}

export async function releaseBrowser() {
  if (--users > 0 || !shared) return;
  const browser = await shared;
  shared = null;
  await browser.close().catch(() => {});
}

/**
 * The demo account's Telegram Web login as a storage state, taken from the
 * profile here. Telegram Web keeps its login in localStorage, so that is all
 * that travels: the box never holds the profile, and the state only exists in
 * its browser's memory.
 */
export async function telegramState() {
  const fresh = existsSync(STATE) && Date.now() - statSync(STATE).mtimeMs < 6 * 3600e3;
  if (!fresh) {
    const context = await firefox.launchPersistentContext(session + 'profile', { headless: true, viewport: { width: 940, height: 1000 } });
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto('https://web.telegram.org/k/', { waitUntil: 'domcontentloaded' });
    await page.locator('.chatlist-chat').first().waitFor({ timeout: 30000 });
    const state = await context.storageState();
    await context.close();
    writeFileSync(STATE, JSON.stringify({ cookies: state.cookies, origins: state.origins }), { mode: 0o600 });
    chmodSync(STATE, 0o600);
  }
  return JSON.parse(readFileSync(STATE, 'utf8'));
}

/**
 * Close a page's context and return the path of its video. A remote video has
 * to be fetched, which only works while the connection is still up: hold the
 * browser (acquireBrowser) around this.
 */
export async function closeAndSaveVideo(page, context, dest) {
  const video = page.video();
  await context.close();
  if (!REMOTE) return video.path();
  await video.saveAs(dest);
  return dest;
}
