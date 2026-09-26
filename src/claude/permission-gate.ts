import type { Context } from 'grammy';
import type { Message, MessageEntity } from 'grammy/types';
import { config } from '../config.js';
import { closeExpiredQuestion, createPendingQuestion } from './ask-user.js';
import { parseSessionKey } from '../utils/session-key.js';
import { legacyEnv } from '../utils/legacy-env.js';
import { getPromptResponderIds, hasGuestUsers } from '../utils/admins.js';
import { checkToolScope, isScopeGuardEnabled } from './scope-guard.js';
import { sessionManager } from './session-manager.js';
import { EntityText, clip } from '../telegram/entities.js';
import { resolveApproversInChat, appendApproverLine } from '../telegram/admin-mention.js';
import { consumeAutoApproval, formatRemaining, type AutoApproveWindow } from './auto-approve.js';

/**
 * Pattern-based permission gate for PreToolUse. When enabled, certain tool calls
 * (destructive bash patterns, force-pushes, DROP TABLE, etc.) trigger a Telegram
 * approval prompt before executing. On approve, the hook returns ok and claude
 * proceeds; on deny or timeout, the hook returns a deny marker (consumed by the
 * shell wrapper in pty-provider.ts) and claude sees a tool-blocked error.
 *
 * Soft by design: hooks can't override --disallowedTools deny rules, and the
 * patterns list is intentionally conservative — false positives are worse here
 * than false negatives because every prompt costs someone a button tap.
 *
 * On a shared bot the prompt is the supervision mechanism, so two things about
 * it matter beyond the patterns. It goes to the admins, plus any approver who
 * is not the person who raised it — a confirmation a *guest* can tap
 * themselves confirms nothing, while an admin approving their own `sudo` is
 * the owner of the machine agreeing with themselves, which is what a solo bot
 * has always done. And it mentions them by id, because the group it lands in
 * is muted and an unnoticed prompt is a denied prompt ten minutes later.
 */

export const DENY_MARKER_START = '__TELECODER_DENY__';
export const DENY_MARKER_END = '__END__';

function promptTimeoutMs(): number {
  const minutes = config.PERMISSION_PROMPT_TIMEOUT_MINUTES;
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 10) * 60 * 1000;
}

/** Longest command text we paste into the prompt before clipping. */
const MAX_COMMAND_CHARS = 400;

// Patterns that always prompt regardless of tool. Conservative — only the
// obviously destructive cases. Bash with sudo is included because it's almost
// always interactive on a desktop and shouldn't silently run on a server.
const DANGEROUS_BASH_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i, reason: 'rm -rf' },
  { re: /\bsudo\b/i, reason: 'sudo' },
  { re: /\bgit\s+push\s+(--force\b|-f\b)/i, reason: 'git push --force' },
  { re: /\bgit\s+reset\s+--hard\b/i, reason: 'git reset --hard' },
  { re: /\bgit\s+clean\s+-[a-z]*f/i, reason: 'git clean -f' },
  { re: /\bgit\s+branch\s+-D\b/i, reason: 'git branch -D (force delete)' },
  { re: /\bDROP\s+TABLE\b/i, reason: 'DROP TABLE' },
  { re: /\bDROP\s+DATABASE\b/i, reason: 'DROP DATABASE' },
  { re: /\bTRUNCATE\s+TABLE\b/i, reason: 'TRUNCATE TABLE' },
  { re: /\bterraform\s+destroy\b/i, reason: 'terraform destroy' },
  { re: /\bmkfs\b|\bdd\s+.*\bof=\/dev\//i, reason: 'destructive disk op' },
];

export interface GateDecision {
  /** True if the tool should be blocked. */
  block: boolean;
  /** Reason fed back to claude on block. */
  reason: string;
}

export interface GateRequest {
  sessionKey: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  telegramCtx?: Context | undefined;
}

/**
 * On when TELECODER_PERMISSION_PROMPTS is "1", off when it is "0", and — with
 * the var unset — on exactly when the bot has non-admin users.
 *
 * Sharing a bot with someone you intend to supervise and getting no prompts
 * because a separate variable was never set is the wrong failure. Set it to "0"
 * to share a bot without the gate; a solo bot has no guests, so its default is
 * unchanged.
 */
export function isPermissionGateEnabled(): boolean {
  const explicit = legacyEnv('PERMISSION_PROMPTS');
  if (explicit !== undefined && explicit !== '') return explicit === '1';
  return hasGuestUsers();
}

/** True when the gate is on because of guests rather than an explicit opt-in. */
export function isPermissionGateImplicit(): boolean {
  const explicit = legacyEnv('PERMISSION_PROMPTS');
  return (explicit === undefined || explicit === '') && hasGuestUsers();
}

