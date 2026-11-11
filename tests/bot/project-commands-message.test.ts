import { describe, it, expect } from 'vitest';
import type { MessageEntity } from 'grammy/types';
import { buildProjectCommandsMessage } from '../../src/bot/handlers/command.handler.js';
import type { EntityMessage } from '../../src/telegram/entities.js';

/** The text each entity of `type` covers, in order. */
function spans(msg: EntityMessage, type: MessageEntity['type']): string[] {
  return msg.entities
    .filter((e) => e.type === type)
    .map((e) => msg.text.slice(e.offset, e.offset + e.length));
}

/**
 * Telegram refuses a whole message over an entity that runs off the end of the
 * text or covers nothing, which no amount of local typechecking catches.
 */
function assertEntitiesInBounds(msg: EntityMessage): void {
  for (const e of msg.entities) {
    expect(e.length, `empty ${e.type} entity`).toBeGreaterThan(0);
    expect(e.offset + e.length, `${e.type} entity past the end`).toBeLessThanOrEqual(msg.text.length);
  }
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
    expect(spans(msg, 'code')).toContain('/code-review');
    expect(spans(msg, 'bold')).toContain('Skills:');
    expect(spans(msg, 'bold')).toContain('Shadowed by TeleCoder');
    // Shadowed names appear only under the warning, never as passthrough.
    const [passthroughPart, shadowedPart] = msg.text.split('Shadowed by TeleCoder');
    expect(passthroughPart).not.toContain('/loop');
    expect(shadowedPart).toContain('/loop');
    expect(shadowedPart).toContain('/clear');
  });

  it('sends names and descriptions verbatim, with no parse mode to escape for', () => {
    const msg = buildProjectCommandsMessage({
      directory: 'my.project-dir',
      projectCommands: [
        { name: 'deploy-prod', description: 'Ship it (carefully!)' },
        { name: 'lint', description: '' },
      ],
      snapshot: SNAPSHOT,
      botCommandNames: BOT_NAMES,
    });
    assertEntitiesInBounds(msg);
    expect(msg.text).not.toContain('\\');
    expect(spans(msg, 'code')).toEqual(expect.arrayContaining(['my.project-dir', '/deploy-prod', '/lint']));
    expect(msg.text).toContain('• /deploy-prod — Ship it (carefully!)');
    expect(msg.text).toContain('• /lint\n');
  });

  it('still says how to add project commands when the command list is unavailable', () => {
    const msg = buildProjectCommandsMessage({
      directory: 'telecoder',
      projectCommands: [],
      snapshot: undefined,
      botCommandNames: BOT_NAMES,
    });
    assertEntitiesInBounds(msg);
    expect(spans(msg, 'italic')).toEqual(["Claude Code's own command list is unavailable right now."]);
    expect(spans(msg, 'code')).toContain('.claude/commands/');
    expect(msg.entities).toContainEqual(expect.objectContaining({
      type: 'text_link',
      url: 'https://docs.claude.com/en/docs/claude-code/slash-commands',
    }));
  });

  it('separates plugin commands from built-ins', () => {
    const msg = buildProjectCommandsMessage({
      directory: 'telecoder',
      projectCommands: [],
      snapshot: SNAPSHOT,
      botCommandNames: new Set<string>(),
    });
    assertEntitiesInBounds(msg);
    expect(spans(msg, 'bold')).toEqual(expect.arrayContaining(['Plugin:', 'Built-in:']));
    expect(spans(msg, 'code')).toContain('/ctx:doctor');
  });

  it('drops whole lines rather than cutting one when over budget', () => {
    const many = Array.from({ length: 400 }, (_, i) => `command-number-${i}`);
    const msg = buildProjectCommandsMessage({
      directory: 'telecoder',
      projectCommands: [],
      snapshot: { slashCommands: many, skills: many, recordedAtMs: Date.now() },
      botCommandNames: new Set<string>(),
    });
    expect(msg.text.length).toBeLessThanOrEqual(3900);
    expect(msg.text.endsWith('…list truncated.')).toBe(true);
    expect(spans(msg, 'italic')).toContain('…list truncated.');
    assertEntitiesInBounds(msg);
  });
});
