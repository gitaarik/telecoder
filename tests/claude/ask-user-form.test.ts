import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseFormQuestions,
  resolveAskUserArgs,
  renderForm,
  renderSubmittedForm,
  buildFormKeyboard,
  createPendingForm,
  tapForm,
  parseFormCallback,
  hasPendingForm,
  formatFormAnswers,
  buildFormConfirmation,
  runAskUserForm,
  _resetFormsForTests,
  type FormQuestion,
} from '../../src/claude/ask-user-form.js';
import { hasPendingQuestionForSession } from '../../src/claude/ask-user.js';

const QUESTIONS: FormQuestion[] = [
  { question: 'Which approach?', options: [{ label: 'Patch', description: 'quick' }, { label: 'Rewrite' }] },
  { question: 'Which model?', options: [{ label: 'Opus' }, { label: 'Sonnet' }, { label: 'Haiku' }] },
];

afterEach(() => {
  _resetFormsForTests();
  vi.useRealTimers();
});

describe('resolveAskUserArgs', () => {
  it('is a single question without `questions`', () => {
    const r = resolveAskUserArgs({ question: 'Pick', options: [{ label: 'A' }, { label: 'B' }] });
    expect(r).toEqual({ question: 'Pick', options: [{ label: 'A' }, { label: 'B' }] });
  });

  it('is a form when `questions` has two or more', () => {
    const r = resolveAskUserArgs({ questions: QUESTIONS });
    expect(typeof r === 'object' && r.form).toEqual(QUESTIONS);
  });

  it('turns a one-entry `questions` into a single question', () => {
    const r = resolveAskUserArgs({ questions: [QUESTIONS[0]] });
    expect(r).toEqual({ question: 'Which approach?', options: QUESTIONS[0].options });
  });

  it('prefers `questions` over a stray single question', () => {
    const r = resolveAskUserArgs({ question: 'x', options: [{ label: 'A' }, { label: 'B' }], questions: QUESTIONS });
    expect(typeof r === 'object' && r.form?.length).toBe(2);
  });

  it('explains a call with neither', () => {
    expect(resolveAskUserArgs({ question: 'Pick', options: [{ label: 'only' }] })).toMatch(/≥ 2 options/);
    expect(resolveAskUserArgs({})).toMatch(/non-empty question/);
  });
});

describe('parseFormQuestions', () => {
  it('rejects a question without enough options, naming it', () => {
    expect(parseFormQuestions([QUESTIONS[0], { question: 'x', options: [{ label: 'one' }] }])).toMatch(/question 2 needs between 2 and 8/);
  });

  it('rejects an empty question text', () => {
    expect(parseFormQuestions([{ question: '  ', options: QUESTIONS[0].options }])).toMatch(/question 1 has no text/);
  });

  it('caps the form at four questions', () => {
    expect(parseFormQuestions([QUESTIONS[0], QUESTIONS[0], QUESTIONS[0], QUESTIONS[0], QUESTIONS[0]])).toMatch(/at most 4/);
  });

  it('drops malformed options and keeps descriptions', () => {
    const r = parseFormQuestions([{ question: 'q', options: [{ label: 'A', description: 'd' }, 7, { label: 'B' }] }]);
    expect(r).toEqual([{ question: 'q', options: [{ label: 'A', description: 'd' }, { label: 'B' }] }]);
  });
});

describe('renderForm', () => {
  it('writes out the current question with its options and the others on one line', () => {
    const { text } = renderForm({ id: 'f1', questions: QUESTIONS, context: 'Some context.', answers: [undefined, undefined], cur: 0 });
    expect(text).toBe(
      '📋 2 questions · answer each, then Submit. You can change an answer until then.\n\n' +
        'Some context.\n\n' +
        '▶ 1. Which approach?\n   A. Patch — quick\n   B. Rewrite\n\n' +
        '2. Which model?',
    );
  });

  it('shows an earlier answer in place and marks it when the question is reopened', () => {
    const view = { id: 'f1', questions: QUESTIONS, answers: [1, undefined] as (number | undefined)[], cur: 1 };
    expect(renderForm(view).text).toContain('1. Which approach?\n   ✅ B. Rewrite\n\n▶ 2. Which model?\n   A. Opus');
    expect(renderForm({ ...view, cur: 0 }).text).toContain('▶ 1. Which approach?\n   A. Patch — quick\n   ✅ B. Rewrite');
  });

  it('switches the header once every question is answered', () => {
    const { text } = renderForm({ id: 'f1', questions: QUESTIONS, answers: [0, 2], cur: -1 });
    expect(text.startsWith('📋 2 questions · all answered — check them, then Submit\n')).toBe(true);
    expect(text).toContain('1. Which approach?\n   ✅ A. Patch\n\n2. Which model?\n   ✅ C. Haiku');
  });

  it('clips the context rather than overflow Telegram', () => {
    const { text } = renderForm({ id: 'f1', questions: QUESTIONS, context: 'x'.repeat(5000), answers: [undefined, undefined], cur: 0 });
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).toContain('…\n\n▶ 1. Which approach?');
  });
});