/**
 * Inspect a tool call and decide whether it needs approval. If yes, prompts via
 * Telegram and waits for an admin's button tap, up to
 * PERMISSION_PROMPT_TIMEOUT_MINUTES. Returns the final decision.
 *
 * Tools that don't match any pattern auto-allow immediately — most of claude's
 * activity should pass through without anyone noticing.
 */
export async function evaluateToolCall(req: GateRequest): Promise<GateDecision> {
  if (!isPermissionGateEnabled()) {
    return { block: false, reason: '' };
  }

  const pattern =
    matchDangerousPattern(req.toolName, req.toolInput) ?? matchOutOfScope(req);
  if (!pattern) return { block: false, reason: '' };

  const ctx = req.telegramCtx;
  if (!ctx?.chat?.id) {
    // No ctx available — fail safe by blocking (so the gate's existence
    // actually means something when it's enabled).
    return {
      block: true,
      reason: `TeleCoder permission gate active but no Telegram context available to prompt user. Denied: ${pattern.reason}`,
    };
  }

  const { chatId, threadId } = parseSessionKey(req.sessionKey);

  // An open auto-approve window answers the prompt instead of posting it. The
  // line it posts in its place is the point: the window buys back the button
  // tap, not the record of what was allowed.
  const window = consumeAutoApproval(chatId, pattern.reason);
  if (window) {
    await announceAutoApproval(ctx, chatId, threadId, pattern.reason, req.toolInput, window);
    return { block: false, reason: '' };
  }

  // Admins, plus any approver who is not the person whose turn raised this.
  // Restrict the buttons to the *configured* roster, not the subset that
  // resolved to a display name. A prompt nobody can answer is safer than one
  // the requester can answer, and the timeout still ends it either way.
  const responderIds = getPromptResponderIds(ctx.from?.id);
  const responders = await resolveApproversInChat(ctx.api, chatId, responderIds);

  const optionLabels = ['✅ Allow once', '❌ Deny'];
  const timeoutMs = promptTimeoutMs();
  const { id, promise } = createPendingQuestion(
    optionLabels,
    timeoutMs,
    req.sessionKey,
    responderIds,
  );

  const keyboard = optionLabels.map((label, idx) => [{
    text: label,
    callback_data: `q:${id}:${idx}`,
  }]);

  const { text, entities } = buildPromptMessage({
    reason: pattern.reason,
    toolName: req.toolName,
    toolInput: req.toolInput,
    requester: describeRequester(ctx),
    responders,
    timeoutMinutes: Math.round(timeoutMs / 60000),
  });

  const threadOpts = threadId !== undefined ? { message_thread_id: threadId } : {};

  // Kept for closing the prompt if nobody answers it, with whichever entities
  // it actually went out with.
  let sent: Message.TextMessage;
  let sentEntities: MessageEntity[] | undefined = entities;
  try {
    sent = await ctx.api.sendMessage(chatId, text, {
      entities,
      reply_markup: { inline_keyboard: keyboard },
      ...threadOpts,
    });
  } catch (err) {
    // The text itself can't be malformed — it is sent verbatim with no parse
    // mode. What can fail is a text_mention for someone Telegram won't let us
    // name here, so retry once with the formatting dropped rather than losing
    // the prompt entirely.
    console.error('[PermissionGate] entity send failed, retrying plain:', err instanceof Error ? err.message : err);
    try {
      sent = await ctx.api.sendMessage(chatId, text, {
        reply_markup: { inline_keyboard: keyboard },
        ...threadOpts,
      });
      sentEntities = undefined;
    } catch (err2) {
      console.error('[PermissionGate] failed to send prompt:', err2 instanceof Error ? err2.message : err2);
      return { block: true, reason: `Failed to send approval prompt to user. Denied: ${pattern.reason}` };
    }
  }

  const answer = await promise;
  if (answer === null) {
    await closeExpiredQuestion(
      ctx.api, sent, text,
      `No answer within ${Math.round(timeoutMs / 60000)} min, so it was denied.`,
      sentEntities,
    );
  }
  if (!answer || answer.index === 1) {
    return {
      block: true,
      reason: answer === null
        ? `Nobody approved within ${Math.round(timeoutMs / 60000)} minutes. Denied: ${pattern.reason}`
        : `An approver denied: ${pattern.reason}`,
    };
  }
  return { block: false, reason: '' };
}

/**
 * Post the line that stands in for the prompt a window just answered.
 *
 * Best-effort: an auto-approval that could not be announced is still an
 * auto-approval, and failing the tool call because Telegram was unreachable
 * would be a worse outcome than a gap in the chat log. The console keeps it
 * either way.
 */
