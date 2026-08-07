/**
 * The "is there a project to work in?" preamble every handler needs.
 *
 * This existed in eleven hand-written copies — three in the photo handler, one
 * in voice, six across the command handlers and one in the message domain —
 * with the message text drifting between two wordings along the way. Handlers
 * import it from here so a change to the wording, or to what counts as a
 * usable session, lands everywhere at once.
 */

import { Context } from 'grammy';
import * as path from 'path';
import { sessionManager, type Session } from '../../claude/session-manager.js';
import { escapeMarkdownV2 as esc } from '../../telegram/markdown.js';

/** Shown when a handler needs a working directory and no session supplies one. */
export const NO_PROJECT_MESSAGE =
  '⚠️ No project set\\.\n\nIf the bot restarted, use `/continue` or `/resume` to restore your last session\\.\nOr use `/project` to open a project first\\.';

/**
 * Require a session that is already live in memory.
 *
 * For commands that inspect or act on the current session but shouldn't
 * silently revive a dead one — if the bot restarted, the user is told to
 * /continue rather than having a session rehydrated underneath them.
 * Returns null after replying, so callers just early-return.
 */
export async function requireActiveSession(ctx: Context, sessionKey: string): Promise<Session | null> {
  const session = sessionManager.getSession(sessionKey);
  if (!session) {
    await ctx.reply(NO_PROJECT_MESSAGE, { parse_mode: 'MarkdownV2' });
    return null;
  }
  return session;
}

/**
 * Require a session, restoring from disk if the bot restarted since the last
 * message.
 *
 * For the paths where the user is mid-conversation — a typed message, a photo,
 * a voice note — and a restart shouldn't be their problem. Announces the
 * restore so the recovered context isn't invisible. Returns null after
 * replying, so callers just early-return.
 */
export async function requireSession(ctx: Context, sessionKey: string): Promise<Session | null> {
  const { session, restored } = sessionManager.getOrRestoreSession(sessionKey);
  if (!session) {
    await ctx.reply(NO_PROJECT_MESSAGE, { parse_mode: 'MarkdownV2' });
    return null;
  }
  if (restored) {
    await ctx.reply(
      `↩️ Resumed previous session: *${esc(path.basename(session.workingDirectory))}*`,
      { parse_mode: 'MarkdownV2' },
    );
  }
  return session;
}
