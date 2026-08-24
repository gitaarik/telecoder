/**
 * Holding a guest's message until an admin has looked at it.
 *
 * The permission gate stops a *tool call* that is already underway. This stops
 * the message that would start one — before the agent reads it, before it
 * touches a file, and while the request is still a sentence a person can read
 * and judge. That is the difference between supervising a machine and reviewing
 * a diff after the fact.
 *
 * Two things ask for a hold: the charter judge (src/claude/charter-judge.ts),
 * which reads the message, and nothing else yet. It lives in its own module
 * because the approval UI is shared with the gate and neither should own the
 * other.
 */

import type { Context } from 'grammy';
import { config } from '../config.js';
import { createPendingQuestion } from './ask-user.js';
import { parseSessionKey } from '../utils/session-key.js';
import { getAdminIds, isAdmin } from '../utils/admins.js';
import { EntityText, clip } from '../telegram/entities.js';
import { resolveAdminsInChat, appendApproverLine } from '../telegram/admin-mention.js';
import { isCharterJudgeEnabled, judgeMessage } from './charter-judge.js';

/** Longest excerpt of the held message we quote back into the prompt. */
const MAX_QUOTE_CHARS = 500;

export interface HoldOutcome {
  /** True when the message may proceed to the agent. */
  proceed: boolean;
  /** What to tell the chat when it may not. Empty when it may. */
  message: string;
}

const PROCEED: HoldOutcome = { proceed: true, message: '' };

function holdTimeoutMs(): number {
  const minutes = config.PERMISSION_PROMPT_TIMEOUT_MINUTES;
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 10) * 60 * 1000;
}

/**
 * Run a guest's message past the charter judge, and hold it for an admin if the
 * judge flags it.
 *
 * Admins skip the judge: a message that would only ever be held for the person
 * who sent it costs a Haiku call and a button tap to arrive back where it
 * started. Everything else — the scope guard and the destructive-pattern gate —
 * still applies to them, because those catch what a turn *does* rather than
 * what it was asked to do.
 */
export async function screenPrompt(
  ctx: Context | undefined,
  sessionKey: string,
  message: string,
): Promise<HoldOutcome> {
  if (!isCharterJudgeEnabled()) return PROCEED;
  if (!ctx?.chat?.id) return PROCEED;
  if (isAdmin(ctx.from?.id)) return PROCEED;

  const verdict = await judgeMessage(message);
  if (!verdict.hold) return PROCEED;

  console.log(`[PromptHold] held session:${sessionKey} user:${ctx.from?.id ?? '?'} — ${verdict.reason}`);
  return askAdmins(ctx, sessionKey, message, verdict.reason);
}

/**
 * Post the approval prompt and wait. Returns once an admin decides, or once the
 * timeout does it for them.
 */
async function askAdmins(
  ctx: Context,
  sessionKey: string,
  message: string,
  reason: string,
): Promise<HoldOutcome> {
  const { chatId, threadId } = parseSessionKey(sessionKey);
  const admins = await resolveAdminsInChat(ctx.api, chatId);
  const timeoutMs = holdTimeoutMs();

  const optionLabels = ['✅ Let it run', '❌ Block'];
  const { id, promise } = createPendingQuestion(optionLabels, timeoutMs, sessionKey, getAdminIds());

  const requester = describeRequester(ctx);
  const { text, entities } = buildHoldMessage({
    reason,
    requester,
    message,
    admins,
    timeoutMinutes: Math.round(timeoutMs / 60000),
  });

  const threadOpts = threadId !== undefined ? { message_thread_id: threadId } : {};
  const keyboard = optionLabels.map((label, idx) => [{ text: label, callback_data: `q:${id}:${idx}` }]);

  try {
    await ctx.api.sendMessage(chatId, text, {
      entities,
      reply_markup: { inline_keyboard: keyboard },
      ...threadOpts,
    });
  } catch (err) {
    console.error('[PromptHold] failed to post hold prompt:', err instanceof Error ? err.message : err);
    // Nobody can approve a prompt that was never delivered. Blocking is the
    // only honest outcome, and the reason says why.
    return {
      proceed: false,
      message: '🚧 This message was held for an admin, but the approval prompt could not be posted. Nothing ran.',
    };
  }

  const answer = await promise;
  if (!answer || answer.index === 1) {
    return {
      proceed: false,
      message: answer === null
        ? `🚧 Held for an admin — ${reason}. No admin answered in ${Math.round(timeoutMs / 60000)} min, so nothing ran.`
        : `🚧 An admin blocked this one — ${reason}. Nothing ran.`,
    };
  }
  return PROCEED;
}

interface HoldParts {
  reason: string;
  requester: string | undefined;
  message: string;
  admins: { id: number; name: string }[];
  timeoutMinutes: number;
}

/** Lay out the hold prompt. Exported for tests — the wording is the product. */
export function buildHoldMessage(parts: HoldParts): ReturnType<EntityText['build']> {
  const b = new EntityText();

  b.add('🚧 ').bold('Held for an admin').add(` — ${parts.reason}`).newline();
  if (parts.requester) b.add('Asked by ').bold(parts.requester).newline();
  b.newline();

  b.pre(clip(parts.message.trim(), MAX_QUOTE_CHARS));
  b.newline();

  appendApproverLine(b, parts.admins);
  b.newline().italic(`Nothing runs until then. Times out in ${parts.timeoutMinutes} min → blocked.`);

  return b.build();
}

function describeRequester(ctx: Context): string | undefined {
  const from = ctx.from;
  if (!from) return undefined;
  return [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || undefined;
}
