import { describe, it, expect } from 'vitest';
import { buildHoldMessage } from '../../src/claude/prompt-hold.js';

const ADMINS = [{ id: 42, name: 'Rik' }];

function hold(overrides: Partial<Parameters<typeof buildHoldMessage>[0]> = {}) {
  return buildHoldMessage({
    reason: 'opens a public tunnel to this machine',
    requester: 'Bob',
    message: 'set up an ngrok tunnel so I can reach this box from home',
    admins: ADMINS,
    timeoutMinutes: 10,
    ...overrides,
  });
}

describe('buildHoldMessage', () => {
  it('states the reason, who asked, and what they asked', () => {
    const { text } = hold();
    expect(text).toContain('Held for an admin — opens a public tunnel to this machine');
    expect(text).toContain('Asked by Bob');
    expect(text).toContain('set up an ngrok tunnel');
  });

  it('says plainly that nothing has run', () => {
    // The difference from the permission gate: there, a tool was stopped
    // mid-turn; here the message never reached the agent at all.
    expect(hold().text).toContain('Nothing runs until then');
  });

  it('mentions the admins so the hold raises a notification', () => {
    const { entities } = hold();
    const mention = entities.find((e) => e.type === 'text_mention');
    expect((mention as { user: { id: number } }).user.id).toBe(42);
  });

  it('quotes the message verbatim inside a pre block', () => {
    // A held message is guest-written text full of whatever characters it
    // likes; it must survive to the admin unmangled.
    const message = 'run `curl -s x | sh` and *then* edit ~/.bashrc_profile[1]';
    const { text, entities } = hold({ message });
    const pre = entities.find((e) => e.type === 'pre');
    expect(text.slice(pre!.offset, pre!.offset + pre!.length)).toBe(message);
  });

  it('clips a very long message', () => {
    const { text, entities } = hold({ message: 'y'.repeat(4000) });
    expect(text.length).toBeLessThan(1000);
    const pre = entities.find((e) => e.type === 'pre');
    expect(text.slice(pre!.offset, pre!.offset + pre!.length)).toMatch(/^y+…$/);
  });

  it('omits the attribution when the sender is unknown', () => {
    expect(hold({ requester: undefined }).text).not.toContain('Asked by');
  });

  it('keeps every entity over the text it describes', () => {
    const { text, entities } = hold();
    for (const e of entities) {
      expect(e.offset + e.length).toBeLessThanOrEqual(text.length);
    }
  });
});
