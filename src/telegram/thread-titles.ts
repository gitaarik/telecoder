/**
 * Naming the threads of a private chat after what they're about.
 *
 * A message sent from a bot's "All" view starts a new thread, and Telegram
 * names it "New chat" and flags the name as implicit: one the bot is expected
 * to replace. The session topic (Haiku's summary, or what the agent set with
 * telecoder_set_topic) already says what the thread is about, so every topic
 * change is passed on to the thread with editForumTopic. Only the topic's
 * first half goes in: the broad area, which stays put while the second half,
 * the task of the moment, changes with every message. The project's folder
 * name goes in front, since one bot's threads can each be in another project.
 *
 * A name the user gave the thread is theirs, and is never overwritten: one
 * typed when creating the thread, or a rename seen afterwards. Group forum
 * topics are left alone entirely; people name those for each other.
 *
 * Who owns each thread's name, and what we last set it to, is kept per bot
 * so a restart neither forgets a user's rename nor re-sends the same name.
 */

import * as path from 'path';
import { z } from 'zod';
import type { Api, Bot, Context, NextFunction } from 'grammy';
import { BOT_ID } from '../config.js';
import { ensureStateDir, getStateDir, readJsonFile, writeJsonFile } from '../utils/json-store.js';
import { buildSessionKey, parseSessionKey } from '../utils/session-key.js';
import { TOPIC_PART_SEPARATOR } from '../claude/auto-topic-haiku.js';

/** Telegram's limit on a topic name. */
const MAX_NAME_LENGTH = 128;
/**
 * At most one rename per thread per this long. The topic can change several
 * times in a few seconds (Haiku's guess, then the agent's own), and each
 * rename leaves a service message in the thread; only the last one matters.
 */
const RENAME_COOLDOWN_MS = 60_000;

const titleSchema = z.object({
  /** 'user' names are never touched; 'implicit' and 'bot' ones are ours to replace. */
  owner: z.enum(['implicit', 'bot', 'user']),
  name: z.string().optional(),
  /** Goes in front of every name we give the thread, e.g. 🍴 for a fork's. */
  prefix: z.string().optional(),
});
const fileSchema = z.object({ threads: z.record(z.string(), titleSchema) });
type ThreadTitle = z.infer<typeof titleSchema>;

const STATE_DIR = getStateDir();
const STATE_FILE = path.join(STATE_DIR, `thread-titles-${BOT_ID}.json`);

let threads: Record<string, ThreadTitle> | undefined;
let api: Api | undefined;
const lastRenameAt = new Map<string, number>();
const pending = new Map<string, { name: string; timer: NodeJS.Timeout }>();

function state(): Record<string, ThreadTitle> {
  if (!threads) {
    ensureStateDir(STATE_DIR, 'ThreadTitles');
    threads = { ...(readJsonFile(STATE_FILE, fileSchema, 'ThreadTitles')?.threads ?? {}) };
  }
  return threads;
}

function record(sessionKey: string, title: ThreadTitle): void {
  state()[sessionKey] = title;
  writeJsonFile(STATE_FILE, { threads: state() }, 'ThreadTitles');
}

/**
 * The name a topic gives a thread: its first half, the broad area, which
 * holds still while the second half follows each message. A topic set by
 * hand or by the agent has no halves and goes in whole.
 *
 * The project leads, so it survives the thread list cutting names short. It
 * is left out when the topic already names it, as Haiku's often does, and is
 * the whole name while there is no topic yet, as just after a project switch.
 */
export function threadName(topic: string, prefix = '', project = ''): string {
  const general = topic.split(TOPIC_PART_SEPARATOR)[0].trim();
  const showProject = project && !general.toLowerCase().includes(project.toLowerCase());
  const name = [showProject ? project : '', general].filter(Boolean).join(TOPIC_PART_SEPARATOR);
  if (!name) return '';
  return `${prefix}${name}`.slice(0, MAX_NAME_LENGTH);
}

/**
 * Take on a thread the bot created itself, under the name it was created
 * with, so the topic it inherits isn't sent straight back as a rename.
 */
export function adoptThread(sessionKey: string, name: string, prefix?: string): void {
  record(sessionKey, { owner: 'bot', name, ...(prefix ? { prefix } : {}) });
}

