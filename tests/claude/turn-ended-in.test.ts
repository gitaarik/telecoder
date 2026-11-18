/**
 * Whether the log has the end of the turn running in it — what the
 * end-of-turn check asks before it believes a quiet screen without Stop.
 */

import { describe, it, expect } from 'vitest';
import { turnEndedIn } from '../../src/claude/session-jsonl.js';

const prompt = (text: string) => ({ type: 'user', message: { role: 'user', content: text } });
const reply = (text: string, stop: string | null = 'end_turn') => ({
  type: 'assistant', message: { role: 'assistant', stop_reason: stop, content: [{ type: 'text', text }] },
});
const toolUse = () => ({
  type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1' }] },
});
const toolResult = () => ({
  type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] },
});
const apiError = () => ({
  type: 'assistant', isApiErrorMessage: true,
  message: { role: 'assistant', content: [{ type: 'text', text: 'API Error: socket hang up' }] },
});
const stopHookSummary = () => ({ type: 'system', subtype: 'stop_hook_summary' });

const jsonl = (records: unknown[]) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';

describe('turnEndedIn', () => {
  it('has the end once the reply stamped end_turn is in', () => {
    expect(turnEndedIn(jsonl([prompt('q'), reply('a'), stopHookSummary()]))).toBe(true);
  });

  it('has no end while the reply is still being written', () => {
    expect(turnEndedIn(jsonl([prompt('old'), reply('old answer'), prompt('q')]))).toBe(false);
  });

  it('has no end between a tool call and the reply after it', () => {
    expect(turnEndedIn(jsonl([prompt('q'), toolUse()]))).toBe(false);
    expect(turnEndedIn(jsonl([prompt('q'), toolUse(), toolResult()]))).toBe(false);
  });

  it('has the end of a turn that was interrupted', () => {
    expect(turnEndedIn(jsonl([prompt('q'), toolUse(), prompt('[Request interrupted by user for tool use]')]))).toBe(true);
  });

  it('has the end of a turn that died on its API call', () => {
    expect(turnEndedIn(jsonl([prompt('q'), apiError()]))).toBe(true);
  });

  it('skips a last line that is still being written', () => {
    expect(turnEndedIn(jsonl([prompt('q')]) + '{"type":"assistant","mess')).toBe(false);
  });

  it('has nothing to wait for in an empty log', () => {
    expect(turnEndedIn('')).toBe(true);
  });
});