describe('buildFormKeyboard', () => {
  it('has the current question\'s options, a jump row, and no Submit yet', () => {
    const kb = buildFormKeyboard({ id: 'f1', questions: QUESTIONS, answers: [undefined, undefined], cur: 0 });
    expect(kb).toEqual([
      [{ text: 'A · Patch', callback_data: 'qf:f1:o:0:0' }],
      [{ text: 'B · Rewrite', callback_data: 'qf:f1:o:0:1' }],
      [
        { text: '▶ 1', callback_data: 'qf:f1:g:0' },
        { text: '2', callback_data: 'qf:f1:g:1' },
      ],
    ]);
  });

  it('ticks answered questions and adds Submit once all are answered', () => {
    const kb = buildFormKeyboard({ id: 'f1', questions: QUESTIONS, answers: [1, 0], cur: -1 });
    expect(kb).toEqual([
      [
        { text: '1 ✓', callback_data: 'qf:f1:g:0' },
        { text: '2 ✓', callback_data: 'qf:f1:g:1' },
      ],
      [{ text: '✅ Submit', callback_data: 'qf:f1:s' }],
    ]);
  });
});

describe('parseFormCallback', () => {
  it('decodes the three kinds of tap', () => {
    expect(parseFormCallback('qf:ab12:o:1:2')).toEqual({ id: 'ab12', tap: { kind: 'option', question: 1, index: 2 } });
    expect(parseFormCallback('qf:ab12:g:0')).toEqual({ id: 'ab12', tap: { kind: 'goto', question: 0 } });
    expect(parseFormCallback('qf:ab12:s')).toEqual({ id: 'ab12', tap: { kind: 'submit' } });
  });

  it('refuses anything else', () => {
    expect(parseFormCallback('q:ab12:0')).toBeUndefined();
    expect(parseFormCallback('qf:ab12:o:x:1')).toBeUndefined();
    expect(parseFormCallback('qf:ab12:z')).toBeUndefined();
    expect(parseFormCallback('qf:ab12:s:1')).toBeUndefined();
  });
});

describe('a form, tap by tap', () => {
  it('moves on after an answer, lets the user go back and change it, and only Submit resolves', async () => {
    const { id, promise } = createPendingForm(QUESTIONS, undefined, 60_000, '42');
    expect(hasPendingQuestionForSession('42')).toBe(true);

    let out = tapForm(id, { kind: 'option', question: 0, index: 0 });
    expect(out.kind).toBe('redraw');
    if (out.kind !== 'redraw') throw new Error();
    expect(out.text).toContain('✅ A. Patch');
    expect(out.text).toContain('▶ 2. Which model?');
    expect(out.keyboard.at(-1)?.[0].text).not.toBe('✅ Submit');

    out = tapForm(id, { kind: 'option', question: 1, index: 2 });
    if (out.kind !== 'redraw') throw new Error();
    expect(out.text.startsWith('📋 2 questions · all answered')).toBe(true);
    expect(out.keyboard.at(-1)).toEqual([{ text: '✅ Submit', callback_data: `qf:${id}:s` }]);

    // Back to the first question, change the answer.
    out = tapForm(id, { kind: 'goto', question: 0 });
    if (out.kind !== 'redraw') throw new Error();
    expect(out.text).toContain('▶ 1. Which approach?\n   ✅ A. Patch — quick\n   B. Rewrite');
    out = tapForm(id, { kind: 'option', question: 0, index: 1 });
    if (out.kind !== 'redraw') throw new Error();
    expect(out.text).toContain('1. Which approach?\n   ✅ B. Rewrite');

    let settled = false;
    void promise.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    const done = tapForm(id, { kind: 'submit' });
    expect(done.kind).toBe('submitted');
    if (done.kind !== 'submitted') throw new Error();
    expect(done.answers).toEqual([
      { question: 'Which approach?', index: 1, label: 'Rewrite' },
      { question: 'Which model?', index: 2, label: 'Haiku' },
    ]);
    expect(done.text).toBe(
      '📋 2 questions · ✅ Submitted\n\n1. Which approach?\n   ✅ B. Rewrite\n\n2. Which model?\n   ✅ C. Haiku',
    );
    await expect(promise).resolves.toEqual(done.answers);
    expect(hasPendingForm(id)).toBe(false);
    expect(hasPendingQuestionForSession('42')).toBe(false);
    expect(tapForm(id, { kind: 'submit' }).kind).toBe('expired');
  });

  it('refuses Submit while a question is open and jumps to it', () => {
    const { id } = createPendingForm(QUESTIONS, undefined, 60_000);
    tapForm(id, { kind: 'option', question: 1, index: 0 });
    const out = tapForm(id, { kind: 'submit' });
    if (out.kind !== 'redraw') throw new Error();
    expect(out.toast).toBe('Answer question 1 first.');
    expect(out.text).toContain('▶ 1. Which approach?');
    expect(hasPendingForm(id)).toBe(true);
  });

  it('applies an option to the question its button names, not the current one', () => {
    const { id } = createPendingForm(QUESTIONS, undefined, 60_000);
    // Two quick taps on the first question's keyboard before it was redrawn.
    tapForm(id, { kind: 'option', question: 0, index: 0 });
    const out = tapForm(id, { kind: 'option', question: 0, index: 1 });
    if (out.kind !== 'redraw') throw new Error();
    expect(out.text).toContain('1. Which approach?\n   ✅ B. Rewrite');
    expect(out.text).toContain('▶ 2. Which model?');
  });

  it('ignores an out-of-range option or question', () => {
    const { id } = createPendingForm(QUESTIONS, undefined, 60_000);
    const a = tapForm(id, { kind: 'option', question: 0, index: 9 });
    const b = tapForm(id, { kind: 'goto', question: 7 });
    if (a.kind !== 'redraw' || b.kind !== 'redraw') throw new Error();
    expect(a.text).toContain('▶ 1. Which approach?');
    expect(b.text).toContain('▶ 1. Which approach?');
  });

  it('times out to null and lets go of the session wait', async () => {
    vi.useFakeTimers();
    const { promise } = createPendingForm(QUESTIONS, undefined, 1000, '43');
    expect(hasPendingQuestionForSession('43')).toBe(true);
    vi.advanceTimersByTime(1000);
    await expect(promise).resolves.toBeNull();
    expect(hasPendingQuestionForSession('43')).toBe(false);
  });

  it('keeps a restricted form for the listed responders', () => {
    const { id } = createPendingForm(QUESTIONS, undefined, 60_000, undefined, [7]);
    expect(tapForm(id, { kind: 'option', question: 0, index: 0 }, 8)).toEqual({ kind: 'forbidden', allowed: [7] });
    expect(tapForm(id, { kind: 'option', question: 0, index: 0 }).kind).toBe('forbidden');
    expect(tapForm(id, { kind: 'option', question: 0, index: 0 }, 7).kind).toBe('redraw');
  });
});

