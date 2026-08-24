import type { Context } from 'grammy';
import { config } from '../config.js';
import { createPendingQuestion } from './ask-user.js';
import { parseSessionKey } from '../utils/session-key.js';
import { legacyEnv } from '../utils/legacy-env.js';
import { getAdminIds, hasGuestUsers } from '../utils/admins.js';
import { checkToolScope, isScopeGuardEnabled } from './scope-guard.js';
import { sessionManager } from './session-manager.js';
import { EntityText, clip } from '../telegram/entities.js';
import { resolveAdminsInChat, appendApproverLine } from '../telegram/admin-mention.js';

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
 * it matter beyond the patterns. It is answerable only by an admin, because a
 * confirmation the requester can tap themselves confirms nothing. And it
 * mentions those admins by id, because the group it lands in is muted and an
 * unnoticed prompt is a denied prompt ten minutes later.
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
  const admins = await resolveAdminsInChat(ctx.api, chatId);
  // Restrict the buttons to the *configured* roster, not the subset that
  // resolved to a display name. A prompt nobody can answer is safer than one
  // the requester can answer, and the timeout still ends it either way.
  const responderIds = getAdminIds();

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
    admins,
    timeoutMinutes: Math.round(timeoutMs / 60000),
  });

  const threadOpts = threadId !== undefined ? { message_thread_id: threadId } : {};

  try {
    await ctx.api.sendMessage(chatId, text, {
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
      await ctx.api.sendMessage(chatId, text, {
        reply_markup: { inline_keyboard: keyboard },
        ...threadOpts,
      });
    } catch (err2) {
      console.error('[PermissionGate] failed to send prompt:', err2 instanceof Error ? err2.message : err2);
      return { block: true, reason: `Failed to send approval prompt to user. Denied: ${pattern.reason}` };
    }
  }

  const answer = await promise;
  if (!answer || answer.index === 1) {
    return {
      block: true,
      reason: answer === null
        ? `No admin approved within ${Math.round(timeoutMs / 60000)} minutes. Denied: ${pattern.reason}`
        : `An admin denied: ${pattern.reason}`,
    };
  }
  return { block: false, reason: '' };
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
  admins: { id: number; name: string }[];
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

  appendApproverLine(b, parts.admins);
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
