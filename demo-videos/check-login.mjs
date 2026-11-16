// Is the demo account still logged in? Prints "logged-in" or "logged-out".
import { firefox } from 'playwright-core';
const dir = new URL('./.session/', import.meta.url).pathname;
const context = await firefox.launchPersistentContext(dir + 'profile', {
  headless: true, viewport: { width: 440, height: 900 }, colorScheme: 'dark',
});
const page = context.pages()[0] ?? (await context.newPage());
await page.goto('https://web.telegram.org/k/', { waitUntil: 'domcontentloaded' });
const search = page.locator('input.input-search-input, .input-search input').first();
const qr = page.getByText('Log in by QR Code');
const state = await Promise.race([
  search.waitFor({ timeout: 30000 }).then(() => 'logged-in'),
  qr.waitFor({ timeout: 30000 }).then(() => 'logged-out'),
]).catch(() => 'unknown');
console.log(state);
if (state === 'unknown') await page.screenshot({ path: dir + 'unknown.png' });
await page.waitForTimeout(1500);
await context.close();
