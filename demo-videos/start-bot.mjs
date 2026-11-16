// One-time: press START on the demo bot from the demo account.
import { openTelegram, send } from './lib/telegram.mjs';
import { BOT } from './lib/stage.mjs';
const { context, page } = await openTelegram({ chat: BOT });
console.log(await send(page, '/start'));
await page.waitForTimeout(6000);
console.log((await page.locator('.bubble.is-in').last().innerText().catch(() => '(no reply)')).slice(0, 300));
await context.close();
