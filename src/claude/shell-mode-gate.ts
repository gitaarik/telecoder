/**
 * The permission gate for Claude Code's shell mode.
 *
 * A prompt whose first character is `!` never reaches the model. Claude Code
 * runs the rest of it as a shell command, and because that is not a tool call
 * it raises no PreToolUse hook: measured on 2.1.326, a pasted `!echo x > f`
 * wrote the file and the only hook that fired was Stop. The gate and the scope
 * guard live in that hook, so neither saw a command someone typed themselves.
 * On a shared bot a guest's `!sudo …` ran where Claude's own `sudo` would have
 * waited for an admin.
 *
 * So such a message is put to the gate here, as the Bash call it amounts to,
 * before it is typed into the pty. Everything else is the gate's: off on a
 * solo bot, the same patterns and paths, the same people to answer, the same
 * auto-approve window. An admin's `!` is checked as an admin's turn is.
 */

import type { Context } from 'grammy';
import { gateToolCall } from './permission-gate.js';

/** What the approval prompt names as the tool: the command was typed, not Claude's. */
export const SHELL_MODE_LABEL = '! shell mode';

export interface ShellScreenOutcome {
  /** True when the message may be typed into the pty. */
  proceed: boolean;
  /** What to tell the chat when it may not. Empty when it may. */
  message: string;
  /** True when someone read the command in a prompt and allowed it. */
  approved: boolean;
}

/**
 * The command a prompt runs in shell mode, or undefined for an ordinary prompt.
 *
 * Measured against the same CLI: only a `!` in the very first position
 * switches the editor to shell mode (` !echo x` stayed a prompt), and a
 * multi-line message runs whole as one script, also when it is long enough to
 * be collapsed into a `[Pasted text]` chip. So everything after the `!` is the
 * command.
 */
export function shellModeCommand(prompt: string): string | undefined {
  if (!prompt.startsWith('!')) return undefined;
  const command = prompt.slice(1).trim();
  return command === '' ? undefined : command;
}

/**
 * Put a `!command` to the permission gate before it runs. Anything else, and
 * everything while the gate is off, proceeds untouched.
 */
export async function screenShellCommand(
  ctx: Context | undefined,
  sessionKey: string,
  prompt: string,
): Promise<ShellScreenOutcome> {
  const command = shellModeCommand(prompt);
  if (command === undefined) return { proceed: true, message: '', approved: false };

  const decision = await gateToolCall({
    sessionKey,
    toolName: 'Bash',
    toolInput: { command },
    telegramCtx: ctx,
    toolLabel: SHELL_MODE_LABEL,
  });
  if (decision.block) {
    console.log(`[ShellModeGate] blocked session:${sessionKey} user:${ctx?.from?.id ?? '?'}`);
    return {
      proceed: false,
      message: `🔐 ${decision.reason.replace(/\.$/, '')}. Nothing ran.`,
      approved: false,
    };
  }
  return { proceed: true, message: '', approved: decision.approvedByPerson === true };
}
