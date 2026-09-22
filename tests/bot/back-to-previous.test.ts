import { describe, it, expect, vi, beforeEach } from 'vitest';

const history: Array<{
  conversationId: string;
  projectName: string;
  topic?: string;
  claudeSessionId?: string;
  lastActivity: string;
}> = [];

vi.mock('../../src/claude/session-manager.js', () => ({
  sessionManager: {
    getSessionHistory: () => history,
  },
}));

const { withBackToPrevious } = await import('../../src/bot/handlers/command/shared.js');

const HOUR = 3600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function seed(...entries: typeof history) {
  history.length = 0;
  history.push(...entries);
}

beforeEach(() => {
  history.length = 0;
});

describe('withBackToPrevious', () => {
  it('leaves the message alone when there is nothing to go back to', () => {
    const back = withBackToPrevious('🔄 Cleared\\.', 'chat:1');
    expect(back.text).toBe('🔄 Cleared\\.');
    expect(back.options.reply_markup).toBeUndefined();
  });

  it('names the session on the button while the name fits', () => {
    seed({ conversationId: 'c1', projectName: 'telecoder', claudeSessionId: 's1', lastActivity: ago(2 * HOUR) });
    const back = withBackToPrevious('🔄 Cleared\\.', 'chat:1');
    expect(back.text).toBe('🔄 Cleared\\.');
    expect(back.options.reply_markup?.inline_keyboard).toEqual([
      [{ text: '↩️ Back to telecoder (2h ago)', callback_data: 'resume:c1' }],
    ]);
  });

  it('moves a name too wide for the button into the message body', () => {
    seed({
      conversationId: 'c1',
      projectName: 'telecoder',
      topic: 'resume picker readability',
      claudeSessionId: 's1',
      lastActivity: ago(2 * HOUR),
    });
    const back = withBackToPrevious('🔄 Cleared\\.', 'chat:1');
    expect(back.text).toBe(
      '🔄 Cleared\\.\n\n↩️ Previous: telecoder · resume picker readability \\(2h ago\\)',
    );
    expect(back.options.reply_markup?.inline_keyboard).toEqual([
      [{ text: '↩️ Back to previous', callback_data: 'resume:c1' }],
    ]);
  });

  it('skips the conversation you are already in', () => {
    seed(
      { conversationId: 'c1', projectName: 'telecoder', claudeSessionId: 's1', lastActivity: ago(HOUR) },
      { conversationId: 'c2', projectName: 'sjs-dev', claudeSessionId: 's2', lastActivity: ago(3 * HOUR) },
    );
    const back = withBackToPrevious('msg', 'chat:1', 'c1');
    expect(back.options.reply_markup?.inline_keyboard[0][0].callback_data).toBe('resume:c2');
  });

  it('skips a session that was never chatted in', () => {
    seed({ conversationId: 'c1', projectName: 'telecoder', lastActivity: ago(HOUR) });
    expect(withBackToPrevious('msg', 'chat:1').options.reply_markup).toBeUndefined();
  });

  it('is a plain message when there is no session key at all', () => {
    seed({ conversationId: 'c1', projectName: 'telecoder', claudeSessionId: 's1', lastActivity: ago(HOUR) });
    const back = withBackToPrevious('msg', undefined);
    expect(back).toEqual({ text: 'msg', options: { parse_mode: 'MarkdownV2' } });
  });
});
