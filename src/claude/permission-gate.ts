import type { Context } from 'grammy';
import { config } from '../config.js';
import { createPendingQuestion } from './ask-user.js';
import { parseSessionKey } from '../utils/session-key.js';
import { legacyEnv } from '../utils/legacy-env.js';

/**
 * Pattern-based permission gate for PreToolUse. When TELECODER_PERMISSION_PROMPTS
 * is enabled, certain tool calls (destructive bash patterns, force-pushes, DROP
 * TABLE, etc.) trigger a Telegram approval prompt before executing. On approve,
 * the hook returns ok and claude proceeds; on deny or timeout, the hook returns
 * a deny marker (consumed by the shell wrapper in pty-provider.ts) and claude
 * sees a tool-blocked error.
 *
 * Soft by design: hooks can't override --disallowedTools deny rules, and the
 * patterns list is intentionally conservative — false positives are worse here
 * than false negatives because every prompt costs the user a button tap.
 */

export const DENY_MARKER_START = '__TELECODER_DENY__';
export const DENY_MARKER_END = '__END__';

const PROMPT_TIMEOUT_MS = 10 * 60 * 1000;

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

/** Enabled when the env var is exactly "1". Default off. */
export function isPermissionGateEnabled(): boolean {
  return legacyEnv('PERMISSION_PROMPTS') === '1';
}

/**
 * Inspect a tool call and decide whether it needs user approval. If yes,
 * prompts via Telegram and waits up to 10 min for a button tap. Returns the
 * final decision.
 *
 * Tools that don't match any pattern auto-allow immediately — most of claude's
 * activity should pass through without the user noticing.
 */
export async function evaluateToolCall(req: GateRequest): Promise<GateDecision> {
  if (!isPermissionGateEnabled()) {
    return { block: false, reason: '' };
  }

  const pattern = matchDangerousPattern(req.toolName, req.toolInput);
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

  const summary = buildSummary(req.toolName, req.toolInput);
  const optionLabels = ['✅ Allow once', '❌ Deny'];
  const { id, promise } = createPendingQuestion(optionLabels, PROMPT_TIMEOUT_MS, req.sessionKey);

  const keyboard = optionLabels.map((label, idx) => [{
    text: label,
    callback_data: `q:${id}:${idx}`,
  }]);

  const { chatId, threadId } = parseSessionKey(req.sessionKey);
  const threadOpts = threadId !== undefined ? { message_thread_id: threadId } : {};
  const promptText =
    `🔐 *Permission requested* — ${pattern.reason}\n\n` +
    `Tool: \`${req.toolName}\`\n` +
    `\n${summary}\n\n` +
    `Times out in 10 min → denied.`;

  try {
    await ctx.api.sendMessage(chatId, promptText, {
      parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: keyboard },
      ...threadOpts,
    });
  } catch (err) {
    // Markdown might fail on weird chars; fall back to plain text
    try {
      await ctx.api.sendMessage(
        chatId,
        `🔐 Permission requested — ${pattern.reason}\n\nTool: ${req.toolName}\n${summary}\n\nTimes out in 10 min → denied.`,
        { reply_markup: { inline_keyboard: keyboard }, ...threadOpts },
      );
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
        ? `User did not approve within 10 minutes. Denied: ${pattern.reason}`
        : `User denied: ${pattern.reason}`,
    };
  }
  return { block: false, reason: '' };
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

function buildSummary(toolName: string, toolInput: Record<string, unknown>): string {
  if (toolName === 'Bash') {
    const cmd = String(toolInput.command ?? '');
    const truncated = cmd.length > 400 ? cmd.slice(0, 397) + '...' : cmd;
    const desc = typeof toolInput.description === 'string' ? toolInput.description : '';
    return desc
      ? `Reason: ${escapeMd(desc)}\n\`\`\`\n${truncated}\n\`\`\``
      : `\`\`\`\n${truncated}\n\`\`\``;
  }
  // Generic fallback
  return `Input: \`${JSON.stringify(toolInput).slice(0, 400)}\``;
}

function escapeMd(s: string): string {
  return s.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

/** List the dangerous patterns surfaced via /permissions. */
export function listDangerousPatterns(): { reason: string; example: string }[] {
  return DANGEROUS_BASH_PATTERNS.map((p) => ({
    reason: p.reason,
    example: p.re.toString(),
  }));
}