describe('what the model and the chat read back', () => {
  const answers = [
    { question: 'Which approach?', index: 1, label: 'Rewrite' },
    { question: 'Which model?', index: 0, label: 'Opus' },
  ];

  it('lists every question with its answer for the model', () => {
    expect(formatFormAnswers(answers)).toBe('User answered:\n1. Which approach? → Rewrite\n2. Which model? → Opus');
  });

  it('confirms in second person privately and by name in a group', () => {
    expect(buildFormConfirmation(answers, { isPrivate: true })).toBe('✅ You answered: 1. Rewrite · 2. Opus');
    expect(buildFormConfirmation(answers, { isPrivate: false, who: 'Sam' })).toBe('✅ Sam answered: 1. Rewrite · 2. Opus');
  });
});

describe('runAskUserForm', () => {
  function fakeApi() {
    return {
      sendMessage: vi.fn().mockResolvedValue({ chat: { id: 42 }, message_id: 7 }),
      editMessageText: vi.fn().mockResolvedValue(true),
      editMessageReplyMarkup: vi.fn().mockResolvedValue(true),
    };
  }
  type Api = Parameters<typeof runAskUserForm>[0]['api'];

  it('posts the form into the thread and returns the answers once submitted', async () => {
    const api = fakeApi();
    const onPosted = vi.fn().mockResolvedValue(undefined);
    const onSettled = vi.fn().mockResolvedValue(undefined);
    const run = runAskUserForm({
      api: api as unknown as Api, chatId: 42, threadId: 5, sessionKey: '42:5',
      questions: QUESTIONS, context: 'Why.', onPosted, onSettled,
    });
    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalled());
    const [chatId, text, extra] = api.sendMessage.mock.calls[0];
    expect(chatId).toBe(42);
    expect(text).toContain('Why.');
    expect(extra.message_thread_id).toBe(5);
    const id = extra.reply_markup.inline_keyboard[0][0].callback_data.split(':')[1];
    expect(onPosted).toHaveBeenCalled();

    tapForm(id, { kind: 'option', question: 0, index: 1 });
    tapForm(id, { kind: 'option', question: 1, index: 0 });
    tapForm(id, { kind: 'submit' });
    await expect(run).resolves.toBe('User answered:\n1. Which approach? → Rewrite\n2. Which model? → Opus');
    expect(onSettled).toHaveBeenCalled();
  });

  it('closes an unanswered form under its latest text when the clock runs out', async () => {
    vi.useFakeTimers();
    const api = fakeApi();
    const run = runAskUserForm({ api: api as unknown as Api, chatId: 42, sessionKey: '42', questions: QUESTIONS });
    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalled());
    const id = api.sendMessage.mock.calls[0][2].reply_markup.inline_keyboard[0][0].callback_data.split(':')[1];
    tapForm(id, { kind: 'option', question: 0, index: 0 });
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    await expect(run).resolves.toMatch(/did not respond within 10 minutes/);
    const [, , text] = api.editMessageText.mock.calls[0];
    expect(text).toContain('✅ A. Patch');
    expect(text).toContain('No answer within 10 min');
  });
});
