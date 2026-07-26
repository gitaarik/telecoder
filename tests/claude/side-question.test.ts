import { describe, it, expect } from 'vitest';
import { extractAnswer, SideQuestionError } from '../../src/claude/side-question.js';

describe('extractAnswer', () => {
  it('returns plain (non-JSON) stdout trimmed', () => {
    expect(extractAnswer('  just some text\n')).toEqual({ response: 'just some text' });
  });

  it('pulls result and session id out of --output-format json', () => {
    const stdout = JSON.stringify({
      is_error: false,
      result: '  the answer  ',
      session_id: 'f92ec67d-8429-4cd4-929c-c3ec7d897034',
    });
    expect(extractAnswer(stdout)).toEqual({
      response: 'the answer',
      forkSessionId: 'f92ec67d-8429-4cd4-929c-c3ec7d897034',
    });
  });

  it('leaves forkSessionId undefined when claude reports no session id', () => {
    const out = extractAnswer(JSON.stringify({ result: 'hi' }));
    expect(out.response).toBe('hi');
    expect(out.forkSessionId).toBeUndefined();
  });

  it('throws with the result text when claude flags an error', () => {
    const stdout = JSON.stringify({ is_error: true, result: 'session not found' });
    expect(() => extractAnswer(stdout)).toThrow(SideQuestionError);
    expect(() => extractAnswer(stdout)).toThrow('session not found');
  });

  it('falls back to the error field when an errored result has no text', () => {
    const stdout = JSON.stringify({ is_error: true, error: 'exit code 1' });
    expect(() => extractAnswer(stdout)).toThrow('exit code 1');
  });

  it('falls back to raw stdout when JSON-looking output does not parse', () => {
    // A truncated JSON payload still starts with '{' — we must not lose it.
    const stdout = '{"result": "half an ans';
    expect(extractAnswer(stdout)).toEqual({ response: stdout });
  });

  it('yields an empty response when result is not a string', () => {
    expect(extractAnswer(JSON.stringify({ result: 42 })).response).toBe('');
  });
});

describe('extractAnswer with --output-format stream-json', () => {
  /** Shape of a real fork run: init, thinking, a tool call, then the result. */
  const stream = [
    { type: 'system', subtype: 'init' },
    { type: 'system', subtype: 'thinking_tokens' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking' }] } },
    {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
    },
    { type: 'rate_limit_event' },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: 'the answer', session_id: 'fork-abc123' },
  ].map((r) => JSON.stringify(r)).join('\n');

  it('picks the result record out of the stream', () => {
    expect(extractAnswer(stream)).toEqual({
      response: 'the answer',
      forkSessionId: 'fork-abc123',
    });
  });

  it('ignores trailing whitespace and blank lines', () => {
    expect(extractAnswer(`${stream}\n\n  \n`).response).toBe('the answer');
  });

  it('takes the last result record when more than one appears', () => {
    const doubled = `${stream}\n${JSON.stringify({ type: 'result', result: 'later answer' })}`;
    expect(extractAnswer(doubled).response).toBe('later answer');
  });

  it('throws when the stream ends in an error result', () => {
    const failed = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'result', is_error: true, result: 'context low' }),
    ].join('\n');
    expect(() => extractAnswer(failed)).toThrow(SideQuestionError);
    expect(() => extractAnswer(failed)).toThrow('context low');
  });

  it('returns raw output when the stream is cut short before a result', () => {
    const truncated = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking' }] } }),
    ].join('\n');
    expect(extractAnswer(truncated)).toEqual({ response: truncated });
  });

  it('skips unparseable lines rather than losing the result', () => {
    const noisy = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      '{ this is not json',
      JSON.stringify({ type: 'result', result: 'survived' }),
    ].join('\n');
    expect(extractAnswer(noisy).response).toBe('survived');
  });
});
