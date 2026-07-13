import { describe, it, expect } from 'vitest';
import { SUBAGENT_TOOL_NAMES, isSubagentTool } from '../../src/claude/subagent-tools.js';

describe('isSubagentTool', () => {
  it('matches the historical Task tool name', () => {
    expect(isSubagentTool('Task')).toBe(true);
  });

  it('matches the newer Agent tool name', () => {
    expect(isSubagentTool('Agent')).toBe(true);
  });

  it('rejects non-subagent tools', () => {
    for (const name of ['Bash', 'Monitor', 'Read', 'Edit', 'TaskCreate', 'agent', 'task']) {
      expect(isSubagentTool(name)).toBe(false);
    }
  });

  it('handles null/undefined without throwing', () => {
    expect(isSubagentTool(undefined)).toBe(false);
    expect(isSubagentTool(null)).toBe(false);
  });

  it('exposes both aliases in the source-of-truth set', () => {
    expect(SUBAGENT_TOOL_NAMES.has('Task')).toBe(true);
    expect(SUBAGENT_TOOL_NAMES.has('Agent')).toBe(true);
  });
});