async function announceAutoApproval(
  ctx: Context,
  chatId: number,
  threadId: number | undefined,
  reason: string,
  toolInput: Record<string, unknown>,
  window: AutoApproveWindow,
): Promise<void> {
  console.log(
    `[PermissionGate] auto-approved chat:${chatId} reason:${reason} `
    + `(#${window.approved} of window opened by ${window.openedBy})`,
  );

  const b = new EntityText();
  b.add('\u26a1 ').bold('Auto-approved').add(` \u2014 ${reason}`).newline();

  const command = commandOf(toolInput);
  if (command !== undefined) {
    b.pre(clip(command, MAX_COMMAND_CHARS), 'bash');
  } else {
    b.pre(clip(JSON.stringify(toolInput), MAX_COMMAND_CHARS), 'json');
  }

  b.italic(
    `#${window.approved} in ${window.openedByName}'s window \u2014 ${formatRemaining(window)} left. `
    + '/autoapprove off ends it.',
  );

  const { text, entities } = b.build();
  const threadOpts = threadId !== undefined ? { message_thread_id: threadId } : {};
  try {
    await ctx.api.sendMessage(chatId, text, { entities, ...threadOpts });
  } catch (err) {
    console.error('[PermissionGate] auto-approval notice failed:', err instanceof Error ? err.message : err);
  }
}

/** How the prompt refers to whoever's turn triggered it. */
function describeRequester(ctx: Context): string | undefined {
  const from = ctx.from;
  if (!from) return undefined;
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username;
  return name || undefined;
}

interface PromptParts {
  reason: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  requester: string | undefined;
  /** Admins plus the approvers eligible for this prompt, as resolved names. */
  responders: { id: number; name: string }[];
  timeoutMinutes: number;
}

/**
 * Lay out the approval prompt. Exported for tests — the wording and the
 * offsets are the whole product here, and both are worth pinning down.
 */
export function buildPromptMessage(parts: PromptParts): { text: string; entities: ReturnType<EntityText['build']>['entities'] } {
  const b = new EntityText();

  b.add('🔐 ').bold('Permission requested').add(` — ${parts.reason}`).newline();

  if (parts.requester) {
    b.add('Asked by ').bold(parts.requester).newline();
  }

  b.add('Tool: ').code(parts.toolName).newline(2);

  const command = commandOf(parts.toolInput);
  if (command !== undefined) {
    const description = typeof parts.toolInput.description === 'string' ? parts.toolInput.description.trim() : '';
    if (description) b.italic(clip(description, 200)).newline();
    b.pre(clip(command, MAX_COMMAND_CHARS), 'bash');
  } else {
    b.pre(clip(JSON.stringify(parts.toolInput), MAX_COMMAND_CHARS), 'json');
  }
  b.newline();

  appendApproverLine(b, parts.responders);
  b.newline().italic(`Times out in ${parts.timeoutMinutes} min → denied.`);

  return b.build();
}

/** The command string for tools that run one, or undefined for everything else. */
function commandOf(toolInput: Record<string, unknown>): string | undefined {
  const command = toolInput.command;
  return typeof command === 'string' ? command : undefined;
}

/**
 * Second class of guarded call: one that reaches outside the shared projects.
 *
 * Runs after the destructive-pattern check so a `sudo` inside the workspace
 * still reports as `sudo` rather than as a scope excursion — the more specific
 * reason is the more useful one to show.
 */
function matchOutOfScope(req: GateRequest): { reason: string } | null {
  // The gate is already known to be on — evaluateToolCall returns before this
  // when it isn't — so 'auto' resolves to on unless SCOPE_GUARD says otherwise.
  if (!isScopeGuardEnabled(true)) return null;

  const cwd = sessionManager.getSession(req.sessionKey)?.workingDirectory;
  if (!cwd) return null;

  const verdict = checkToolScope(req.toolName, req.toolInput, cwd);
  if (!verdict.outOfScope) return null;
  return { reason: `${verdict.reason} — ${verdict.offender}` };
}

function matchDangerousPattern(toolName: string, toolInput: Record<string, unknown>): { reason: string } | null {
  if (toolName === 'Bash') {
    const cmd = String(toolInput.command ?? '');
    for (const p of DANGEROUS_BASH_PATTERNS) {
      if (p.re.test(cmd)) return { reason: p.reason };
    }
  }
  return null;
}

/** List the dangerous patterns surfaced via /permissions. */
export function listDangerousPatterns(): { reason: string; example: string }[] {
  return DANGEROUS_BASH_PATTERNS.map((p) => ({
    reason: p.reason,
    example: p.re.toString(),
  }));
}