/** A thread of a private chat, which is the only kind we name. */
function isPrivateThread(sessionKey: string): boolean {
  const { chatId, threadId } = parseSessionKey(sessionKey);
  return threadId !== undefined && chatId > 0;
}

/**
 * Whether a topic for this session would end up as a thread name — for the
 * auto-topic side call, which otherwise only runs when something displays it.
 */
export function namesThread(sessionKey: string): boolean {
  return api !== undefined && isPrivateThread(sessionKey) && state()[sessionKey]?.owner !== 'user';
}

/**
 * Learn who named each thread from the messages that pass by: the creation
 * notice every thread message replies to says whether its name was implicit,
 * and a rename notice is the user's (the bot gets no updates for its own).
 */
function observe(ctx: Context): void {
  const msg = ctx.message;
  if (!msg?.is_topic_message || msg.message_thread_id === undefined) return;
  const sessionKey = buildSessionKey(msg.chat.id, msg.message_thread_id);
  if (!isPrivateThread(sessionKey)) return;

  const edited = msg.forum_topic_edited;
  if (edited?.name !== undefined && msg.from?.id !== ctx.me.id) {
    // Logged in full while it's new: whether Telegram's own names for threads
    // arrive this way, as the user's, is not documented.
    console.log(`[ThreadTitles] ${sessionKey} renamed to "${edited.name}" by ${msg.from?.is_bot ? 'bot' : 'user'} ${msg.from?.id}`);
    if (edited.name === state()[sessionKey]?.name) return;
    record(sessionKey, { owner: 'user', name: edited.name });
    return;
  }

  if (state()[sessionKey]) return;
  const created = msg.forum_topic_created ?? msg.reply_to_message?.forum_topic_created;
  if (!created) return;
  record(sessionKey, { owner: created.is_name_implicit ? 'implicit' : 'user', name: created.name });
}

async function rename(sessionKey: string, name: string): Promise<void> {
  const current = state()[sessionKey];
  if (!api || current?.owner === 'user') return;
  if (current?.name === name) return;
  const { chatId, threadId } = parseSessionKey(sessionKey);
  lastRenameAt.set(sessionKey, Date.now());
  try {
    await api.editForumTopic(chatId, threadId!, { name });
    record(sessionKey, { owner: 'bot', name, ...(current?.prefix ? { prefix: current.prefix } : {}) });
  } catch (err) {
    console.debug(`[ThreadTitles] Failed to rename ${sessionKey}:`, err instanceof Error ? err.message : err);
  }
}

/**
 * Pass a new session topic on to the thread's name. A no-op outside private
 * threads, for an empty topic in no known project, and for a name the user
 * chose. Renames inside the cooldown are held and only the latest one is sent
 * when it runs out.
 */
export function syncThreadTitle(sessionKey: string, topic: string, project?: string): void {
  if (!namesThread(sessionKey)) return;
  const name = threadName(topic, state()[sessionKey]?.prefix, project);
  if (!name) return;

  const held = pending.get(sessionKey);
  if (held) clearTimeout(held.timer);
  pending.delete(sessionKey);

  const wait = (lastRenameAt.get(sessionKey) ?? 0) + RENAME_COOLDOWN_MS - Date.now();
  if (wait <= 0) {
    void rename(sessionKey, name);
    return;
  }
  const timer = setTimeout(() => {
    pending.delete(sessionKey);
    void rename(sessionKey, name);
  }, wait);
  timer.unref?.();
  pending.set(sessionKey, { name, timer });
}

/** Start naming threads on `bot`. Call once, after auth, before the handlers. */
export function initThreadTitles(bot: Bot): void {
  api = bot.api;
  bot.use((ctx: Context, next: NextFunction) => {
    try {
      observe(ctx);
    } catch (err) {
      console.debug('[ThreadTitles] Failed to read a thread notice:', err instanceof Error ? err.message : err);
    }
    return next();
  });
}

/** Test hook: forget the module state between cases. */
export function resetThreadTitlesForTest(testApi?: Api): void {
  threads = undefined;
  api = testApi;
  lastRenameAt.clear();
  for (const { timer } of pending.values()) clearTimeout(timer);
  pending.clear();
}
