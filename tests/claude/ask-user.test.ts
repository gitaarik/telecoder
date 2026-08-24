import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildAskUserMessageText,
  appendAnsweredFooter,
  buildAnswerConfirmation,
  createPendingQuestion,
  resolvePendingQuestion,
  getQuestionResponders,
  hasPendingQuestionForSession,
} from '../../src/claude/ask-user.js';

describe('buildAskUserMessageText', () => {
  it('renders just the question when there is no context and no option descriptions', () => {
    const text = buildAskUserMessageText('Pick one', [{ label: 'A' }, { label: 'B' }]);
    expect(text).toBe('❓ Pick one');
  });

  it('renders per-option descriptions as bullet lines below the question', () => {
    const text = buildAskUserMessageText('Pick one', [
      { label: 'A', description: 'first' },
      { label: 'B', description: 'second' },
    ]);
    expect(text).toBe('❓ Pick one\n\n• A — first\n• B — second');
  });

  it('inserts the context block between the question and the options', () => {
    const text = buildAskUserMessageText(
      'Which model?',
      [{ label: 'GPT-OSS 120B', description: '$0.15/$0.60' }, { label: 'Qwen3 32B' }],
      'Current: Scout — $X, 128k ctx.\nClosest: GPT-OSS 120B.',
    );
    expect(text).toBe(
      '❓ Which model?\n\n' +
        'Current: Scout — $X, 128k ctx.\nClosest: GPT-OSS 120B.\n\n' +
        '• GPT-OSS 120B — $0.15/$0.60',
    );
  });

  it('renders context even when no option carries a description', () => {
    const text = buildAskUserMessageText('Proceed?', [{ label: 'Yes' }, { label: 'No' }], 'This deletes 3 files.');
    expect(text).toBe('❓ Proceed?\n\nThis deletes 3 files.');
  });

  it('ignores blank/whitespace-only context', () => {
    const text = buildAskUserMessageText('Pick', [{ label: 'A' }, { label: 'B' }], '   \n  ');
    expect(text).toBe('❓ Pick');
  });

  it('clips over-long context to keep the message under Telegram limits', () => {
    const long = 'x'.repeat(5000);
    const text = buildAskUserMessageText('Pick', [{ label: 'A' }, { label: 'B' }], long);
    // Question line + blank + clipped context; clipped body ends with an ellipsis.
    expect(text.length).toBeLessThan(4000);
    expect(text.endsWith('…')).toBe(true);
    expect(text.startsWith('❓ Pick\n\nxxx')).toBe(true);
  });
});

describe('appendAnsweredFooter', () => {
  it('marks the chosen option below the question', () => {
    expect(appendAnsweredFooter('❓ Pick one', 'Option A')).toBe('❓ Pick one\n\n✅ Answered: Option A');
  });

  it('declines when the footer would push the edit past Telegram\'s limit', () => {
    expect(appendAnsweredFooter('x'.repeat(4090), 'Option A')).toBeNull();
  });

  it('accepts a question that still has room for the footer', () => {
    const original = 'x'.repeat(4000);
    expect(appendAnsweredFooter(original, 'A')?.length).toBe(original.length + '\n\n✅ Answered: A'.length);
  });

  it('declines when there is no original text to append to', () => {
    expect(appendAnsweredFooter('', 'Option A')).toBeNull();
  });
});

describe('buildAnswerConfirmation', () => {
  it('uses second person in a private chat', () => {
    expect(buildAnswerConfirmation('Rebase', { isPrivate: true, who: 'Rik' })).toBe('✅ You picked: Rebase');
  });

  it('names the person who tapped in a group', () => {
    expect(buildAnswerConfirmation('Rebase', { isPrivate: false, who: 'Rik' })).toBe('✅ Rik picked: Rebase');
  });

  it('falls back to a placeholder when the tapper has no usable name', () => {
    expect(buildAnswerConfirmation('Rebase', { isPrivate: false, who: '  ' })).toBe('✅ Someone picked: Rebase');
    expect(buildAnswerConfirmation('Rebase', { isPrivate: false })).toBe('✅ Someone picked: Rebase');
  });
});

