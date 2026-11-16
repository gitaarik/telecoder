// Give the demo bot a new token and write it to .session/bot-token (never printed).
// Run this if the token was ever shown on screen or in a log.
import { writeFile } from 'node:fs/promises';
import { openTelegram } from './lib/telegram.mjs';
import { revokeToken } from './lib/botfather.mjs';
const bot = process.argv[2];
const { context, page } = await openTelegram({ chat: 'BotFather' });
try {
  const token = await revokeToken(page, bot);
  await writeFile(new URL('./.session/bot-token', import.meta.url), token + '\n', { mode: 0o600 });
  console.log('new token saved for @' + bot);
} finally {
  await context.close();
}
