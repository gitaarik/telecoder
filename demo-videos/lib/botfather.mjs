// BotFather, driven from the demo account. A token never leaves this module in
// the clear: replies are returned with tokens blanked, and the token itself is
// only handed to the caller that asks for it by name.
import { send } from './telegram.mjs';
import { pointAndClick } from './cursor.mjs';

const TOKEN = /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g;
export const redact = (s) => s.replace(TOKEN, '<token>');

const incoming = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.bubble.is-in .message, .bubble.is-in .bubble-content')]
      .map((m) => m.innerText.trim()).filter(Boolean));

/** Send one message to BotFather and return its next reply, raw. */
async function ask(page, text, timeout = 20000) {
  const before = (await incoming(page)).length;
  const lastBefore = (await incoming(page)).at(-1);
  await send(page, text);
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    await page.waitForTimeout(400);
    const now = await incoming(page);
    if (now.length > before || now.at(-1) !== lastBefore) {
      await page.waitForTimeout(600);
      return (await incoming(page)).at(-1);
    }
  }
  throw new Error(`BotFather did not answer "${text}"`);
}

/** Ask, and return the reply with any token blanked. */
export const say = async (page, text) => redact(await ask(page, text));

/**
 * Create a bot. Tries each username until one is free.
 * @returns {{ username: string, token: string }}
 */
export async function createBot(page, { name, usernames }) {
  let r = await ask(page, '/newbot');
  if (!/choose a name/i.test(r)) throw new Error('Unexpected: ' + redact(r).slice(0, 200));
  r = await ask(page, name);
  if (!/username/i.test(r)) throw new Error('Unexpected: ' + redact(r).slice(0, 200));
  for (const username of usernames) {
    r = await ask(page, username);
    const token = r.match(TOKEN)?.[0];
    if (token) return { username, token };
    if (!/taken|invalid|sorry/i.test(r)) throw new Error('Unexpected: ' + redact(r).slice(0, 200));
  }
  await ask(page, '/cancel').catch(() => {});
  throw new Error('No username was free');
}

/** Open BotFather's Mini App on one bot's page. `page` must be on the BotFather chat. */
export async function openBotPage(page, bot) {
  await page.locator('.new-message-bot-commands').first().click();
  await page.waitForTimeout(2500);
  const launch = page.locator('.popup button', { hasText: /^Launch$/i }).first();
  if (await launch.isVisible().catch(() => false)) await launch.click();
  await page.waitForFunction(
    () => [...document.querySelectorAll('iframe')].some((f) => f.src.includes('/botfather')), null, { timeout: 20000 });
  await page.waitForTimeout(4000);
  const app = page.frames().find((f) => f.url().includes('webappinternal.telegram.org/botfather'));
  if (!app) throw new Error("BotFather's Mini App did not open");
  await app.getByText('@' + bot).first().click();
  await page.waitForTimeout(2500);
  return app;
}

/** The on/off switches on the Bot Settings page, by label. */
const switches = (app) =>
  app.evaluate(() => Object.fromEntries([...document.querySelectorAll('.tm-row-toggle')].map((r) =>
    [(r.querySelector('span') ?? r).textContent.trim().split('\n')[0].trim(), (r.querySelector('.tm-toggle')?.className ?? 'none').replace('tm-toggle', '').trim() || 'off'])));

/**
 * Turn switches on in Bot Settings (for instance "Threaded Mode"). Returns every switch's state.
 * `app` is the frame from openBotPage.
 */
export async function turnOn(page, app, labels) {
  await app.getByText('Bot Settings', { exact: true }).first().click();
  await app.locator('.tm-row-toggle').first().waitFor({ timeout: 15000 });
  for (const label of labels) {
    if ((await switches(app))[label] !== 'off') continue;
    await app.locator('.tm-row-toggle', { hasText: label }).locator('.tm-toggle').click();
    await page.waitForTimeout(2500);
  }
  return switches(app);
}

/** Replace a bot's token with a new one. The old token stops working at once. */
export async function revokeToken(page, bot) {
  let r = await ask(page, '/revoke');
  if (!/choose a bot/i.test(r)) throw new Error('Unexpected: ' + redact(r).slice(0, 200));
  r = await ask(page, '@' + bot);
  const token = r.match(TOKEN)?.[0];
  if (!token) throw new Error('Unexpected: ' + redact(r).slice(0, 200));
  return token;
}

