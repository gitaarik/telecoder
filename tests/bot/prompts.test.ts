import { describe, it, expect } from 'vitest';
import { buildPromptsMessage, promptLabel, summarizeUserPrompt } from '../../src/bot/handlers/command/session.js';
import type { UserPrompt } from '../../src/claude/session-jsonl.js';

const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const prompt = (text: string, mins: number, pending = false): UserPrompt => ({
  text,
  timestamp: minsAgo(mins),
  pending,
});

describe('buildPromptsMessage', () => {
  it('lists one line per prompt, oldest first', () => {
    const out = buildPromptsMessage([prompt('older one', 90), prompt('newer one', 30)]);
    expect(out.split('\n')).toEqual([
      '💬 *Prompts* — last 2',
      '',
      '• _1h ago_ — older one',
      '• _30m ago_ — newer one',
    ]);
  });

  it('marks a prompt with no reply yet', () => {
    const out = buildPromptsMessage([prompt('still running', 0, true)]);
    expect(out).toContain('• _just now_ ⏳ — still running');
  });

  it('escapes MarkdownV2 so a prompt full of punctuation still sends', () => {
    const out = buildPromptsMessage([prompt('fix src/a-b.ts (the *bold* one!)', 5)]);
    expect(out).toContain('fix src/a\\-b\\.ts \\(the \\*bold\\* one\\!\\)');
  });

  it('collapses newlines so a multi-line prompt stays on one line', () => {
    const out = buildPromptsMessage([prompt('first line\n\nsecond line', 5)]);
    expect(out.split('\n').filter((l) => l.startsWith('•'))).toHaveLength(1);
    expect(out).toContain('first line second line');
  });

  it('truncates a long prompt instead of dumping the paste', () => {
    const out = buildPromptsMessage([prompt('x'.repeat(1000), 5)]);
    expect(out).toContain('…');
    expect(out.length).toBeLessThan(400);
  });

  it('falls back to a vague time when the log recorded none', () => {
    const out = buildPromptsMessage([{ text: 'no timestamp', pending: false }]);
    expect(out).toContain('• _earlier_ — no timestamp');
  });

  it('drops the oldest prompts to fit one Telegram message and says so', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      prompt(`prompt ${i} `.padEnd(300, 'x'), 20 - i),
    );
    const out = buildPromptsMessage(many);

    expect(out.length).toBeLessThan(4096);
    // The one you just sent survives; the oldest is what gets cut.
    expect(out).toContain('prompt 19');
    expect(out).not.toContain('prompt 0 ');
    expect(out).toMatch(/^💬 \*Prompts\* — last \d+ \\\(\d+ older trimmed to fit\\\)$/m);
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
    const out = buildPromptsMessage([prompt(recordedImageNote, 5)]);
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
