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
import { sessionHistory } from '../../claude/session-history.js';
import { EntityText, type EntityMessage } from '../../telegram/entities.js';
import { replyFormatted } from '../../telegram/send.js';
import { taskListDisplay } from '../../telegram/task-list.js';
import { homeProject } from '../../utils/home-project.js';

/** Shown when a handler needs a working directory and no session supplies one. */
export const NO_PROJECT_MESSAGE: EntityMessage = new EntityText()
  .add('⚠️ No project set.\n\nIf the bot restarted, use ').code('/continue').add(' or ').code('/resume')
  .add(' to restore your last session.\nOr use ').code('/project').add(' to open a project first.')
  .build();

/**
 * Where the chat is: the conversation it's on — or, when a restart dropped
 * that and nothing has brought it back, the one it left off in (`live` false).
 *
 * Only ever read. Drawing /tree or listing /prompts mustn't load a
 * conversation behind the chat's back: the next message would land in
 * whatever it loaded.
 */
export function whereChatIs(sessionKey: string): { projectPath: string; sessionId?: string; live: boolean } | undefined {
  const session = sessionManager.getSession(sessionKey);
  if (session) return { projectPath: session.workingDirectory, sessionId: session.claudeSessionId, live: true };
  const last = sessionHistory.getLastSession(sessionKey);
  return last ? { projectPath: last.projectPath, sessionId: last.claudeSessionId, live: false } : undefined;
}

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
    await replyFormatted(ctx, NO_PROJECT_MESSAGE);
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
 * restore so the recovered context isn't invisible. With nothing to restore, a
 * bot with a home project starts a fresh conversation there. Returns null
 * after replying, so callers just early-return.
 */
export async function requireSession(ctx: Context, sessionKey: string): Promise<Session | null> {
  const { session: restoredSession, restored } = sessionManager.getOrRestoreSession(sessionKey);
  // A bot made for one project starts there instead of asking for /project.
  const home = restoredSession ? undefined : homeProject();
  const session = restoredSession ?? (home ? sessionManager.createSession(sessionKey, home) : undefined);
  if (!session) {
    await replyFormatted(ctx, NO_PROJECT_MESSAGE);
    return null;
  }
  if (restored) {
    await replyFormatted(
      ctx,
      new EntityText().add('↩️ Resumed previous session: ').bold(path.basename(session.workingDirectory)).build(),
    );
    await taskListDisplay.showRestored(ctx.api, sessionKey, session.claudeSessionId);
  }
  return session;
}
