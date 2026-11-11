import { describe, it, expect } from 'vitest';
import { buildResumeMessage } from '../../src/bot/handlers/command/session.js';

const HOUR = 3600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

describe('buildResumeMessage', () => {
  it('writes every session into the body, keyed by letter', () => {
    const { text } = buildResumeMessage([
      { conversationId: 'c1', projectName: 'telecoder', topic: 'resume buttons', lastActivity: ago(2 * HOUR) },
      { conversationId: 'c2', projectName: 'sjs', lastActivity: ago(5 * HOUR) },
    ]);
    expect(text.text).toContain('A. telecoder · resume buttons — 2h ago');
    expect(text.text).toContain('B. sjs — 5h ago');
  });

  it('points each button at the session named on the same letter', () => {
    const { keyboard } = buildResumeMessage([
      { conversationId: 'c1', projectName: 'telecoder', topic: 'a topic long enough to clip a button', lastActivity: ago(HOUR) },
      { conversationId: 'c2', projectName: 'sjs', lastActivity: ago(HOUR) },
    ]);
    expect(keyboard).toEqual([
      [
        { text: 'A', callback_data: 'resume:c1' },
        { text: 'B', callback_data: 'resume:c2' },
      ],
    ]);
  });

  it('keeps short names on their buttons, where they survive whole', () => {
    const { keyboard } = buildResumeMessage([
      { conversationId: 'c1', projectName: 'telecoder', lastActivity: ago(HOUR) },
      { conversationId: 'c2', projectName: 'sjs', lastActivity: ago(HOUR) },
    ]);
    expect(keyboard).toEqual([
      [{ text: 'A · telecoder', callback_data: 'resume:c1' }],
      [{ text: 'B · sjs', callback_data: 'resume:c2' }],
    ]);
  });

  it('sends a name verbatim, formatting only the heading', () => {
    const { text } = buildResumeMessage([
      { conversationId: 'c1', projectName: 'api-v2', topic: 'fix (the) *parser*', lastActivity: ago(HOUR) },
    ]);
    expect(text.text).toBe(
      '📜 Recent Sessions\n\nSelect a session to resume:\n\nA. api-v2 · fix (the) *parser* — 1h ago',
    );
    expect(text.entities).toEqual([{ type: 'bold', offset: 3, length: 'Recent Sessions'.length }]);
  });

  it('bounds a typed-in topic so a full history still fits one message', () => {
    const { text } = buildResumeMessage(
      Array.from({ length: 10 }, (_, i) => ({
        conversationId: `c${i}`,
        projectName: 'telecoder',
        topic: 'x'.repeat(4000),
        lastActivity: ago(HOUR),
      })),
    );
    expect(text.text.length).toBeLessThan(4096);
  });
});
