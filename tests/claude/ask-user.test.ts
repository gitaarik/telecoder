import { describe, it, expect } from 'vitest';
import { buildAskUserMessageText } from '../../src/claude/ask-user.js';

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
