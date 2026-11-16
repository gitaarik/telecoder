// One-time login of the demo Telegram account into the recording browser.
// The profile in .session/ keeps the login; never commit or share it.
//
//   node login.mjs
//
// Writes .session/qr.png whenever Telegram shows a new QR code, and one line of
// status per change to stdout: "qr <n>", "password", "logged-in".
// If the account has a two-step password, put it in .session/password (it is
// read once and deleted).
import { firefox } from 'playwright-core';
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';

const dir = new URL('./.session/', import.meta.url).pathname;
const context = await firefox.launchPersistentContext(dir + 'profile', {
  headless: true,
  viewport: { width: 440, height: 900 },
  colorScheme: 'dark',
});
const page = context.pages()[0] ?? (await context.newPage());
await page.goto('https://web.telegram.org/k/', { waitUntil: 'domcontentloaded' });

const deadline = Date.now() + 15 * 60_000;
let last = '';
let n = 0;
let askedPassword = false;

while (Date.now() < deadline) {
  await page.waitForTimeout(1000);

  if (await page.locator('input.input-search-input, .input-search input').first().isVisible().catch(() => false)) {
    await page.waitForTimeout(4000); // let it store the session
    await page.screenshot({ path: dir + 'logged-in.png' });
    console.log('logged-in');
    break;
  }

  const password = page.locator('input[type="password"]').first();
  if (await password.isVisible().catch(() => false)) {
    if (!askedPassword) { console.log('password'); askedPassword = true; }
    const secret = await readFile(dir + 'password', 'utf8').catch(() => null);
    if (secret) {
      await rm(dir + 'password', { force: true });
      await password.fill(secret.replace(/\n$/, ''));
      await page.keyboard.press('Enter');
      await page.waitForTimeout(3000);
    }
    continue;
  }

  const canvas = page.locator('canvas').first();
  if (await canvas.isVisible().catch(() => false)) {
    const shot = await page.screenshot();
    const hash = createHash('sha1').update(await canvas.screenshot()).digest('hex');
    if (hash !== last) {
      last = hash;
      await writeFile(dir + 'qr.png', shot);
      console.log(`qr ${++n} ${new Date().toISOString()}`);
    }
  }
}
await context.close();
