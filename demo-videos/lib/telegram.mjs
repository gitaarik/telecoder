// The Telegram Web pane: the demo account's logged-in profile, opened on one chat.
import { firefox } from 'playwright-core';
import { REMOTE, acquireBrowser, releaseBrowser, telegramState } from './browser.mjs';
import { installCursor, pointAndClick } from './cursor.mjs';

// Message text a little larger, to sit next to the terminal's; no unread counter on the
// back button, which other chats' messages would set off.
const TELEGRAM_CSS = ':root { --messages-text-size: 19px !important; } .back-unread-badge { display: none !important; } .sidebar-left-contacts-section, [class*="_suggestion_"] { display: none !important; }';

const dir = new URL('../.session/', import.meta.url).pathname;

/** @param {{ chat: string, width?: number, height?: number, recordVideo?: object }} opts */
export async function openTelegram({ chat, width = 640, height = 1000, recordVideo }) {
  let context;
  if (REMOTE) {
    const browser = await acquireBrowser();
    context = await browser.newContext({
      storageState: await telegramState(), viewport: { width, height }, colorScheme: 'dark', reducedMotion: 'reduce', recordVideo,
    });
    // A moment later, so the close itself has been answered before the connection goes.
    context.once('close', () => { setTimeout(releaseBrowser, 300); });
  } else {
    context = await firefox.launchPersistentContext(dir + 'profile', {
      headless: true, viewport: { width, height }, colorScheme: 'dark', reducedMotion: 'reduce', recordVideo,
    });
  }
  await context.addInitScript(installCursor, TELEGRAM_CSS);
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`https://web.telegram.org/k/#@${chat}`, { waitUntil: 'domcontentloaded' });
  await page.locator('.chat.active, .chat').first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(2500);
  return { context, page };
}

/** Type a message like a person and send it. Presses START first on a bot never spoken to. */
export async function send(page, text, { delay = 45 } = {}) {
  // After moving to another chat the previous chat's box is still in the page, hidden.
  const input = page.locator('.input-message-input:not(.input-field-input-fake)').filter({ visible: true }).last();
  // A bot never spoken to shows a START button over the box.
  const start = page.locator('.chat-input-control').filter({ visible: true }).getByText(/^start$/i).last();
  if ((await start.isVisible().catch(() => false)) || !(await input.isVisible().catch(() => false))) {
    await pointAndClick(page, start);
    return 'start-button';
  }
  await pointAndClick(page, input);
  await page.keyboard.type(text, { delay });
  // Telegram Web can take the focus away mid-sentence. Never send a half-typed
  // message: if the box doesn't hold exactly the text, put it in at once.
  const typed = (await input.innerText()).replace(/\u00a0/g, ' ').trim();
  if (typed !== text.trim()) {
    await input.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    await page.keyboard.insertText(text);
    await page.waitForTimeout(400);
  }
  await page.keyboard.press('Enter');
  return 'typed';
}

const THREAD_ROW = '.chatlist-chat[data-thread-id]';

/**
 * Delete every thread in the bot chat, so a recording starts on an empty chat.
 * Telegram Web keeps a deleted thread's row until it is reopened, so each
 * thread gets a fresh browser.
 */
export async function deleteAllThreads(chat) {
  const tried = new Set();
  let empty = 0; // two empty looks in a row, since the list can load late
  for (let i = 0; i < 40; i++) {
    const { context, page } = await openTelegram({ chat, width: 1100, height: 800 });
    try {
      await page.locator(THREAD_ROW).first().waitFor({ timeout: 10000 }).catch(() => {});
      const ids = await page.evaluate(
        (sel) => [...document.querySelectorAll(sel)].map((r) => r.dataset.threadId),
        THREAD_ROW,
      );
      const id = ids.find((x) => !tried.has(x));
      if (!id) {
        if (++empty >= 2) return { deleted: tried.size, left: ids.length };
        continue;
      }
      empty = 0;
      tried.add(id);
      await page.locator(`${THREAD_ROW}[data-thread-id="${id}"]`).first().click();
      await page.waitForTimeout(1500);
      // Only inside a thread: at the chat's top level the command deletes
      // nothing and leaves a message behind.
      const header = await page.locator('.chat.active .topbar, .topbar').first().innerText().catch(() => '');
      if (!/\bIn \S/.test(header)) continue;
      await send(page, '/deletethread -y', { delay: 5 });
      await page.waitForTimeout(3500);
    } finally {
      await context.close();
    }
  }
  return { deleted: tried.size, left: -1 };
}

/** Texts of the inline buttons currently in the chat. */
export const buttons = (page) =>
  page.evaluate(() => [...document.querySelectorAll('.reply-markup-button')].map((b) => b.innerText.trim()));

/** Wait for an inline button whose text matches, and return its text. */
export async function waitForButton(page, pattern, timeout = 240_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const hit = (await buttons(page)).find((b) => pattern.test(b));
    if (hit) return hit;
    await page.waitForTimeout(500);
  }
  throw new Error(`No button matching ${pattern} within ${timeout / 1000}s`);
}

export const tapButton = (page, text) => pointAndClick(page, page.locator('.reply-markup-button', { hasText: text }).last());

/** A reply is finished when its closing status line arrives: the message with the Fork button. */
export const waitForReplyDone = (page, timeout = 300_000) => waitForButton(page, /^Fork$/, timeout);

/** How many status lines (the closing "project · mode · model · context · cost" message) the chat shows. */
export const statusLines = (page) =>
  page.evaluate(() => [...document.querySelectorAll('.bubble.is-in')].filter((b) => /\d+%\s*·[^]*\$\d|·[^\n]*\bAuto\s*$/m.test(b.innerText)).length);
// Telegram Web draws emoji as images, so the line's icons aren't in its text: match "3% · $0.24".
// A PTY chat's first status line has no context or cost yet: "mealplan · Auto".

/**
 * Wait for the next status line. Use where the chat has no threads, since the
 * status line carries no Fork button there. `before` is statusLines() from before the prompt.
 */
export async function waitForStatusLine(page, before, timeout = 300_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if ((await statusLines(page)) > before) return;
    await page.waitForTimeout(500);
  }
  throw new Error(`No status line within ${timeout / 1000}s`);
}

/**
 * Leave only these chats in the chat list (peer ids), so a take never shows leftovers of
 * earlier runs. Call it again with another list to change it, and after every reload.
 */
export const onlyChats = (page, ids) => page.evaluate((css) => {
  const style = document.getElementById('demo-only-chats') ?? document.head.appendChild(Object.assign(document.createElement('style'), { id: 'demo-only-chats' }));
  style.textContent = css;
}, `.chatlist-chat[data-peer-id]${ids.map((id) => `:not([data-peer-id="${id}"])`).join('')} { display: none !important; }`);
