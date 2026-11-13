/**
 * The transcript "Ask in a fork" starts its thread from: the conversation up to
 * the last turn that ended, then the running turn's prompt as its own record,
 * answered by a note saying it's still being worked on elsewhere.
 */

import { describe, it, expect } from 'vitest';
import { forkPastRunningTurn, lastExchangeIn, userPromptsIn } from '../../src/claude/session-jsonl.js';

const NOTE = 'Still running in the original.';

let n = 0;
const base = () => ({ sessionId: 'src', cwd: '/p', version: '2.1.320', gitBranch: 'main', uuid: `u${++n}` });
const prompt = (text: string) => ({
  ...base(), type: 'user', message: { role: 'user', content: text },
});
const notification = (text: string) => ({
  ...base(), type: 'user', origin: { kind: 'task-notification' }, message: { role: 'user', content: text },
});
const reply = (text: string, stop: string | null = 'end_turn') => ({
  ...base(), type: 'assistant',
  message: {
    role: 'assistant', model: 'claude-opus-5-5', stop_reason: stop,
    content: [{ type: 'text', text }], usage: { input_tokens: 1234, output_tokens: 5 },
  },
});
const toolUse = () => ({
  ...base(), type: 'assistant',
  message: { role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1' }] },
});
const toolResult = () => ({
  ...base(), type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] },
});
const snapshot = () => ({ type: 'file-history-snapshot', messageId: 'x' });

const jsonl = (records: unknown[]) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';
const parse = (raw: string) => raw.trim().split('\n').map((l) => JSON.parse(l) as Record<string, any>);

describe('forkPastRunningTurn', () => {
  it('leaves the running turn out, keeps its prompt, and answers it with the note', () => {
    const running = prompt('a very long prompt\nthat goes on\n\nand on');
    const records = [prompt('first'), reply('first answer'), snapshot(), running, toolUse(), toolResult(), reply('half', null)];
    const { jsonl: out, noted } = forkPastRunningTurn(jsonl(records), NOTE);

    expect(noted).toBe(true);
    const lines = parse(out);
    expect(lines.slice(0, 4)).toEqual(records.slice(0, 4));
    expect(lines).toHaveLength(5);
    const note = lines[4]!;
    expect(note).toMatchObject({
      type: 'assistant',
      parentUuid: running.uuid,
      sessionId: 'src',
      cwd: '/p',
      message: {
        role: 'assistant',
        model: 'claude-opus-5-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: NOTE }],
        usage: { input_tokens: 1234, output_tokens: 5 },
      },
    });
    expect(note.uuid).not.toBe(running.uuid);
  });

  it('reads back as the running prompt answered by the note, so the banner shows both', () => {
    const records = [prompt('first'), reply('first answer'), prompt('the running one'), toolUse()];
    const { jsonl: out } = forkPastRunningTurn(jsonl(records), NOTE);

    expect(lastExchangeIn(out)).toEqual({ user: 'the running one', assistant: NOTE });
    expect(userPromptsIn(out).map((p) => [p.text, p.pending])).toEqual([['first', false], ['the running one', false]]);
  });

  it('keeps a background report that opened the running turn, the way it keeps a prompt', () => {
    const report = notification('<task-notification>done</task-notification>');
    const records = [prompt('first'), reply('first answer'), report, reply('working on it', null)];
    const lines = parse(forkPastRunningTurn(jsonl(records), NOTE).jsonl);

    expect(lines.slice(-2)[0]).toEqual(report);
    expect(lines.at(-1)).toMatchObject({ parentUuid: report.uuid, message: { content: [{ text: NOTE }] } });
  });

  it('counts an interrupted turn as ended', () => {
    const records = [prompt('first'), toolUse(), prompt('[Request interrupted by user]'), prompt('running'), toolUse()];
    const lines = parse(forkPastRunningTurn(jsonl(records), NOTE).jsonl);

    expect(lines.slice(0, 4)).toEqual(records.slice(0, 4));
    expect(lines.at(-1)?.message.content[0].text).toBe(NOTE);
  });

  it('forks a first prompt that is still running, with no earlier reply to copy', () => {
    const records = [prompt('only'), toolUse()];
    const lines = parse(forkPastRunningTurn(jsonl(records), NOTE).jsonl);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual(records[0]);
    expect(lines[1]).toMatchObject({ parentUuid: records[0]!.uuid, message: { stop_reason: 'end_turn' } });
  });

  it('forks up to the last ended turn, without a note, when the running turn is not on disk yet', () => {
    const records = [prompt('first'), reply('first answer')];
    expect(forkPastRunningTurn(jsonl(records), NOTE)).toEqual({ jsonl: jsonl(records), noted: false });
  });
});
