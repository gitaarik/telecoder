import { describe, it, expect } from 'vitest';
import { renderPrompts, type Conversation } from '../../src/bot/handlers/prompts.handler.js';
import { promptLabel, summarizeUserPrompt, cutLabel } from '../../src/telegram/prompt-label.js';

const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

let line = 0;
/** A prompt the way readConversation hands one over: a turn, with its place in the transcript. */
const prompt = (text: string, mins?: number, pending = false): Conversation['prompts'][number] => {
  line += 2;
  return {
    text,
    timestamp: mins === undefined ? undefined : minsAgo(mins),
    pending,
    uuid: `u${line}`,
    line,
    endLine: line + 1,
    label: promptLabel(text)!,
    branched: false,
  };
};

const conversation = (...prompts: Conversation['prompts']): Conversation => ({
  projectPath: '/home/me/dev/parser',
  sessionId: '0f1e2d3c-1111-2222-3333-444455556666',
  raw: '',
  prompts,
});

/** The list's lines, a prompt each. */
const listLines = (text: string) => text.split('\n').filter((l) => /^\*[A-Z]\* · /.test(l));

describe('renderPrompts', () => {
  it('keys each prompt by a letter, oldest first, with a button per letter', () => {
    const older = prompt('older one', 90);
    const newer = prompt('newer one', 30);
    const view = renderPrompts(conversation(older, newer), 15);
    expect(view.text.split('\n')).toEqual([
      '💬 *parser* — 2 prompts',
      '',
      '*A* · _1h ago_ — older one',
      '*B* · _30m ago_ — newer one',
      '',
      'Tap a letter to open that prompt\\.',
    ]);
    expect(view.keyboard).toEqual([[
      { text: 'A', callback_data: `prompts:o:0f1e2d3c:15:${older.uuid}` },
      { text: 'B', callback_data: `prompts:o:0f1e2d3c:15:${newer.uuid}` },
    ]]);
  });

  it('says it shows the last few when the conversation has more', () => {
    const view = renderPrompts(conversation(prompt('one', 3), prompt('two', 2), prompt('three', 1)), 2);
    expect(view.text).toMatch(/^💬 \*parser\* — last 2 prompts$/m);
    expect(listLines(view.text).map((l) => l.split(' — ')[1])).toEqual(['two', 'three']);
  });

  it('marks a prompt with no reply yet, and says what the mark means', () => {
    const view = renderPrompts(conversation(prompt('still running', 0, true)), 15);
    expect(view.text).toContain('*A* · _just now_ ⏳ — still running');
    expect(view.text).toContain('_⏳ no reply_');
  });

  it('marks a prompt another branch splits off at', () => {
    const split = { ...prompt('Split it', 5), branched: true };
    const view = renderPrompts(conversation(prompt('Plan the parser', 9), split), 15);
    expect(view.text).toContain('*B* · _5m ago_ 🌿 — Split it');
    expect(view.text).toContain('_🌿 a branch splits off here_');
  });

  it('escapes MarkdownV2 so a prompt full of punctuation still sends', () => {
    const view = renderPrompts(conversation(prompt('fix src/a-b.ts (the *bold* one!)', 5)), 15);
    expect(view.text).toContain('fix src/a\\-b\\.ts \\(the \\*bold\\* one\\!\\)');
  });

  it('collapses newlines so a multi-line prompt stays on one line', () => {
    const view = renderPrompts(conversation(prompt('first line\n\nsecond line', 5)), 15);
    expect(listLines(view.text)).toEqual(['*A* · _5m ago_ — first line second line']);
  });

  it('truncates a long prompt instead of dumping the paste', () => {
    const view = renderPrompts(conversation(prompt('x'.repeat(1000), 5)), 15);
    expect(view.text).toContain('…');
    expect(view.text.length).toBeLessThan(450);
  });

  it('keeps the end of a long prompt, where the question usually is', () => {
    const view = renderPrompts(conversation(prompt(`Plan the parser ${'and more detail '.repeat(30)}so what do you think?`, 5)), 15);
    expect(listLines(view.text)[0]).toMatch(/— Plan the parser and more detail .+ … .+ so what do you think\?$/);
  });

  it('falls back to a vague time when the log recorded none', () => {
    const view = renderPrompts(conversation(prompt('no timestamp')), 15);
    expect(view.text).toContain('*A* · _earlier_ — no timestamp');
  });

  it('drops the oldest prompts to fit one Telegram message and says so', () => {
    const many = Array.from({ length: 20 }, (_, i) => prompt(`prompt ${i} `.padEnd(300, 'x'), 20 - i));
    const view = renderPrompts(conversation(...many), 25);

    expect(view.text.length).toBeLessThan(4096);
    // The one you just sent survives; the oldest is what gets cut.
    expect(view.text).toContain('prompt 19');
    expect(view.text).not.toContain('prompt 0 ');
    expect(view.text).toMatch(/^💬 \*parser\* — last \d+ prompts \\\(\d+ older trimmed to fit\\\)$/m);
    // Lettered from the oldest that fit, with a button for each.
    expect(listLines(view.text)[0]).toMatch(/^\*A\* · /);
    expect(view.keyboard.flat()).toHaveLength(listLines(view.text).length);
  });
});

