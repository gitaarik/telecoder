/**
 * The card an admin taps to let someone in.
 *
 * A stranger who speaks in the shared group is, on a bot shared with friends,
 * almost always someone who was just added to it. Answering them with nothing
 * but "⛔ You are not authorized" leaves the admin to notice, ask for their
 * numeric id, edit `.env` and restart — four steps, three of them off Telegram,
 * for what is socially a nod.
 *
 * So the denial carries an approval card instead: who they are, where they
 * turned up, and two buttons. It mentions its admins by numeric id for the same
 * reason the permission gate does — the group is muted, and a card nobody is
 * notified about is a card answered tomorrow.
 *
 * The card is only ever posted in an allow-listed group. A stranger who finds
 * the bot in a private chat gets the flat denial and no card: an approval
 * request that only its subject can see is not a request, and posting one per
 * unknown DM is a way to have strangers ring the admin's phone.
 */

import type { Context } from 'grammy';
import { config } from '../config.js';
import { getAdminIds } from '../utils/admins.js';
import { describeUser, noteSeenUser, type UserIdentity } from '../utils/user-roster.js';
import { BoundedMap } from '../utils/bounded-map.js';
import { sanitizeError } from '../utils/sanitize.js';
import { resolveAdminsInChat, appendApproverLine } from './admin-mention.js';
import { EntityText, clip } from './entities.js';

/** Callback data prefix for the card's buttons. Matched in bot.ts. */
export const ACCESS_CALLBACK_PREFIX = 'access';

/**
 * How long before a stranger who keeps talking earns a second card. Long
 * enough that a burst of messages posts one card, short enough that an admin
 * who scrolled past the first still gets another within the hour.
 */
const RE_ASK_MS = 30 * 60 * 1000;

/**
 * Bounded because the keys are (chat, stranger) pairs and a stranger is
 * whoever turns up — an unbounded map here would be a slow leak driven by
 * people the bot has already turned away.
 */
const lastAsked = new BoundedMap<string, number>(500);

function askKey(chatId: number, userId: number): string {
  return `${chatId}:${userId}`;
}

/** Longest display name the card will render before clipping. */
const MAX_NAME_CHARS = 64;

/**
 * Lay out the card. Exported for tests — the wording and the entity offsets are
 * the whole product, and both are worth pinning down.
 */
export function buildAccessRequestMessage(parts: {
  user: UserIdentity;
  admins: { id: number; name: string }[];
}): { text: string; entities: ReturnType<EntityText['build']>['entities'] } {
  const b = new EntityText();
  const { user } = parts;

  b.add('👋 ').bold('Access requested').newline();

  const name = user.name ? clip(user.name, MAX_NAME_CHARS) : undefined;
  if (name) {
    // A text_mention rather than plain text: it renders as a link to their
    // profile, which is how an admin tells two people with the same first name
    // apart before deciding.
    b.mention(name, user.id);
    if (user.username) b.add(` (@${user.username})`);
  } else if (user.username) {
    b.add(`@${user.username}`);
  } else {
    b.add('Someone');
  }
  b.add(' wants to use this bot.').newline();

  b.add('User id: ').code(String(user.id)).newline(2);

  appendApproverLine(b, parts.admins);

  return b.build();
}

/** The two buttons, as grammy's inline keyboard shape. */
export function accessKeyboard(userId: number): { text: string; callback_data: string }[][] {
  return [[
    { text: '✅ Allow', callback_data: `${ACCESS_CALLBACK_PREFIX}:${userId}:y` },
    { text: '🚫 Ignore', callback_data: `${ACCESS_CALLBACK_PREFIX}:${userId}:n` },
  ]];
}

/**
 * What came of asking. `pending` covers both a card just sent and one still
 * standing from a minute ago — the caller words its refusal off this, and to
 * someone waiting there is no difference between the two. Reporting the
 * cooldown as a failure would tell them "not authorized" on their second
 * message and "an admin has been asked" on their first, which reads as though
 * the request evaporated.
 */
export type AccessRequestOutcome = 'pending' | 'not-asked';

/**
 * Post the card for an unknown user, if this chat is one where that makes
 * sense.
 *
 * Every failure path is swallowed: this runs inside the auth middleware's
 * denial, and a bot that crashes on an unauthorised message is a bot anyone can
 * take down by messaging it.
 */
export async function requestAccess(ctx: Context, user: UserIdentity): Promise<AccessRequestOutcome> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return 'not-asked';

  // Only in the groups the operator has already named. See the module note.
  if (!config.ALLOWED_GROUP_IDS.includes(chatId)) return 'not-asked';

  // Nobody to ask.
  if (getAdminIds().length === 0) return 'not-asked';

  const key = askKey(chatId, user.id);
  const asked = lastAsked.get(key);
  if (asked !== undefined && Date.now() - asked < RE_ASK_MS) return 'pending';
  lastAsked.set(key, Date.now());

  try {
    // Record them first: if the send fails, `/allow @them` should still work.
    noteSeenUser(user, chatId);

    const admins = await resolveAdminsInChat(ctx.api, chatId);
    const { text, entities } = buildAccessRequestMessage({ user, admins });
    const threadId = ctx.message?.message_thread_id;
    const threadOpts = threadId !== undefined ? { message_thread_id: threadId } : {};

    await ctx.api.sendMessage(chatId, text, {
      entities,
      reply_markup: { inline_keyboard: accessKeyboard(user.id) },
      ...threadOpts,
    });
    console.log(`[access] requested for ${describeUser(user)} in chat:${chatId}`);
    return 'pending';
  } catch (error) {
    // A text_mention Telegram won't render here is the likely cause, and the
    // card is worth more unstyled than not at all.
    console.error('[access] card send failed:', sanitizeError(error));
    try {
      const { text } = buildAccessRequestMessage({ user, admins: [] });
      await ctx.api.sendMessage(chatId, text, {
        reply_markup: { inline_keyboard: accessKeyboard(user.id) },
      });
      return 'pending';
    } catch (retryError) {
      console.error('[access] card retry failed:', sanitizeError(retryError));
      // Let the next message try again rather than staying silent for 30 min.
      lastAsked.delete(key);
      return 'not-asked';
    }
  }
}

/**
 * Forget the cooldown for a user, so a decision taken on one card does not
 * suppress a fresh card if they are later revoked.
 */
export function clearAccessCooldown(userId: number): void {
  for (const key of [...lastAsked.keys()]) {
    if (key.endsWith(`:${userId}`)) lastAsked.delete(key);
  }
}

/** Test seam — production keeps the cooldowns for the life of the process. */
export function resetAccessCooldowns(): void {
  lastAsked.clear();
}
