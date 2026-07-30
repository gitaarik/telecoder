/**
 * Claude Code stamps its own session's identity into the environment of every
 * process it spawns, and anything started from inside a session inherits it.
 * That is exactly how this bot gets deployed: a claude session running *in* the
 * bot runs `pm2 start`, and pm2 captures that environment for the app's whole
 * lifetime — so every worker, and every claude the bot itself spawns, inherits
 * the parent session's markers.
 *
 * The damaging one is CLAUDE_CODE_CHILD_SESSION. A claude that sees it decides
 * it is a nested session and turns transcript persistence OFF ("⚠ Transcript
 * saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker" in its status
 * line). The session JSONL is then never written — and since the bot reads each
 * reply out of that log, every turn returns the *previous* conversation's text.
 * The model answers correctly; the user gets a stale answer to a question it
 * did receive, and no error anywhere says why.
 *
 * None of these are read by the bot itself, so the safe move is to drop them at
 * startup, before any provider spawns anything.
 */
export const INHERITED_CLAUDE_SESSION_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_SDK_LOAD_USER_SETTINGS',
];

/** A copy of `env` with the parent session's markers removed. */
export function envWithoutParentSession(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const copy = { ...env };
  for (const key of INHERITED_CLAUDE_SESSION_VARS) delete copy[key];
  return copy;
}

/**
 * Drop the markers from this process's own environment so every child inherits
 * a clean slate. Returns the names that were actually present — the caller logs
 * them, because "the bot was launched from inside a claude session" is worth
 * knowing when diagnosing session-log weirdness later.
 */
export function stripParentClaudeSession(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed: string[] = [];
  for (const key of INHERITED_CLAUDE_SESSION_VARS) {
    if (env[key] !== undefined) {
      removed.push(key);
      delete env[key];
    }
  }
  return removed;
}
