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
 * The people who may answer an approval prompt but do not own the bot.
 *
 * This exists because "can approve" and "can restart the bot" were one flag,
 * and on a bot shared with several people that forces a choice between one
 * owner being the bottleneck for every prompt and handing guests the controls
 * — including `/method` and `/permissionmode`, either of which switches the
 * gate off. An approver is a guest in every other respect: the charter judge
 * still reads their messages, the gate still stops their tool calls, and the
 * lifecycle commands still refuse them.
 *
 * Empty when `ADMIN_USER_IDS` is unset, because then every allowed user is
 * already an admin and there is nothing to widen. Ids the admin roster already
 * carries are dropped rather than counted twice.
 */
export function getApproverIds(): number[] {
  // config.ts refuses to start on approvers-without-admins, so this is a
  // belt-and-braces restatement of the invariant rather than a reachable path.
  if (config.ADMIN_USER_IDS.length === 0) return [];
  const admins = getAdminIds();
  return config.APPROVER_USER_IDS.filter(
    (id) => id !== GROUP_ANONYMOUS_BOT_ID && !admins.includes(id)
  );
}

/**
 * Approver ids that no allow-list carries — neither `ALLOWED_USER_IDS` nor the
 * roster `/allow` writes to. Those can never act, so they are always a typo.
 *
 * This lives here rather than beside the matching `ADMIN_USER_IDS` check in
 * config.ts because it has to read the runtime roster, and user-roster.ts
 * imports config.ts. The env-only version of this check was wrong in exactly
 * the case the tier exists for: a friend admitted from chat with `/allow` is
 * never in `ALLOWED_USER_IDS`, so promoting them would have refused to start
 * the bot — and the message would have told them to widen a list that had
 * nothing to do with it.
 *
 * Reported at startup rather than enforced here: the roster moves while the
 * bot runs, and an approver who is later `/deny`'d should stop being able to
 * act, not take the process down with them.
 */
export function findOrphanedApprovers(): number[] {
  if (config.APPROVER_USER_IDS.length === 0) return [];
  const reachable = new Set(allAllowedUserIds());
  return config.APPROVER_USER_IDS.filter((id) => !reachable.has(id));
}

/** True when this user may answer someone else's approval prompt. */
export function isApprover(userId: number | undefined): boolean {
  if (userId === undefined) return false;
  return getApproverIds().includes(userId);
}

/**
 * Who may answer a prompt raised by `requesterId`.
 *
 * Approvers are filtered against the requester: tapping "allow" on your own
 * request confirms nothing, and a tier that let you do it would be a speed
 * bump rather than supervision. Admins are not filtered, because an admin
 * approving their own `sudo` is the owner of the machine agreeing with
 * themselves — which is what a solo bot has always done.
 *
 * Never empty: `getAdminIds()` falls back to the whole allow-list.
 */
export function getPromptResponderIds(requesterId: number | undefined): number[] {
  const admins = getAdminIds();
  const approvers = getApproverIds().filter((id) => id !== requesterId);
  return [...admins, ...approvers];
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
