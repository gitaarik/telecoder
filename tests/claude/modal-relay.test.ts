import { describe, it, expect, vi } from 'vitest';
import type { Context } from 'grammy';
import { buildChoices, relayModal, type ModalPty } from '../../src/claude/modal-relay.js';
import { parseModal } from '../../src/claude/tui-modal.js';
import { resolvePendingQuestion } from '../../src/claude/ask-user.js';

const SEP = '─'.repeat(120);

/** Copied off a live pty. Unnumbered rows, cursor on the destructive one. */
const trustDialog = [
  SEP,
  ' Accessing workspace:',
  ' /home/rik/dev/plainpost',
  " Claude Code'll be able to read, edit, and execute files here.",
  ' ❯ No, exit',
  '   Yes, I trust this folder',
  ' Enter to confirm · Esc to cancel',
].join('\n');

/** The same dialog after one ArrowDown. */
const trustDialogOnSecond = trustDialog
  .replace(' ❯ No, exit', '   No, exit')
  .replace('   Yes, I trust this folder', ' ❯ Yes, I trust this folder');

const inputBox = [SEP, '❯ ', SEP, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n');

/**
 * A pty that moves its own cursor in response to arrow keys, the way claude's
 * dialogs do — so a test can tell a relay that verified the cursor from one
 * that merely hoped.
 */
function fakePty(screens: string[]): ModalPty & { written: string[] } {
  const written: string[] = [];
  let index = 0;
  return {
    written,
    write(data: string) {
      written.push(data);
      if (data === '\x1b[B' && index < screens.length - 1) index++;
      if (data === '\x1b[A' && index > 0) index--;
    },
    screen: () => screens[index],
  };
}

/** Captures what would be sent, and hands back the pending question's id. */
function fakeCtx(): { ctx: Context; sent: { text: string; keyboard?: string[][] }[] } {
  const sent: { text: string; keyboard?: string[][] }[] = [];
  const ctx = {
    chat: { id: 42 },
    api: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sendMessage: vi.fn(async (_chat: number, text: string, opts?: any) => {
        sent.push({
          text,
          keyboard: opts?.reply_markup?.inline_keyboard?.map(
            (row: { text: string; callback_data: string }[]) => row.map((b) => b.callback_data),
          ),
        });
      }),
    },
  } as unknown as Context;
  return { ctx, sent };
}

/** The pending-question id inside the first button's callback_data. */
function questionId(sent: { keyboard?: string[][] }[]): string {
  return sent[0].keyboard![0][0].split(':')[1];
}

describe('buildChoices', () => {
  it('offers the numbered rows plus the footer keys that answer', () => {
    const modal = parseModal([
      SEP,
      '  Select model',
      '  ❯ 1. Default (recommended)',
      '    2. Opus (1M context)',
      '  Enter to set as default · s to use this session only · Esc to cancel',
    ].join('\n'))!;
    expect(buildChoices(modal).map((c) => c.label)).toEqual([
      '1. Default (recommended)',
      '2. Opus (1M context)',
      's — use this session only',
      'Esc — cancel',
    ]);
  });

  it('drops Enter when rows exist, since picking a row already presses it', () => {
    // The regression this guards: with no rows parsed, the only button was
    // "Enter — confirm", and confirming the trust dialog exits claude.
    const modal = parseModal(trustDialog)!;
    expect(buildChoices(modal).map((c) => c.label)).toEqual([
      'No, exit',
      'Yes, I trust this folder',
      'Esc — cancel',
    ]);
  });

  it('keeps Enter when the dialog has no rows to pick', () => {
    const modal = parseModal([
      SEP, '  Background', '  No tasks currently running',
      '  ↑/↓ to select · Enter to view · Esc to close',
    ].join('\n'))!;
    expect(buildChoices(modal).map((c) => c.label)).toEqual(['Enter — view', 'Esc — close']);
  });

  it('never offers navigation keys, which answer nothing', () => {
    const modal = parseModal([
      SEP, '  Settings', '  Type to filter · Enter/↓ to select · ↑ to tabs · Esc to clear',
    ].join('\n'))!;
    expect(buildChoices(modal).every((c) => !c.label.startsWith('↑'))).toBe(true);
  });
});

describe('relayModal', () => {
  it('walks to the chosen row and commits once the cursor lands', async () => {
    const pty = fakePty([trustDialog, trustDialogOnSecond]);
    const { ctx, sent } = fakeCtx();

    const pending = relayModal(pty, '42', ctx, '/home/rik/dev/plainpost');
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    resolvePendingQuestion(questionId(sent), 1); // "Yes, I trust this folder"

    expect(await pending).toEqual({ kind: 'answered', label: 'Yes, I trust this folder' });
    expect(pty.written).toEqual(['\x1b[B', '\r']);
  });

  it('presses a footer key directly, with no arrows', async () => {
    const pty = fakePty([trustDialog]);
    const { ctx, sent } = fakeCtx();

    const pending = relayModal(pty, '42', ctx, '/tmp/x');
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    resolvePendingQuestion(questionId(sent), 2); // "Esc — cancel"

    expect(await pending).toEqual({ kind: 'answered', label: 'Esc — cancel' });
    expect(pty.written).toEqual(['\x1b']);
  });

  it('refuses to commit when the cursor does not land where it was sent', async () => {
    // A dialog that ignores arrow keys: every read shows the cursor on row 1.
    const pty = fakePty([trustDialog]);
    const { ctx, sent } = fakeCtx();

    const pending = relayModal(pty, '42', ctx, '/tmp/x');
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    resolvePendingQuestion(questionId(sent), 1); // ask for row 2

    const outcome = await pending;
    expect(outcome.kind).toBe('failed');
    // The point of the whole exercise: no Enter followed the failed walk.
    expect(pty.written).not.toContain('\r');
  });

  it('presses nothing when the question times out', async () => {
    const pty = fakePty([trustDialog]);
    const { ctx, sent } = fakeCtx();

    const pending = relayModal(pty, '42', ctx, '/tmp/x');
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    resolvePendingQuestion(questionId(sent), 99); // out of range → resolves null

    expect(await pending).toEqual({ kind: 'timeout' });
    expect(pty.written).toEqual([]);
  });

  it('presses nothing when the user leaves it alone', async () => {
    const pty = fakePty([trustDialog]);
    const { ctx, sent } = fakeCtx();

    const pending = relayModal(pty, '42', ctx, '/tmp/x');
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    resolvePendingQuestion(questionId(sent), 3); // the trailing "Leave it alone"

    expect((await pending).kind).toBe('declined');
    expect(pty.written).toEqual([]);
  });

  it('relays an unparseable screen as text, with no buttons and no keys', async () => {
    const pty = fakePty([inputBox]);
    const { ctx, sent } = fakeCtx();

    expect((await relayModal(pty, '42', ctx, '/tmp/x')).kind).toBe('declined');
    expect(pty.written).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it('shows claude\'s own dialog text in the message', async () => {
    const pty = fakePty([trustDialog]);
    const { ctx, sent } = fakeCtx();

    const pending = relayModal(pty, '42', ctx, '/home/rik/dev/plainpost');
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].text).toContain('Yes, I trust this folder');
    expect(sent[0].text).toContain('/home/rik/dev/plainpost');

    resolvePendingQuestion(questionId(sent), 3);
    await pending;
  });
});
