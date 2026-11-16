// Show a bot's switches in BotFather, turning on any that are named:
// node bot-settings.mjs telecoder_demo_bot ["Threaded Mode" ...]
import { openTelegram } from './lib/telegram.mjs';
import { openBotPage, turnOn } from './lib/botfather.mjs';
const [bot, ...labels] = process.argv.slice(2);
const { context, page } = await openTelegram({ chat: 'BotFather' });
try {
  const app = await openBotPage(page, bot);
  console.log(await turnOn(page, app, labels));
} finally {
  await context.close();
}
