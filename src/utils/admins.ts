/**
 * Who counts as an admin of this bot instance.
 *
 * TeleCoder's original access model is one flat list: every id in
 * `ALLOWED_USER_IDS` can do everything. That is the right model for a bot with
 * one user, and it stops being right the moment the bot is shared. An approval
 * prompt the person who triggered it can tap themselves is not an approval, and
 * a guest who can `/restartbot` or flip the transport can step around every
 * guardrail the owner configured.
 *
 * `ADMIN_USER_IDS` names the subset that keeps those unrestricted rights. Left
 * unset it resolves to *every* allowed user, so a single-user install behaves
 * exactly as it did before this module existed and nobody has to migrate.
 *
 * Admin-ness is deliberately not inferred from Telegram's own group-admin
 * status: who may promote someone in a Telegram group is a different question
 * from who may approve a `sudo` on the machine the bot runs on.
 */

import { config } from '../config.js';
import { allAllowedUserIds } from './user-roster.js';

/**
 * Telegram's GroupAnonymousBot id — the sender id on messages posted
 * anonymously by a group admin. Shared with the auth middleware, which lets it
 * through in allow-listed groups.
 *
 * It is never an admin here. Any Telegram group admin can post anonymously, so
 * honouring it would hand bot-admin rights to whoever holds group-admin rights
 * — a promotion the bot owner may not have intended to be the same thing.
 */
export const GROUP_ANONYMOUS_BOT_ID = 1087968824;

/**
 * The effective admin roster. Falls back to the full allow-list when
 * `ADMIN_USER_IDS` is unset, which is what keeps existing installs unchanged.
 *
 * An id here that `ALLOWED_USER_IDS` does not also carry can never act — the
 * auth middleware turns it away before any admin check runs — so config.ts
 * refuses to start on one rather than leaving it to surface later, as an
 * approval prompt that silently went to the wrong person.
 */
export function getAdminIds(): number[] {
  if (config.ADMIN_USER_IDS.length === 0) return [...config.ALLOWED_USER_IDS];
  return [...config.ADMIN_USER_IDS];
}

/** True when this user may approve prompts and run bot-lifecycle commands. */
export function isAdmin(userId: number | undefined): boolean {
  if (userId === undefined) return false;
  if (userId === GROUP_ANONYMOUS_BOT_ID) return false;
  return getAdminIds().includes(userId);
}

/**
 * True when at least one allowed user is not an admin — i.e. the bot is shared
 * with someone who is meant to be supervised.
 *
 * This is the predicate the rest of the codebase should branch on rather than
 * "is ADMIN_USER_IDS set": a roster that happens to list everybody restricts
 * nobody, and should not switch on supervision UI or change any default.
 *
 * It reads the *effective* allow-list, `.env` plus everyone `/allow` has
 * admitted since — this is what turns the permission gate, the scope guard and
 * the charter judge on, and admitting a guest from chat has to switch on the
 * supervision meant for guests. Reading only `.env` here would leave a bot that
 * had just gained its first guest running with every guardrail off.
 */
export function hasGuestUsers(): boolean {
  const admins = getAdminIds();
  return allAllowedUserIds().some((id) => !admins.includes(id));
}

/** The allowed users who are not admins. Used by `/permissions` to report the split. */
export function getGuestIds(): number[] {
  const admins = getAdminIds();
  return allAllowedUserIds().filter((id) => !admins.includes(id));
}
