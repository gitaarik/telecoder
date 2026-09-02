/**
 * Who may use this bot, beyond the ids written into `.env`.
 *
 * `ALLOWED_USER_IDS` is read once at startup, so every new person costs an edit
 * and a restart — which is the wrong shape for a bot shared with friends, where
 * the natural moment to grant access is the moment someone turns up in the
 * group. This module is the mutable half of the allow-list: an admin admits
 * someone, it persists, and it takes effect immediately.
 *
 * The two halves are deliberately asymmetric. Ids from `.env` are the operator's
 * standing decision and cannot be revoked from chat — a `/deny` that appeared to
 * work and then un-did itself on the next restart is worse than one that says
 * where the id actually lives. Ids admitted here can be revoked here.
 *
 * ## Why a "seen" list exists
 *
 * There is no Bot API call that turns a `@username` into a user id.
 * `getChatAdministrators` returns full user objects but only for a group's
 * admins; nothing enumerates ordinary members. So the only usernames this bot
 * can ever resolve are the ones it has watched go by — a message sent, or a
 * `new_chat_members` service update — and `/allow @someone` is a lookup into
 * that history rather than a query to Telegram.
 *
 * Ids are the identity everywhere; usernames are a convenience for typing.
 * Telegram usernames can be dropped and re-claimed by someone else, so a
 * username is re-resolved on every use and never stored as the thing being
 * allowed.
 */

import * as path from 'path';
import { z } from 'zod';
import { config } from '../config.js';
import { ensureStateDir, getStateDir, readJsonFile, writeJsonFile } from './json-store.js';

/**
 * How many observed-but-not-admitted people to remember. Enough that a name
 * mentioned in yesterday's conversation still resolves, small enough that the
 * file stays a file; the oldest sighting is dropped first.
 */
const MAX_SEEN = 200;

const admittedSchema = z.object({
  id: z.number(),
  username: z.string().optional(),
  name: z.string().optional(),
  admittedAt: z.string(),
  admittedBy: z.number(),
});

const seenSchema = z.object({
  id: z.number(),
  username: z.string().optional(),
  name: z.string().optional(),
  chatId: z.number().optional(),
  seenAt: z.string(),
});

const rosterSchema = z.object({
  admitted: z.array(admittedSchema).default([]),
  seen: z.array(seenSchema).default([]),
});

export type AdmittedUser = z.infer<typeof admittedSchema>;
export type SeenUser = z.infer<typeof seenSchema>;

/** The identifying fields this module takes off a Telegram `User`. */
export interface UserIdentity {
  id: number;
  username?: string;
  name?: string;
}

const LABEL = 'UserRoster';

/**
 * Resolved on use rather than at import. The state directory hangs off the home
 * directory, and binding that into a module-level constant makes the first
 * `import` of this file a filesystem decision — which is both untestable and a
 * side effect nothing asked for.
 */
function rosterFile(): string {
  return path.join(getStateDir(), 'user-roster.json');
}

let admitted: AdmittedUser[] = [];
let seen: SeenUser[] = [];
let loaded = false;

function load(): void {
  if (loaded) return;
  ensureStateDir(getStateDir(), LABEL);
  const data = readJsonFile(rosterFile(), rosterSchema, LABEL);
  admitted = data?.admitted ?? [];
  seen = data?.seen ?? [];
  loaded = true;
}

function save(opts?: { rethrow?: boolean }): void {
  writeJsonFile(rosterFile(), { admitted, seen }, LABEL, opts);
}

/** Normalise a username for comparison: no leading `@`, case-insensitive. */
function normaliseUsername(value: string): string {
  return value.replace(/^@/, '').toLowerCase();
}

/** A human label for a user, preferring the display name over the handle. */
export function describeUser(user: UserIdentity): string {
  if (user.name && user.username) return `${user.name} (@${user.username})`;
  if (user.name) return user.name;
  if (user.username) return `@${user.username}`;
  return `id ${user.id}`;
}

/** Ids allowed by `.env`. Separated out because they are not revocable here. */
export function envAllowedIds(): number[] {
  return [...config.ALLOWED_USER_IDS];
}

/** Every id that may use this bot: the `.env` list plus everyone admitted since. */
export function allAllowedUserIds(): number[] {
  load();
  const ids = new Set(config.ALLOWED_USER_IDS);
  for (const user of admitted) ids.add(user.id);
  return [...ids];
}

/**
 * The allow-list check the auth middleware runs. Replaces a direct
 * `config.ALLOWED_USER_IDS.includes()` so an admitted user is let through
 * without a restart.
 */
export function isAllowedUser(userId: number | undefined): boolean {
  if (userId === undefined) return false;
  if (config.ALLOWED_USER_IDS.includes(userId)) return true;
  load();
  return admitted.some((user) => user.id === userId);
}

