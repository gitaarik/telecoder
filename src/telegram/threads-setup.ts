/**
 * Walking the owner of a project bot through turning its threads on.
 *
 * Telegram has no API for it: a bot can read has_topics_enabled but not set
 * it, for itself or for a bot it manages, so every bot /newbot creates starts
 * without threads until its owner flips Threaded Mode in BotFather's Mini App.
 * A bot can't message someone who hasn't written to it, so the steps go out
 * with the first message an admin sends it. From then on it checks getMe once
 * a minute, says so when threads are on, and takes the new setting into
 * bot.botInfo (what ctx.me reads), so nothing waits for a restart.
 *
 * Only bots with a HOME_PROJECT, the ones /newbot makes: the numbered bots
 * are deliberately one conversation each, and shouldn't be told otherwise.
 */

import * as path from 'path';
import { z } from 'zod';
import type { Bot, Context, NextFunction } from 'grammy';
import { BOT_ID, config } from '../config.js';
import { isAdmin } from '../utils/admins.js';
import { ensureStateDir, getStateDir, readJsonFile, writeJsonFile } from '../utils/json-store.js';

const CHECK_EVERY_MS = 60_000;
/** How long after the steps went out it keeps checking; a restart checks once more anyway. */
const CHECK_FOR_MS = 24 * 60 * 60_000;

const stateSchema = z.object({
  /** When the steps were sent, and where to. */
  notifiedAt: z.number().optional(),
  chatId: z.number().optional(),
  /** Threads are on; nothing more to say. */
  done: z.boolean().optional(),
});
type State = z.infer<typeof stateSchema>;

const STATE_DIR = getStateDir();
const stateFile = (): string => path.join(STATE_DIR, `threads-setup-${BOT_ID}.json`);

let state: State = {};
let timer: NodeJS.Timeout | undefined;

function save(next: State): void {
  state = next;
  ensureStateDir(STATE_DIR, 'ThreadsSetup');
  writeJsonFile(stateFile(), state, 'ThreadsSetup');
}

/** The steps, for the bot's own chat. */
export function threadsSetupSteps(username: string): string {
  return '🧵 Threads are off for this bot, and Telegram only lets you turn them on yourself:\n\n' +
    `1. Open @BotFather and tap Open to start its Mini App\n2. Pick @${username}\n3. Turn on Threaded Mode\n\n` +
    'I\'ll say so here once they\'re on. Until then this chat is one conversation.';
}

async function check(bot: Bot): Promise<void> {
  const me = await bot.api.getMe();
  if (!me.has_topics_enabled) {
    if (state.notifiedAt !== undefined && Date.now() - state.notifiedAt > CHECK_FOR_MS) stop();
    return;
  }
  bot.botInfo = me;
  stop();
  save({ ...state, done: true });
  console.log('[ThreadsSetup] Threads are on');
  if (state.chatId !== undefined) {
    await bot.api.sendMessage(
      state.chatId,
      '✅ Threads are on. Start one from the bot\'s "All" view, or with 🍴 Fork; each is its own conversation, named after what it\'s about.',
    );
  }
}

function watch(bot: Bot): void {
  if (timer) return;
  timer = setInterval(() => {
    check(bot).catch((err) => console.debug('[ThreadsSetup] Check failed:', err instanceof Error ? err.message : err));
  }, CHECK_EVERY_MS);
  timer.unref?.();
}

function stop(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

/**
 * Send the steps with an admin's first private message. Call once in
 * createBot, before the handlers; it reads the setting from ctx.me.
 */
export function initThreadsSetup(bot: Bot): void {
  if (!config.HOME_PROJECT) return;
  state = readJsonFile(stateFile(), stateSchema, 'ThreadsSetup') ?? {};
  bot.use(async (ctx: Context, next: NextFunction) => {
    if (
      !state.done && state.notifiedAt === undefined && !ctx.me.has_topics_enabled
      && ctx.chat?.type === 'private' && isAdmin(ctx.from?.id)
    ) {
      save({ notifiedAt: Date.now(), chatId: ctx.chat.id });
      try {
        await ctx.reply(threadsSetupSteps(ctx.me.username), {
          reply_markup: { inline_keyboard: [[{ text: 'Open @BotFather', url: 'https://t.me/BotFather' }]] },
        });
      } catch (err) {
        console.debug('[ThreadsSetup] Failed to send the steps:', err instanceof Error ? err.message : err);
      }
      watch(bot);
    }
    return next();
  });
}

/**
 * After bot.init(): note threads that are on already, or pick the checking
 * back up after a restart if the steps went out and they still aren't.
 */
export function resumeThreadsSetup(bot: Bot): void {
  if (!config.HOME_PROJECT || state.done) return;
  if (bot.botInfo.has_topics_enabled) {
    save({ ...state, done: true });
    return;
  }
  if (state.notifiedAt !== undefined && Date.now() - state.notifiedAt < CHECK_FOR_MS) watch(bot);
}

/** Test hook. */
export function resetThreadsSetupForTest(): void {
  stop();
  state = {};
}
