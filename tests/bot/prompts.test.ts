import { describe, it, expect } from 'vitest';
import { buildPromptsMessage } from '../../src/bot/handlers/command/session.js';
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
