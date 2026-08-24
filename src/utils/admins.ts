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

let warned = false;

/**
 * Warn once about admin ids that can never actually act, because the auth
 * middleware turns them away before any admin check runs. Deliberately a
 * warning rather than an implicit widening of `ALLOWED_USER_IDS`: an id that
 * grants access should be visible in the variable that documents access.
 */
function warnAboutUnreachableAdmins(): void {
  if (warned) return;
  warned = true;
  const unreachable = config.ADMIN_USER_IDS.filter((id) => !config.ALLOWED_USER_IDS.includes(id));
  if (unreachable.length > 0) {
    console.warn(
      `[admins] ADMIN_USER_IDS contains ${unreachable.join(', ')}, which ${unreachable.length === 1 ? 'is' : 'are'} ` +
      'not in ALLOWED_USER_IDS — the auth middleware rejects them before any admin check runs. ' +
      'Add them to ALLOWED_USER_IDS too.',
    );
  }
}

/**
 * The effective admin roster. Falls back to the full allow-list when
 * `ADMIN_USER_IDS` is unset, which is what keeps existing installs unchanged.
 */
export function getAdminIds(): number[] {
  warnAboutUnreachableAdmins();
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
 */
export function hasGuestUsers(): boolean {
  const admins = getAdminIds();
  return config.ALLOWED_USER_IDS.some((id) => !admins.includes(id));
}

/** The allowed users who are not admins. Used by `/permissions` to report the split. */
export function getGuestIds(): number[] {
  const admins = getAdminIds();
  return config.ALLOWED_USER_IDS.filter((id) => !admins.includes(id));
}

/** Test seam — production never needs to re-arm the warning. */
export function resetAdminWarnings(): void {
  warned = false;
}
