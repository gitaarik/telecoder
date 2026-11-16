// One-time: create the permanent demo bot under the demo account.
// Writes the token to .session/bot-token (never printed) and prints the username.
import { writeFile } from 'node:fs/promises';
import { openTelegram } from './lib/telegram.mjs';
import { createBot } from './lib/botfather.mjs';
const { context, page } = await openTelegram({ chat: 'BotFather' });
try {
  const { username, token } = await createBot(page, {
    name: 'TeleCoder',
    usernames: ['telecoder_demo_bot', 'telecoderdemo_bot', 'telecoder_mealplan_bot', 'mealplan_coder_bot'],
  });
  await writeFile(new URL('./.session/bot-token', import.meta.url), token + '\n', { mode: 0o600 });
  console.log('created @' + username);
} finally {
  await context.close();
}