/**
 * Everyone admitted from chat, most recent first.
 *
 * Array order is the ordering, not the timestamp: entries are appended as they
 * are added, and two things that happen in the same millisecond carry identical
 * ISO strings, which would leave a comparator to fall back on stable order
 * anyway — and get it backwards.
 */
export function listAdmitted(): AdmittedUser[] {
  load();
  return [...admitted].reverse();
}

/** Everyone observed but not currently allowed, most recently seen first. */
export function listPending(): SeenUser[] {
  load();
  return [...seen].reverse().filter((user) => !isAllowedUser(user.id));
}

/**
 * Record that a user was observed, so `/allow @them` can resolve later. Called
 * for allowed and unknown users alike — the allowed ones are how an admin looks
 * up someone already in, and it keeps display names fresh.
 */
export function noteSeenUser(user: UserIdentity, chatId?: number): void {
  load();
  const entry: SeenUser = {
    id: user.id,
    ...(user.username ? { username: user.username } : {}),
    ...(user.name ? { name: user.name } : {}),
    ...(chatId !== undefined ? { chatId } : {}),
    seenAt: new Date().toISOString(),
  };

  const existing = seen.findIndex((s) => s.id === user.id);
  const unchanged =
    existing !== -1 &&
    seen[existing].username === entry.username &&
    seen[existing].name === entry.name &&
    seen[existing].chatId === entry.chatId;

  // Every message from an allowed user would otherwise be a disk write. Only
  // the first sighting and a genuine change to the identifying fields are
  // worth persisting; a refreshed timestamp on its own is not.
  if (unchanged) return;

  if (existing !== -1) seen.splice(existing, 1);
  seen.push(entry);
  if (seen.length > MAX_SEEN) seen = seen.slice(seen.length - MAX_SEEN);
  save();
}

/**
 * Resolve `@username`, a bare username, or a numeric id against what the bot
 * has seen. A numeric id resolves even for someone never observed — an admin
 * who already knows the id should not have to wait for a message first.
 */
export function resolveUser(query: string): UserIdentity | undefined {
  load();
  const trimmed = query.trim();
  if (!trimmed) return undefined;

  if (/^-?\d+$/.test(trimmed)) {
    const id = parseInt(trimmed, 10);
    const known = seen.find((user) => user.id === id) ?? admitted.find((user) => user.id === id);
    return known ? { id, username: known.username, name: known.name } : { id };
  }

  const wanted = normaliseUsername(trimmed);
  if (!wanted) return undefined;

  // Newest sighting wins: a username that has changed hands should resolve to
  // whoever is carrying it now, not whoever carried it first. `seen` is append
  // ordered — noteSeenUser re-pushes on every change — so the last match is the
  // most recent one, without depending on timestamps being distinct.
  for (let i = seen.length - 1; i >= 0; i--) {
    const candidate = seen[i];
    if (candidate.username && normaliseUsername(candidate.username) === wanted) {
      return { id: candidate.id, username: candidate.username, name: candidate.name };
    }
  }

  const fromRoster = admitted.find(
    (user) => user.username && normaliseUsername(user.username) === wanted,
  );
  return fromRoster ? { id: fromRoster.id, username: fromRoster.username, name: fromRoster.name } : undefined;
}

export type AdmitResult = 'admitted' | 'already-allowed';

/**
 * Add a user to the roster. Reports `already-allowed` for someone who could
 * already use the bot, whether from `.env` or from an earlier `/allow`, so the
 * caller can say so rather than claiming to have changed something.
 *
 * Write failures propagate: this is reported to an admin as "they're in", and
 * saying that when nothing reached disk would strand a guest at the next restart.
 */
export function admitUser(user: UserIdentity, admittedBy: number): AdmitResult {
  load();
  if (isAllowedUser(user.id)) return 'already-allowed';

  admitted.push({
    id: user.id,
    ...(user.username ? { username: user.username } : {}),
    ...(user.name ? { name: user.name } : {}),
    admittedAt: new Date().toISOString(),
    admittedBy,
  });
  save({ rethrow: true });
  return 'admitted';
}

export type RevokeResult = 'revoked' | 'env-configured' | 'not-allowed';

/**
 * Remove a user from the roster.
 *
 * `env-configured` means the id is in `ALLOWED_USER_IDS`, where this module
 * cannot reach it. Reporting that beats deleting a roster entry that was never
 * what was granting access, which would look like it worked until the user
 * carried on using the bot.
 */
export function revokeUser(userId: number): RevokeResult {
  load();
  if (config.ALLOWED_USER_IDS.includes(userId)) return 'env-configured';

  const index = admitted.findIndex((user) => user.id === userId);
  if (index === -1) return 'not-allowed';

  admitted.splice(index, 1);
  save({ rethrow: true });
  return 'revoked';
}

/** Test seam — production loads once and keeps the roster for the process. */
export function resetRosterCache(): void {
  admitted = [];
  seen = [];
  loaded = false;
}
