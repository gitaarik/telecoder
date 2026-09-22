import { describe, it, expect, vi } from 'vitest';

let siblings: Array<{ name: string; botId: string }> = [];

vi.mock('../../src/utils/instances.js', () => ({
  listSiblingBots: () => siblings,
  findBotById: () => undefined,
}));

const { buildTargetPicker } = await import('../../src/bot/handlers/fork.handler.js');
const { BOT_ID } = await import('../../src/config.js');

// BOT_NAME is pinned to 'TeleCoder' by the vitest env, BOT_ID falls back to
// the default instance id.
describe('buildTargetPicker', () => {
  it('writes every target into the body, keyed by letter', () => {
    siblings = [{ name: 'Research bot', botId: 'b2' }];
    const { lines } = buildTargetPicker(42);
    expect(lines).toEqual([
      'A\\. 🌱 New branch here — TeleCoder',
      'B\\. Research bot',
    ]);
  });

  it('points each button at the target named on the same letter', () => {
    siblings = [
      { name: 'A sibling whose name runs well past a button', botId: 'b2' },
      { name: 'Research bot', botId: 'b3' },
    ];
    const { keyboard } = buildTargetPicker(42);
    expect(keyboard).toEqual([
      [
        { text: 'A', callback_data: `fork:to:${BOT_ID}:42` },
        { text: 'B', callback_data: 'fork:to:b2:42' },
        { text: 'C', callback_data: 'fork:to:b3:42' },
      ],
      [{ text: 'Cancel', callback_data: 'fork:cancel' }],
    ]);
  });

  it('keeps short names on their buttons, with Cancel on its own row', () => {
    siblings = [{ name: 'Scout', botId: 'b2' }];
    const { keyboard } = buildTargetPicker(7);
    expect(keyboard).toEqual([
      [{ text: 'A · 🌱 New branch here', callback_data: `fork:to:${BOT_ID}:7` }],
      [{ text: 'B · Scout', callback_data: 'fork:to:b2:7' }],
      [{ text: 'Cancel', callback_data: 'fork:cancel' }],
    ]);
  });

  it('offers this bot even with no siblings configured', () => {
    siblings = [];
    const { lines, keyboard } = buildTargetPicker(1);
    expect(lines).toHaveLength(1);
    expect(keyboard).toEqual([
      [{ text: 'A · 🌱 New branch here', callback_data: `fork:to:${BOT_ID}:1` }],
      [{ text: 'Cancel', callback_data: 'fork:cancel' }],
    ]);
  });
});
