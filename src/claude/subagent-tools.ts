/**
 * Tool names that spawn a subagent (a nested Claude turn whose outcome arrives
 * later as a task-notification). Historically Claude Code called this tool
 * `Task`; newer builds renamed it to `Agent`. We match both so the async-tool
 * relay (arming, `/tasks` tracking, completion notification) keeps working
 * across versions. Add future aliases here — this is the single source of truth.
 */
export const SUBAGENT_TOOL_NAMES = new Set(['Task', 'Agent']);

export function isSubagentTool(toolName: string | undefined | null): boolean {
  return toolName != null && SUBAGENT_TOOL_NAMES.has(toolName);
}
