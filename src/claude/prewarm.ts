/**
 * Starting a chat's claude before its first message.
 *
 * Claude Code takes a few seconds to come up, longer when it replays a
 * resumed conversation, and a chat used to pay that on the first message
 * after picking a project. But the pick is the tell: /project, /clear and
 * /resume all end with a conversation chosen and no claude running, and the
 * next thing the chat does is almost always a prompt. So the claude is started
 * then, and the prompt finds it waiting — or, sent quickly, waits out only
 * what is left of the startup.
 *
 * It is a guess, so it costs nobody anything when wrong: no question is asked
 * and nothing is reaped to make room for it (memory-guard.ts), a failure is a
 * log line, and a claude nobody ends up using goes the way of any idle one
 * (pty-idle-reaper.ts). Claude Code writes no transcript before its first
 * prompt, so an unused one leaves nothing behind either.
 */

import type { Context } from 'grammy';
import { config } from '../config.js';
import { getPtyProvider } from '../providers/claude-provider.js';
import { getActiveProviderName } from '../providers/provider-router.js';
import { ensureCcrRunning } from '../providers/ccr-health.js';
import { getCcrShimPath } from './ccr-shim.js';
import { allowPrewarm } from './memory-guard.js';
import { isProcessing } from './request-queue.js';
import { sessionManager } from './session-manager.js';
import { sanitizeError } from '../utils/sanitize.js';

/**
 * Start `sessionKey`'s claude in the background if it has a project and no
 * claude yet. Call it last, once the handler has settled which conversation
 * the chat is in: the claude is spawned for the session as it stands. Never
 * throws and never waits; resolves to whether a claude was started.
 */
export async function prewarmClaude(ctx: Context | undefined, sessionKey: string): Promise<boolean> {
  try {
    if (!config.PREWARM_CLAUDE) return false;
    if (!sessionManager.getSession(sessionKey)) return false;
    const pty = getPtyProvider();
    // A turn in flight starts its own, with its own callbacks.
    if (pty.hasLiveSession(sessionKey) || isProcessing(sessionKey)) return false;

    // The backend the first message will run on, or that message respawns it.
    const providerName = getActiveProviderName(sessionKey);
    let executableOverride: string | undefined;
    if (providerName === 'ccr') {
      const ccr = await ensureCcrRunning();
      if (ccr.status !== 'ok' && ccr.status !== 'started') return false;
      executableOverride = getCcrShimPath();
      // That took a moment; a message may have got there first.
      if (pty.hasLiveSession(sessionKey) || isProcessing(sessionKey)) return false;
    }

    if (!allowPrewarm(sessionKey)) {
      console.log(`[Prewarm] ${sessionKey}: memory is short, leaving claude for the first message to start`);
      return false;
    }
    return pty.prewarm(sessionKey, {
      providerName,
      ...(executableOverride ? { executableOverride } : {}),
      ...(ctx ? { telegramCtx: ctx } : {}),
    });
  } catch (err) {
    console.warn(`[Prewarm] ${sessionKey}: couldn't start claude early: ${sanitizeError(err)}`);
    return false;
  }
}
