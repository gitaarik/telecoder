/**
 * The /botname command: the name the bot shows in Telegram.
 *
 * `/botname <name>` saves the name per bot (it wins over `BOT_NAME`) and renames
 * the bot on Telegram. Telegram throttles renames hard, so when it refuses the
 * reply says so and the name is sent again as soon as the cooldown ends.
 * `/botname reset` goes back to `BOT_NAME`; `/botname` alone shows the state.
 */

import { Context } from 'grammy';
import { config, getBotNameSource, setStoredBotName } from '../../../config.js';
import { EntityText } from '../../../telegram/entities.js';
import { replyFormatted } from '../../../telegram/send.js';
import {
  pushBotName,
  getBotNameCooldownUntil,
  formatCooldownLeft,
  type SetMyNameResult,
} from '../../../telegram/botname-settings.js';

/** Telegram's limit on a bot's name. */
const MAX_NAME_LENGTH = 64;

export async function handleBotName(ctx: Context): Promise<void> {
  const text = ctx.message?.text || '';
  const arg = text.split(' ').slice(1).join(' ').trim();

  if (!arg) return showBotName(ctx);

  const name = arg === 'reset' ? undefined : arg;
  if (name && name.length > MAX_NAME_LENGTH) {
    await replyFormatted(ctx, `❌ A bot name is at most ${MAX_NAME_LENGTH} characters; this one is ${name.length}.`);
    return;
  }

  try {
    setStoredBotName(name);
  } catch (err) {
    await replyFormatted(ctx, `❌ Could not save the name: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const result = await pushBotName(ctx.api, config.BOT_NAME);
  const msg = new EntityText().add('✅ Bot name: ').bold(config.BOT_NAME);
  if (!name) msg.add(' (back to ').code('BOT_NAME').add(')');
  msg.newline().italic(describeResult(result));
  await replyFormatted(ctx, msg.build());
}

function describeResult(result: SetMyNameResult): string {
  switch (result.status) {
    case 'sent':
    case 'no_change':
      return 'Telegram shows it now.';
    case 'queued':
      return 'Telegram shows it within a minute.';
    case 'newly_blocked':
    case 'still_blocked':
      return `Telegram is rate-limiting renames and still shows the old name. `
        + `The new one is sent again in ${formatCooldownLeft(result.blockedUntilMs)}.`;
  }
}

async function showBotName(ctx: Context): Promise<void> {
  let live: string | undefined;
  try {
    live = (await ctx.api.getMyName()).name;
  } catch {
    live = undefined;
  }

  const msg = new EntityText().add('✏️ ').bold('Bot name').newline(2);
  msg.add('Telegram shows: ').bold(live ?? '(unknown)').newline();

  const source = getBotNameSource();
  if (source === 'default') {
    msg.add('As chosen in BotFather; ').code('BOT_NAME').add(' is not set.');
  } else {
    msg.add(source === 'command' ? 'Set with /botname: ' : 'From BOT_NAME: ').bold(config.BOT_NAME);
    const cooldownUntil = getBotNameCooldownUntil();
    if (live !== undefined && live !== config.BOT_NAME && cooldownUntil !== undefined) {
      msg.newline().add(`⏳ Telegram is rate-limiting renames; it gets this name in ${formatCooldownLeft(cooldownUntil)}.`);
    }
  }

  msg.newline(2).italic('/botname <name> renames the bot, /botname reset goes back to BOT_NAME. Admins only.');
  await replyFormatted(ctx, msg.build());
}