describe('summarizeUserPrompt', () => {
  // Copied from a real transcript: claude had already pulled both file paths
  // out into [Image #N] chips, which is why "Saved at:" and "  1." are bare.
  const recordedImageNote = [
    '[Image #1] [Image #2]User uploaded an image to the project.',
    'Saved at:',
    'Caption: "This is my last invoice from Groq. Costs went up — investigate."',
    'The image is attached as a vision input — you can see it directly.',
    'If the caption includes a question or request, answer it. Otherwise, describe what you see and ask if they want any analysis or edits.',
    'The user attached an image at:',
    '  1.',
    'Read it with the Read tool to see its contents.',
  ].join('\n');

  it('reduces a recorded image note to the caption the user typed', () => {
    expect(summarizeUserPrompt(recordedImageNote)).toBe(
      '📷 Image — This is my last invoice from Groq. Costs went up — investigate.');
  });

  it('keeps a multi-line caption whole', () => {
    const note = [
      'User uploaded an image to the project.',
      'Saved at: /home/rik/x.png',
      'Relative path: x.png',
      'Caption: "first line',
      'second line"',
      'The image is attached as a vision input — you can see it directly.',
    ].join('\n');
    expect(summarizeUserPrompt(note)).toBe('📷 Image — first line\nsecond line');
  });

  it('says only what it knows when there is no caption', () => {
    const note = [
      'User uploaded an image to the project.',
      'Saved at: /home/rik/x.png',
      'Caption: (none)',
      'The image is attached as a vision input — you can see it directly.',
    ].join('\n');
    expect(summarizeUserPrompt(note)).toBe('📷 Image');
  });

  it('names the file for a document upload', () => {
    const note = [
      'User uploaded a file: invoice.pdf',
      'Saved at: /home/rik/uploads/invoice.pdf',
      'Caption: "what am I paying for"',
      'Use the Read tool to read its contents. For PDFs use Read with `pages` for large files.',
    ].join('\n');
    expect(summarizeUserPrompt(note)).toBe('📎 invoice.pdf — what am I paying for');
  });

  it('leaves an ordinary prompt untouched', () => {
    expect(summarizeUserPrompt('fix the login bug')).toBe('fix the login bug');
  });

  it('leaves a prompt that merely quotes the note untouched', () => {
    const quoting = 'why does it say "User uploaded an image to the project." in /prompts?';
    expect(summarizeUserPrompt(quoting)).toBe(quoting);
  });

  it('shows the summary in the prompts list, not the scaffold', () => {
    const out = renderPrompts(conversation(prompt(recordedImageNote, 5)), 15).text;
    expect(out).toContain('📷 Image — This is my last invoice from Groq');
    expect(out).not.toContain('vision input');
    expect(out).not.toContain('Saved at');
  });
});

describe('promptLabel', () => {
  it('names a prompt by what the user asked', () => {
    expect(promptLabel('  Plan the\n parser ')).toBe('Plan the parser');
    expect(promptLabel('<pasted_content id="a43f">Build log:\nall green</pasted_content id="a43f">\n'))
      .toBe('Build log: all green');
    expect(promptLabel('- ok so could we refactor it')).toBe('ok so could we refactor it');
    expect(promptLabel('User uploaded an image to the project.\nSaved at: /x.png\nCaption: "this one"'))
      .toBe('📷 Image — this one');
  });

  it('prefers the words under a quoted reply to the quote', () => {
    expect(promptLabel('> The usual answer is hybrid search.\n\nIs that what he meant?')).toBe('Is that what he meant?');
    expect(promptLabel('> The usual answer is hybrid search.')).toBe('The usual answer is hybrid search.');
  });

  it('does not count a command as a turn', () => {
    expect(promptLabel('/compact')).toBeUndefined();
    expect(promptLabel('/model opus')).toBeUndefined();
    expect(promptLabel('<command-name>/compact</command-name> <command-message>compact</command-message>')).toBeUndefined();
    expect(promptLabel('<local-command-stdout>Compacted</local-command-stdout>')).toBeUndefined();
    expect(promptLabel('[Request interrupted by user]')).toBeUndefined();
    // A path is not a command.
    expect(promptLabel('/home/me/notes.md has the plan')).toBe('/home/me/notes.md has the plan');
  });
});

describe('cutLabel', () => {
  it('leaves a label that fits as it is', () => {
    expect(cutLabel('fix the login bug', 100)).toBe('fix the login bug');
    expect(cutLabel('x'.repeat(100), 100)).toBe('x'.repeat(100));
  });

  it('shows a longer one by its start and its end, cut between words', () => {
    const label = `Plan the parser first. ${'Then more detail. '.repeat(30)}So what do you think?`;
    expect(cutLabel(label, 100)).toBe('Plan the parser first. Then more detail. Then more detail. Then … detail. So what do you think?');
  });

  it('cuts a word too long to keep whole where the cut falls', () => {
    expect(cutLabel('x'.repeat(400), 100)).toBe(`${'x'.repeat(65)} … ${'x'.repeat(32)}`);
  });

  it('cuts by code point, so an emoji at either cut stays whole', () => {
    expect(cutLabel(`${'a'.repeat(64)}😀${'b'.repeat(100)}`, 100)).toBe(`${'a'.repeat(64)}😀 … ${'b'.repeat(32)}`);
    expect(cutLabel(`${'a'.repeat(100)}😀${'b'.repeat(31)}`, 100)).toBe(`${'a'.repeat(65)} … 😀${'b'.repeat(31)}`);
  });
});
