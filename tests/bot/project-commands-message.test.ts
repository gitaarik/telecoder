import { describe, it, expect } from 'vitest';
import { buildProjectCommandsMessage } from '../../src/bot/handlers/command.handler.js';

/**
 * A MarkdownV2 message that breaks these rules is rejected by Telegram with a
 * 400 at send time, which no amount of local typechecking catches. The checks
 * mirror the Bot API rules for the constructs this message actually uses:
 * code spans, bold, italic and one link.
 */
function assertValidMarkdownV2(text: string): void {
  // Backticks delimit code spans and must pair up. Counting via regex rather
  // than by index: the message contains emoji, whose surrogate pairs make
  // array positions and string positions disagree.
  const ticks = text.match(/(?<!\\)`/g)?.length ?? 0;
  expect(ticks % 2, `unbalanced backticks in:\n${text}`).toBe(0);

  const segments = text.split(/(?<!\\)`/);
  segments.forEach((segment, i) => {
    if (i % 2 === 1) {
      // Inside a code span a backslash is literal, so an escape here would
      // render as a visible backslash.
      expect(segment.includes('\\'), `stray backslash in code span: ${segment}`).toBe(false);
      return;
    }
    // Outside code spans every reserved character must be escaped. `*` and `_`
    // are formatting markers here, and `[` `]` `(` `)` appear in the one link.
    const withoutLinks = segment.replace(/\[[^\]]*\]\([^)]*\)/g, '');
    const unescaped = withoutLinks.match(/(?<!\\)[.\-!+=|{}~>#()[\]]/g) ?? [];
    expect(unescaped, `unescaped specials in: ${segment}`).toEqual([]);

    // Bold and italic markers must pair within the non-code text.
    const stars = segment.match(/(?<!\\)\*/g)?.length ?? 0;
    expect(stars % 2, `unbalanced bold markers in: ${segment}`).toBe(0);
  });
}

const SNAPSHOT = {
  slashCommands: ['code-review', 'security-review', 'clear', 'loop', 'ctx:doctor', 'compact'],
  skills: ['code-review', 'loop'],
  recordedAtMs: Date.now(),
};

const BOT_NAMES = new Set(['loop', 'clear', 'compact']);

describe('buildProjectCommandsMessage', () => {
  it('lists passthrough commands and names the shadowed ones separately', () => {
    const msg = buildProjectCommandsMessage({
      directory: 'telecoder',
      projectCommands: [],
      snapshot: SNAPSHOT,
      botCommandNames: BOT_NAMES,
    });
    expect(msg).toContain('`/code-review`');
    expect(msg).toContain('Skills');
    expect(msg).toContain('Shadowed by TeleCoder');
    // Shadowed names appear only under the warning, never as passthrough.
    const [passthroughPart, shadowedPart] = msg.split('Shadowed by TeleCoder');
    expect(passthroughPart).not.toContain('/loop');
    expect(shadowedPart).toContain('/loop');
    expect(shadowedPart).toContain('/clear');
  });

  it('leaves hyphenated command names unescaped inside code spans', () => {
    const msg = buildProjectCommandsMessage({
      directory: 'telecoder',
      projectCommands: [],
      snapshot: SNAPSHOT,
      botCommandNames: new Set<string>(),
    });
    expect(msg).toContain('`/code-review`');
    expect(msg).not.toContain('code\\-review');
  });

  it('produces valid MarkdownV2 with project commands, plugins and shadowing', () => {
    const msg = buildProjectCommandsMessage({
      directory: 'my.project-dir',
      projectCommands: [
        { name: 'deploy-prod', description: 'Ship it (carefully!)' },
        { name: 'lint', description: '' },
      ],
      snapshot: SNAPSHOT,
      botCommandNames: BOT_NAMES,
    });
    assertValidMarkdownV2(msg);
    expect(msg).toContain('`/deploy-prod`');
    expect(msg).toContain('Ship it \\(carefully\\!\\)');
  });

  it('produces valid MarkdownV2 when the command list is unavailable', () => {
    const msg = buildProjectCommandsMessage({
      directory: 'telecoder',
      projectCommands: [],
      snapshot: undefined,
      botCommandNames: BOT_NAMES,
    });
    assertValidMarkdownV2(msg);
    expect(msg).toContain('unavailable');
    // Still tells the user how to add project commands.
    expect(msg).toContain('.claude/commands/');
  });

  it('separates plugin commands from built-ins', () => {
    const msg = buildProjectCommandsMessage({
      directory: 'telecoder',
      projectCommands: [],
      snapshot: SNAPSHOT,
      botCommandNames: new Set<string>(),
    });
    assertValidMarkdownV2(msg);
    expect(msg).toContain('Plugin');
    expect(msg).toContain('`/ctx:doctor`');
    expect(msg).toContain('Built\\-in');
  });

  it('drops whole lines rather than cutting one mid-escape when over budget', () => {
    const many = Array.from({ length: 400 }, (_, i) => `command-number-${i}`);
    const msg = buildProjectCommandsMessage({
      directory: 'telecoder',
      projectCommands: [],
      snapshot: { slashCommands: many, skills: many, recordedAtMs: Date.now() },
      botCommandNames: new Set<string>(),
    });
    expect(Buffer.byteLength(msg, 'utf8')).toBeLessThanOrEqual(3900);
    assertValidMarkdownV2(msg);
  });
});