/** Delete a bot for good. Its token stops working and its username is freed. */
export async function deleteBot(page, bot) {
  let r = await ask(page, '/deletebot');
  if (!/choose a bot/i.test(r)) throw new Error('Unexpected: ' + redact(r).slice(0, 200));
  r = await ask(page, '@' + bot);
  const phrase = r.match(/Yes, I am totally sure\.?/)?.[0];
  if (!phrase) throw new Error('Unexpected: ' + redact(r).slice(0, 200));
  r = await ask(page, phrase);
  if (!/done|gone|deleted/i.test(r)) throw new Error('Unexpected: ' + redact(r).slice(0, 200));
}

/**
 * Keep everything already in this chat out of the picture: old exchanges, and
 * the tokens in them. Only messages that arrive from now on are shown.
 * Message ids count across all of an account's private chats, so when the page goes on to
 * other chats, pass `only`: a pattern for this chat's address (the part after #).
 */
export async function hideHistory(page, { only } = {}) {
  await page.addStyleTag({ content: '.demo-old { display: none !important; }' });
  await page.evaluate((only) => {
    const here = () => !only || new RegExp(only, 'i').test(location.hash);
    const mids = [...document.querySelectorAll('.bubble[data-mid]')].map((b) => Number(b.dataset.mid));
    const last = Math.max(0, ...mids);
    const hide = () => here() && document.querySelectorAll('.bubble[data-mid]:not(.demo-old)').forEach((b) => {
      if (Number(b.dataset.mid) <= last) b.classList.add('demo-old');
    });
    hide();
    new MutationObserver(hide).observe(document.body, { childList: true, subtree: true });
  }, only);
}

/** Turn switches off, off camera (to rehearse turning them on). `app` is the frame from openBotPage. */
export async function turnOff(page, app, labels) {
  await app.getByText('Bot Settings', { exact: true }).first().click();
  await app.locator('.tm-row-toggle').first().waitFor({ timeout: 15000 });
  for (const label of labels) {
    if ((await switches(app))[label] === 'off') continue;
    await app.locator('.tm-row-toggle', { hasText: label }).locator('.tm-toggle').click();
    await page.waitForTimeout(2500);
  }
  return switches(app);
}

/**
 * On camera: open BotFather's Mini App from its chat, pick the bot, open Bot Settings and
 * turn the given switches on, pointing at each thing before clicking it. Then close the app.
 * `page` must be on the BotFather chat.
 */
export async function configureOnCamera(page, bot, labels, { read = 1800 } = {}) {
  await pointAndClick(page, page.locator('.new-message-bot-commands').filter({ visible: true }).first());
  await page.waitForTimeout(2500);
  const launch = page.locator('.popup button', { hasText: /^Launch$/i }).first();
  if (await launch.isVisible().catch(() => false)) await pointAndClick(page, launch);
  await page.waitForFunction(
    () => [...document.querySelectorAll('iframe')].some((f) => f.src.includes('/botfather')), null, { timeout: 20000 });
  await page.waitForTimeout(4000);
  const app = page.frames().find((f) => f.url().includes('webappinternal.telegram.org/botfather'));
  if (!app) throw new Error("BotFather's Mini App did not open");
  await pointAndClick(page, app.getByText('@' + bot).first());
  await page.waitForTimeout(read);
  await pointAndClick(page, app.getByText('Bot Settings', { exact: true }).first());
  await app.locator('.tm-row-toggle').first().waitFor({ timeout: 15000 });
  // The row that unfolds under Threaded Mode comes out 2000 px tall in this browser,
  // which leaves everything below it blank. Its real content is one row high.
  await app.addStyleTag({ content: '.tm-row.tr-expand { max-height: 76px !important; }' });
  await page.waitForTimeout(read);
  for (const label of labels) {
    const row = app.locator('.tm-row-toggle', { hasText: label }).first();
    await row.scrollIntoViewIfNeeded();
    await page.waitForTimeout(700);
    if ((await switches(app))[label] === 'off') await pointAndClick(page, row.locator('.tm-toggle'));
    await page.waitForTimeout(read);
  }
  const state = await switches(app);
  for (const label of labels) if (state[label] === 'off') throw new Error(label + ' did not turn on');
  return app;
}
