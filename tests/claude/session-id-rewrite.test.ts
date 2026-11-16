import { describe, it, expect } from 'vitest';
import { rewriteJsonlSessionId } from '../../src/claude/session-jsonl.js';

const OLD = '11111111-1111-4111-8111-111111111111';
const NEW = '22222222-2222-4222-8222-222222222222';

function rec(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

function sessionIds(jsonl: string): string[] {
  return jsonl.split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { sessionId?: string }).sessionId ?? '(none)');
}

describe('rewriteJsonlSessionId', () => {
  it('rewrites every record and leaves every other byte as it was', () => {
    const jsonl = [
      rec({ type: 'user', sessionId: OLD, message: { role: 'user', content: 'hi — “quotes” é' } }),
      rec({ type: 'summary', summary: 'A title' }),
      rec({ type: 'assistant', sessionId: OLD, message: { role: 'assistant', content: [] } }),
    ].join('\n') + '\n';

    const out = rewriteJsonlSessionId(jsonl, NEW);

    expect(sessionIds(out)).toEqual([NEW, '(none)', NEW]);
    expect(out.split(`"sessionId":"${NEW}"`).join(`"sessionId":"${OLD}"`)).toBe(jsonl);
    expect(out.length).toBe(jsonl.length);
  });

  it('leaves a transcript with no session ids, or an empty one, alone', () => {
    const jsonl = rec({ type: 'summary', summary: 'A title' }) + '\n';
    expect(rewriteJsonlSessionId(jsonl, NEW)).toBe(jsonl);
    expect(rewriteJsonlSessionId('', NEW)).toBe('');
    expect(rewriteJsonlSessionId('\n', NEW)).toBe('\n');
  });

  it('is a no-op when the records already carry the new id', () => {
    const jsonl = rec({ type: 'user', sessionId: NEW, message: {} }) + '\n';
    expect(rewriteJsonlSessionId(jsonl, NEW)).toBe(jsonl);
  });

  it('passes a line it cannot parse through unchanged', () => {
    const half = '{"type":"user","sessionId":"' + OLD + '","message":{"con';
    const jsonl = rec({ type: 'user', sessionId: OLD, message: {} }) + '\n' + half;
    const out = rewriteJsonlSessionId(jsonl, NEW);
    const [first, second] = out.split('\n');
    expect((JSON.parse(first) as { sessionId: string }).sessionId).toBe(NEW);
    // The half-written line is text, not a record: it changes with the fast
    // path (its field text matches) and not with the per-record one; either
    // way it's still the same broken line otherwise.
    expect(second.replace(NEW, OLD)).toBe(half);
  });

  it('falls back to record-by-record rewriting when records carry more than one id', () => {
    const OTHER = '33333333-3333-4333-8333-333333333333';
    const jsonl = [
      rec({ type: 'user', sessionId: OLD }),
      rec({ type: 'user', sessionId: OTHER }),
      rec({ type: 'user', sessionId: OLD }),
    ].join('\n') + '\n';

    expect(sessionIds(rewriteJsonlSessionId(jsonl, NEW))).toEqual([NEW, NEW, NEW]);
  });

  it('also falls back when a record spells the field with spaces', () => {
    const jsonl = `{"type":"user", "sessionId": "${OLD}"}\n` + rec({ type: 'assistant', sessionId: OLD }) + '\n';
    expect(sessionIds(rewriteJsonlSessionId(jsonl, NEW))).toEqual([NEW, NEW]);
  });

  it('does not touch a different field that happens to hold the id', () => {
    const jsonl = rec({ type: 'user', sessionId: OLD, parentSessionId: OLD, message: { content: `cwd ${OLD}` } }) + '\n';
    const out = JSON.parse(rewriteJsonlSessionId(jsonl, NEW).trim()) as Record<string, unknown>;
    expect(out.sessionId).toBe(NEW);
    expect(out.parentSessionId).toBe(OLD);
    expect((out.message as { content: string }).content).toBe(`cwd ${OLD}`);
  });
});
