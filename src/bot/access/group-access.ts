/**
 * Who, inside an allow-listed group, may actually drive the agent.
 *
 * `ALLOWED_GROUP_IDS` answers a coarser question — may the bot be used in this
 * chat at all — and answers it with Telegram membership. That is the right gate
 * for a group of peers, and the wrong one for a group where some people are
 * there to watch: a prompt to the agent is shell access on the host, while
 * reading along is harmless. This store is the finer gate layered on top.
 *
 * Three roles:
 *   - admin       — `isAdmin()`: a user id in ADMIN_USER_IDS, or every allowed
 *                   user when that is unset. Full access, in DMs and in every
 *                   group; the only role that can hand out the others.
 *                   Config-level, so it can't be granted or revoked from chat.
 *   - contributor — may address the bot in one specific group. Anyone on the
 *                   global roster is one everywhere by definition — they can
 *                   already DM the bot, so denying them a group would be
 *                   theatre.
 *   - spectator   — present in the group, ignored by the bot. Talks to the
 *                   humans; can't send the agent a prompt.
 *
 * `GROUP_MEMBERS_DEFAULT` decides which of the latter two an ungranted member
 * falls into, so the store only ever holds the exceptions to it: `allow` is
 * what matters under a `spectator` default, `deny` under a `contributor` one,
 * and either default is safe to change afterwards without rewriting the file.
 *
 * Deliberately *not* here: a username→id cache. The global roster
 * (`utils/user-roster.ts`) already learns a handle from every message the bot
 * sees, including from spectators, and `resolveUser` reads it back. One cache
 * for one question.
 */

import * as path from 'path';
import { z } from 'zod';
import { BOT_ID, config } from '../../config.js';
import { isAdmin } from '../../utils/admins.js';
import { isAllowedUser } from '../../utils/user-roster.js';
import { ensureStateDir, getStateDir, readJsonFile, writeJsonFile } from '../../utils/json-store.js';

const LABEL = 'GroupAccess';

export type AccessRole = 'admin' | 'contributor' | 'spectator';

const entrySchema = z.object({
  /** Handle as last seen, for display only — resolution always goes by id. */
  username: z.string().optional(),
  grantedBy: z.number().optional(),
  grantedAt: z.string().optional(),
});

export type AccessEntry = z.infer<typeof entrySchema>;

const groupSchema = z.object({
  allow: z.record(z.string(), entrySchema).default({}),
  deny: z.record(z.string(), entrySchema).default({}),
});

const fileSchema = z.object({
  groups: z.record(z.string(), groupSchema).default({}),
});

type StoreFile = z.infer<typeof fileSchema>;

function emptyStore(): StoreFile {
  return { groups: {} };
}

let stateDir = getStateDir();
let cache: StoreFile | undefined;

function filePath(): string {
  return path.join(stateDir, `group-access-${BOT_ID}.json`);
}

function store(): StoreFile {
  if (!cache) cache = readJsonFile(filePath(), fileSchema, LABEL) ?? emptyStore();
  return cache;
}

function save(): void {
  ensureStateDir(stateDir, LABEL);
  writeJsonFile(filePath(), store(), LABEL, { rethrow: true });
}

/** Point the store at another directory and drop the cache. Test seam. */
export function configureGroupAccessStore(dir?: string): void {
  stateDir = dir ?? getStateDir();
  cache = undefined;
}

function groupEntry(chatId: number): z.infer<typeof groupSchema> {
  const key = String(chatId);
  const existing = store().groups[key];
  if (existing) return existing;
  const created = { allow: {}, deny: {} };
  store().groups[key] = created;
  return created;
}

/**
 * The role `userId` holds in `chatId`.
 *
 * An explicit deny outranks an explicit allow: `/deny` has to be able to take
 * back a `/allow` under either default, and the losing entry is dropped by the
 * writers below, so the two maps never actually disagree about a live user.
 *
 * The global roster is consulted before the default, which is what makes the
 * two access layers compose: admitting someone with `/allow` in a DM makes
 * them a contributor in every group without a per-group grant.
 */
export function resolveRole(chatId: number, userId: number): AccessRole {
  if (isAdmin(userId)) return 'admin';

  const group = store().groups[String(chatId)];
  const id = String(userId);
  if (group?.deny[id]) return 'spectator';
  if (group?.allow[id]) return 'contributor';
  if (isAllowedUser(userId)) return 'contributor';

  return config.GROUP_MEMBERS_DEFAULT === 'contributor' ? 'contributor' : 'spectator';
}

/** Promote `userId` to contributor in `chatId`. Returns their role beforehand. */
export function grantAccess(
  chatId: number,
  userId: number,
  meta: { username?: string; grantedBy?: number } = {},
): AccessRole {
  const previous = resolveRole(chatId, userId);
  const group = groupEntry(chatId);
  const id = String(userId);

  delete group.deny[id];
  group.allow[id] = {
    ...(meta.username ? { username: meta.username } : {}),
    ...(meta.grantedBy !== undefined ? { grantedBy: meta.grantedBy } : {}),
    grantedAt: new Date().toISOString(),
  };
  save();

  return previous;
}

/** Demote `userId` to spectator in `chatId`. Returns their role beforehand. */
export function revokeAccess(
  chatId: number,
  userId: number,
  meta: { username?: string; grantedBy?: number } = {},
): AccessRole {
  const previous = resolveRole(chatId, userId);
  const group = groupEntry(chatId);
  const id = String(userId);

  delete group.allow[id];
  group.deny[id] = {
    ...(meta.username ? { username: meta.username } : {}),
    ...(meta.grantedBy !== undefined ? { grantedBy: meta.grantedBy } : {}),
    grantedAt: new Date().toISOString(),
  };
  save();

  return previous;
}

export interface ListedMember extends AccessEntry {
  userId: number;
}

/** The explicit grants and denials recorded for `chatId`. */
export function listGroupAccess(chatId: number): { allow: ListedMember[]; deny: ListedMember[] } {
  const group = store().groups[String(chatId)];
  const toList = (map: Record<string, AccessEntry> | undefined): ListedMember[] =>
    Object.entries(map ?? {})
      .map(([id, entry]) => ({ userId: Number(id), ...entry }))
      .sort((a, b) => a.userId - b.userId);

  return { allow: toList(group?.allow), deny: toList(group?.deny) };
}

/** Whether an ungranted member of an allow-listed group may prompt the agent. */
export function groupDefaultIsContributor(): boolean {
  return config.GROUP_MEMBERS_DEFAULT === 'contributor';
}
