/**
 * Cold-start auto-continue.
 *
 * Unlike auto-resume this runs on every startup, marker or not, and it never
 * says a word: a restart shouldn't change which conversation a chat is in, so
 * every chat used within the restore window carries straight on where it left
 * off. Whoever wants a clean slate sends /clear. Auto-resume only covers
 * sessions idle under an hour, and only after /rebuildbot or /restartbot —
 * this is what brings back everything else.
 */

import { sessionManager, RESTORE_MAX_IDLE_MS } from '../claude/session-manager.js';
import { sessionHistory } from '../claude/session-history.js';
import { parseSessionKey } from '../utils/session-key.js';
import { allowedChatIds } from './shared.js';

/**
 * Cold-start auto-continue. For every chat with a prior session belonging to
 * this instance:
 *   - idle ≤ 7d          → silently restore in memory (no chat noise)
 *   - idle > 7d          → skip (user can /continue manually)
 *
 * Sessions already live in memory are skipped — that covers both the ones
 * autoResumeAfterReload just restored (they got the fuller "Reloaded and
 * session restored" recap) and the ones notifyInterruptedSessions revived.
 */
export function autoContinueOnStartup(): void {
  const activeSessions = sessionHistory.getAllActiveSessions();
  const allowedIds = allowedChatIds();

  let restored = 0;
  const skipped: Record<string, number> = { notAllowed: 0, alreadyLive: 0, noClaudeSessionId: 0, tooOld: 0, threw: 0 };

  for (const [sessionKey, entry] of activeSessions) {
    const { chatId } = parseSessionKey(sessionKey);

    if (!allowedIds.has(chatId)) {
      skipped.notAllowed++;
      continue;
    }
    if (sessionManager.getSession(sessionKey)) {
      skipped.alreadyLive++;
      continue;
    }
    // Nothing said in it yet: the chat's next message brings the project back
    // on its own, through the same restore window.
    if (!entry.claudeSessionId) {
      skipped.noClaudeSessionId++;
      continue;
    }

    const idleMs = Date.now() - new Date(entry.lastActivity).getTime();
    if (idleMs < 0 || idleMs > RESTORE_MAX_IDLE_MS) {
      skipped.tooOld++;
      continue;
    }

    try {
      sessionManager.resumeLastSession(sessionKey);
      restored++;
    } catch (err) {
      console.error(`[AutoContinue] Restore failed for ${sessionKey}:`, err);
      skipped.threw++;
    }
  }

  const skipSummary = Object.entries(skipped)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}=${n}`)
    .join(', ');
  console.log(
    `[AutoContinue] restored=${restored}, total=${activeSessions.size}` +
    (skipSummary ? `, skipped(${skipSummary})` : '')
  );
}
