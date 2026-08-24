/**
 * Naming admins in a chat.
 *
 * An approval prompt is only as good as the notification it raises: if the
 * admin has the group muted — and anyone sharing a bot with friends will mute
 * that group — a prompt that does not mention them is a prompt that is answered
 * ten minutes later by the timeout. So the gate mentions its admins by numeric
 * id, which pings them whether or not they have a @username.
 *
 * Rendering a mention needs a display name, and an id alone does not carry one.
 * `getChatMember` does, so it is asked once per (chat, admin) pair and the
 * answer is kept for the life of the process — display names change far more
 * slowly than permission prompts arrive, and a stale label on a working mention
 * is a much smaller problem than an API round-trip on every prompt.
 */

import type { Api } from 'grammy';
import { getAdminIds } from '../utils/admins.js';
import { EntityText } from './entities.js';

interface KnownAdmin {
  id: number;
  name: string;
}

interface CacheEntry {
  /** Display name, or '' for "not reachable in this chat". */
  name: string;
  /** Epoch ms after which a miss is retried. Absent on a hit — names are kept. */
  expiresAt?: number;
}

const nameCache = new Map<string, CacheEntry>();

/**
 * How long a failed lookup sticks. A miss is usually "not a member yet", and
 * that changes the moment the admin joins the group — so misses expire, while
 * a resolved name is kept for the life of the process.
 */
const MISS_TTL_MS = 10 * 60 * 1000;

function cacheKey(chatId: number, userId: number): string {
  return `${chatId}:${userId}`;
}

/**
 * Look up the admins' display names in this chat. Admins the lookup cannot
 * resolve — not a member, or the API call failed — are dropped rather than
 * rendered with a placeholder: a mention of someone who is not in the chat
 * notifies nobody, and listing them would suggest an approver who cannot see
 * the prompt.
 */
export async function resolveAdminsInChat(api: Api, chatId: number): Promise<KnownAdmin[]> {
  const resolved: KnownAdmin[] = [];

  for (const id of getAdminIds()) {
    const key = cacheKey(chatId, id);
    const cached = nameCache.get(key);
    if (cached && (cached.expiresAt === undefined || cached.expiresAt > Date.now())) {
      if (cached.name) resolved.push({ id, name: cached.name });
      continue;
    }

    try {
      const member = await api.getChatMember(chatId, id);
      const user = member.user;
      const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || `admin ${id}`;
      nameCache.set(key, { name });
      resolved.push({ id, name });
    } catch {
      // Not a member of this chat, or a transient API failure. Cache the miss
      // briefly so a burst of prompts doesn't re-ask on every one, but let it
      // expire so an admin who joins later starts getting mentioned.
      nameCache.set(key, { name: '', expiresAt: Date.now() + MISS_TTL_MS });
    }
  }

  return resolved;
}

/**
 * Append "Only X can approve." to a prompt, with each admin as a real mention.
 * Falls back to a countless phrasing when no admin could be resolved, so the
 * sentence still reads correctly rather than trailing off.
 */
export function appendApproverLine(builder: EntityText, admins: KnownAdmin[]): EntityText {
  if (admins.length === 0) {
    return builder.add('Only an admin can approve this.');
  }

  builder.add('Only ');
  admins.forEach((admin, index) => {
    if (index > 0) builder.add(index === admins.length - 1 ? ' or ' : ', ');
    builder.mention(admin.name, admin.id);
  });
  return builder.add(' can approve this.');
}

/** The toast shown when someone taps an approval button that isn't theirs. */
export function describeResponderRefusal(allowedResponderIds: number[] | undefined): string {
  const count = allowedResponderIds?.length ?? 0;
  if (count === 0) return 'You cannot answer this question.';
  return count === 1
    ? 'Only this bot’s admin can answer that one.'
    : 'Only a bot admin can answer that one.';
}

/** Test seam — production keeps the cache for the life of the process. */
export function resetAdminNameCache(): void {
  nameCache.clear();
}