// The streaming status bubble renders "waiting for your answer" straight off
// this flag rather than tracking its own, so the flag has to go down on every
// exit path — otherwise the bubble stays parked after the turn resumes.
describe('hasPendingQuestionForSession', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is false for a session with no outstanding question', () => {
    expect(hasPendingQuestionForSession('chat-none')).toBe(false);
  });

  it('goes up while a question is open and back down once it is answered', async () => {
    const { id, promise } = createPendingQuestion(['A', 'B'], undefined, 'chat-1');
    expect(hasPendingQuestionForSession('chat-1')).toBe(true);

    expect(resolvePendingQuestion(id, 1)).toBe('resolved');
    await expect(promise).resolves.toEqual({ label: 'B', index: 1 });
    expect(hasPendingQuestionForSession('chat-1')).toBe(false);
  });

  it('goes back down when the question times out unanswered', async () => {
    vi.useFakeTimers();
    const { promise } = createPendingQuestion(['A', 'B'], 1000, 'chat-2');
    expect(hasPendingQuestionForSession('chat-2')).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toBeNull();
    expect(hasPendingQuestionForSession('chat-2')).toBe(false);
  });

  it('stays up until the last of several overlapping questions resolves', async () => {
    const first = createPendingQuestion(['A', 'B'], undefined, 'chat-3');
    const second = createPendingQuestion(['C', 'D'], undefined, 'chat-3');
    expect(hasPendingQuestionForSession('chat-3')).toBe(true);

    resolvePendingQuestion(first.id, 0);
    await first.promise;
    expect(hasPendingQuestionForSession('chat-3')).toBe(true);

    resolvePendingQuestion(second.id, 0);
    await second.promise;
    expect(hasPendingQuestionForSession('chat-3')).toBe(false);
  });

  it('does not leak the flag when the tapped index has no matching option', async () => {
    const { id, promise } = createPendingQuestion(['A', 'B'], undefined, 'chat-4');
    expect(resolvePendingQuestion(id, 9)).toBe('resolved');
    await expect(promise).resolves.toBeNull();
    expect(hasPendingQuestionForSession('chat-4')).toBe(false);
  });
});

describe('restricted questions', () => {
  it('lets a listed responder answer', async () => {
    const { id, promise } = createPendingQuestion(['A', 'B'], undefined, 'chat-r1', [7, 8]);
    expect(resolvePendingQuestion(id, 0, 7)).toBe('resolved');
    await expect(promise).resolves.toEqual({ label: 'A', index: 0 });
  });

  it('refuses an unlisted responder and keeps the question open', async () => {
    const { id, promise } = createPendingQuestion(['A', 'B'], undefined, 'chat-r2', [7]);

    expect(resolvePendingQuestion(id, 0, 99)).toBe('forbidden');
    // Still answerable by the right person — a refused tap must not consume it.
    expect(hasPendingQuestionForSession('chat-r2')).toBe(true);
    expect(resolvePendingQuestion(id, 1, 7)).toBe('resolved');
    await expect(promise).resolves.toEqual({ label: 'B', index: 1 });
  });

  it('fails closed when no responder id is supplied', async () => {
    const { id } = createPendingQuestion(['A', 'B'], undefined, 'chat-r3', [7]);
    expect(resolvePendingQuestion(id, 0)).toBe('forbidden');
  });

  it('ignores the responder id on an unrestricted question', () => {
    const { id } = createPendingQuestion(['A', 'B'], undefined, 'chat-r4');
    expect(resolvePendingQuestion(id, 0, 12345)).toBe('resolved');
  });

  it('treats an empty responder list as unrestricted rather than unanswerable', () => {
    const { id } = createPendingQuestion(['A', 'B'], undefined, 'chat-r5', []);
    expect(getQuestionResponders(id)).toBeUndefined();
    expect(resolvePendingQuestion(id, 0, 999)).toBe('resolved');
  });

  it('reports the allowed responders so the refusal can name them', () => {
    const { id } = createPendingQuestion(['A', 'B'], undefined, 'chat-r6', [7, 8]);
    expect(getQuestionResponders(id)).toEqual([7, 8]);
    resolvePendingQuestion(id, 0, 7);
    expect(getQuestionResponders(id)).toBeUndefined();
  });

  it('reports expired for an unknown id regardless of responder', () => {
    expect(resolvePendingQuestion('deadbeef', 0, 7)).toBe('expired');
  });
});
