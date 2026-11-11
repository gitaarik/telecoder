/**
 * CCR throttle state and the "switch & retry" prompt.
 *
 * Deliberately holds no reference to the turn runner: the retry *callback*
 * lives in turn-runner.ts alongside the other turn entry points, so this
 * module stays a leaf that the runner can import without a cycle.
 */

import { Context } from 'grammy';
import type { ThrottleInfo } from '../../../providers/types.js';
import { config } from '../../../config.js';
import { EntityText } from '../../../telegram/entities.js';
import { replyFormatted } from '../../../telegram/send.js';

// Last user prompt that hit a throttle, keyed by sessionKey. Used by the
// "Switch & Retry" callback so the bot can replay the prompt under CCR
// without the user having to retype it. Cleared on consumption or on a
// new successful query.
export const lastThrottledPrompt = new Map<string, string>();

export function formatResetIn(resetAt?: number): string {
  if (!resetAt) return '';
  const ms = resetAt - Date.now();
  if (ms <= 0) return '';
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return ` Resets in ~${mins} min.`;
  const hours = Math.floor(mins / 60);
  const remainder = mins % 60;
  return ` Resets in ~${hours}h${remainder ? ` ${remainder}m` : ''}.`;
}

export async function postThrottlePrompt(
  ctx: Context,
  sessionKey: string,
  message: string,
  throttle: ThrottleInfo,
): Promise<void> {
  if (!config.CCR_ENABLED || !config.CCR_AUTO_PROMPT_ON_THROTTLE) return;

  lastThrottledPrompt.set(sessionKey, message);

  const resetTxt = formatResetIn(throttle.resetAt);
  await replyFormatted(
    ctx,
    new EntityText()
      .add('⚠️ ').bold('Max usage limit reached.').add(resetTxt).newline(2)
      .add('Route your message through Claude Code Router (CCR) instead?').newline()
      .italic('The switch is sticky — use /ccr to flip back.')
      .build(),
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🔌 Switch to CCR & retry', callback_data: 'ccr_throttle:switch' },
            { text: 'Cancel', callback_data: 'ccr_throttle:cancel' },
          ],
        ],
      },
    },
  );
}
