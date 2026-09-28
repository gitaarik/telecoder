import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Context } from 'grammy';
import type { MessageEntity } from 'grammy/types';
import {
  blockingModal, buildChoices, buildModalMessage, openDialogError, relayModal, type ModalPty, type OpenDialog,
} from '../../src/claude/modal-relay.js';
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
 * WebFetch's permission prompt off a live 2.1.284 pty, with the cursor on
 * `row`. It has no footer; its last row is where it ends.
 */
function fetchDialogAt(row: number): string {
  const rows = [
    '1. Yes',
    "2. Yes, and don't ask again for example.com",
    '3. No, and tell Claude what to do differently (esc)',
  ].map((text, i) => `${i === row ? ' ❯ ' : '   '}${text}`);
  return [
    SEP,
    ' Fetch',
    '',
    '   url: https://example.com/',
    '   prompt: What is the title of this page?',
    '   Claude wants to fetch content from example.com',
    '',
    ' Do you want to allow Claude to fetch this content?',
    ...rows,
  ].join('\n');
}

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

/**
 * Captures what would be sent and edited. Messages are numbered from 1 in the
 * order they go out, which is what `edits` refers back to. `refuseEntities`
 * makes the fake Telegram 400 any send that carries formatting.
 */
function fakeCtx({ refuseEntities = false } = {}): {
  ctx: Context;
  sent: { text: string; keyboard?: string[][]; entities?: MessageEntity[] }[];
  edits: { messageId: number; text: string; entities?: MessageEntity[] }[];
} {
  const sent: { text: string; keyboard?: string[][]; entities?: MessageEntity[] }[] = [];
  const edits: { messageId: number; text: string; entities?: MessageEntity[] }[] = [];
  const ctx = {
    chat: { id: 42 },
    api: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sendMessage: vi.fn(async (chat: number, text: string, opts?: any) => {
        if (refuseEntities && opts?.entities) throw new Error("Bad Request: can't parse entities");
        sent.push({
          text,
          keyboard: opts?.reply_markup?.inline_keyboard?.map(
            (row: { text: string; callback_data: string }[]) => row.map((b) => b.callback_data),
          ),
          entities: opts?.entities,
        });
        return { message_id: sent.length, chat: { id: chat } };
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      editMessageText: vi.fn(async (_chat: number, messageId: number, text: string, opts?: any) => {
        edits.push({ messageId, text, entities: opts?.entities });
        return true;
      }),
      editMessageReplyMarkup: vi.fn(async () => true),
    },
  } as unknown as Context;
  return { ctx, sent, edits };
}

/** The pending-question id inside the first button's callback_data. */
function questionId(sent: { keyboard?: string[][] }[]): string {
  return sent[0].keyboard![0][0].split(':')[1];
}

/**
 * Claude's own permission prompt, copied verbatim off a live pty running in
 * manual mode. This is the dialog that made the mid-turn relay necessary: it
 * opens two tool calls into a turn, with nobody holding the arguments that
 * would say where to ask about it, and until the end-of-turn check learned to
 * look for it the turn simply sat here until the hard ceiling — two hours, by
 * default.
 *
 * Note where the rows stop. `Do you want to proceed?` is indented one column
 * and the rows three, so the walk out from the cursor fences on it; the tip
 * and the command preview above are never reached.
 */
const permissionPrompt = [
  '❯ Use the Bash tool to run: touch probe.txt',
  "● I'll run that command.",
  '● Bash(touch probe.txt)',
  '  ⎿  Waiting…',
  SEP,
  ' Bash command',
  ' Tip: auto mode handles these prompts for you — choose "switch to auto mode" below',
  '   touch probe.txt',
  '   Create an empty probe.txt file',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. Yes, and always allow access to /tmp/tc-perm-tIf6Th from this project',
  '   3. Yes, and switch to auto mode · auto mode handles these prompts for you',
  '   4. No',
  ' Esc to cancel · Tab to amend',
].join('\n');

/**
 * An ordinary turn in progress. Claude draws its input box for the whole of
 * one — measured at 300 samples across a live multi-tool turn, it was present
 * on every single one — which is what makes the box's absence a safe signal
 * that something is blocking. A false positive here interrupts healthy work.
 */
const working = [
  '● Bash(touch probe.txt)',
  '  ⎿  Done',
  '✶ Percolating… (29s)',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ← for agents     ● high · /effort',
].join('\n');

describe('blockingModal', () => {
  it('sees claude\'s permission prompt, which opens mid-turn', () => {
    const modal = blockingModal(permissionPrompt);
    expect(modal?.title).toBe('Bash command');
    expect(modal?.options.map((o) => o.label)).toEqual([
      'Yes',
      'Yes, and always allow access to /tmp/tc-perm-tI…',
      'Yes, and switch to auto mode · auto mode handle…',
      'No',
    ]);
    expect(modal?.highlighted).toBe(0);
  });

  it('offers every row plus the footer keys that answer it', () => {
    // Not `Tab to amend`: that opens a text field on the highlighted row, so
    // pressing it left the dialog up and failed the turn.
    expect(buildChoices(blockingModal(permissionPrompt)!).map((c) => c.label)).toEqual([
      '1. Yes',
      '2. Yes, and always allow access to /tmp/tc-perm-tI…',
      '3. Yes, and switch to auto mode · auto mode handle…',
      '4. No',
      'Esc — cancel',
    ]);
  });

  it('is null while a turn is merely working, where the box is still drawn', () => {
    // The expensive mistake in the other direction: relaying this would
    // interrupt a turn that was going perfectly well.
    expect(blockingModal(working)).toBeNull();
  });

  it('is null on an idle input box', () => {
    expect(blockingModal(inputBox)).toBeNull();
  });

  it('is null on a half-drawn screen it cannot read as a dialog', () => {
    expect(blockingModal('● Loading conversation…')).toBeNull();
  });

  it('sees WebFetch\'s prompt, which has no footer to find it by', () => {
    // Missed, it sat mid-turn until the hard ceiling with nobody asked.
    expect(blockingModal(fetchDialogAt(0))?.options).toHaveLength(3);
  });
});

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
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('answers a footerless dialog the same way, walking to the row first', async () => {
    const pty = fakePty([fetchDialogAt(0), fetchDialogAt(1), fetchDialogAt(2)]);
    const { ctx, sent } = fakeCtx();

    const pending = relayModal(pty, '42', ctx, '/tmp/x', 'mid-turn');
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    // Its rows and nothing else: with no footer, no key is named to offer.
    expect(sent[0].keyboard).toHaveLength(4);
    resolvePendingQuestion(questionId(sent), 1); // "Yes, and don't ask again"

    expect(await pending).toEqual({ kind: 'answered', label: "2. Yes, and don't ask again for example.com" });
    expect(pty.written).toEqual(['\x1b[B', '\r']);
  });

  it('walks to the chosen row and commits once the cursor lands', async () => {
    const pty = fakePty([trustDialog, trustDialogOnSecond]);
    const { ctx, sent } = fakeCtx();

    const pending = relayModal(pty, '42', ctx, '/home/rik/dev/plainpost', 'before-prompt');
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    resolvePendingQuestion(questionId(sent), 1); // "Yes, I trust this folder"

    expect(await pending).toEqual({ kind: 'answered', label: 'Yes, I trust this folder' });
    expect(pty.written).toEqual(['\x1b[B', '\r']);
  });

  it('presses a footer key directly, with no arrows', async () => {
    const pty = fakePty([trustDialog]);
    const { ctx, sent } = fakeCtx();

    const pending = relayModal(pty, '42', ctx, '/tmp/x', 'before-prompt');
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    resolvePendingQuestion(questionId(sent), 2); // "Esc — cancel"

    expect(await pending).toEqual({ kind: 'answered', label: 'Esc — cancel' });
    expect(pty.written).toEqual(['\x1b']);
  });

  it('refuses to commit when the cursor does not land where it was sent', async () => {
    // A dialog that ignores arrow keys: every read shows the cursor on row 1.
    const pty = fakePty([trustDialog]);
    const { ctx, sent } = fakeCtx();

    const pending = relayModal(pty, '42', ctx, '/tmp/x', 'before-prompt');
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

    const pending = relayModal(pty, '42', ctx, '/tmp/x', 'before-prompt');
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    resolvePendingQuestion(questionId(sent), 99); // out of range → resolves null

    expect(await pending).toEqual({ kind: 'timeout' });
    expect(pty.written).toEqual([]);
  });

  it('closes the question when nobody answers in time', async () => {
    // Left up, its buttons would look live while nothing was waiting on them
    // any more: a tap on one would only get the "expired" toast.
    vi.useFakeTimers();
    const pty = fakePty([trustDialog]);
    const { ctx, sent, edits } = fakeCtx();

    const pending = relayModal(pty, '42', ctx, '/tmp/x', 'before-prompt');
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

    expect(await pending).toEqual({ kind: 'timeout' });
    expect(pty.written).toEqual([]);
    // With the entities it went out with — an edit without them would strip
    // the dialog back to plain text just as it closes.
    expect(sent[0].entities?.length).toBeGreaterThan(0);
    expect(edits).toEqual([{
      messageId: 1,
      text: `${sent[0].text}\n\n⏱️ No answer within 10 min, so I left the dialog alone.`,
      entities: sent[0].entities,
    }]);
  });

  it('presses nothing when the user leaves it alone', async () => {
    const pty = fakePty([trustDialog]);
    const { ctx, sent } = fakeCtx();

    const pending = relayModal(pty, '42', ctx, '/tmp/x', 'before-prompt');
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    resolvePendingQuestion(questionId(sent), 3); // the trailing "Leave it alone"

    expect((await pending).kind).toBe('declined');
    expect(pty.written).toEqual([]);
  });

  it('relays an unparseable screen as text, with no buttons and no keys', async () => {
    const pty = fakePty([inputBox]);
    const { ctx, sent } = fakeCtx();

    expect((await relayModal(pty, '42', ctx, '/tmp/x', 'before-prompt')).kind).toBe('declined');
    expect(pty.written).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it('shows claude\'s own dialog text in the message', async () => {
    const pty = fakePty([trustDialog]);
    const { ctx, sent } = fakeCtx();

    const pending = relayModal(pty, '42', ctx, '/home/rik/dev/plainpost', 'before-prompt');
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].text).toContain('Yes, I trust this folder');
    expect(sent[0].text).toContain('/home/rik/dev/plainpost');

    resolvePendingQuestion(questionId(sent), 3);
    await pending;
  });

  it('sends the dialog plain when Telegram refuses its formatting, buttons and all', async () => {
    // Without the buttons there is no answering the dialog from the chat, so
    // formatting is the thing to give up.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pty = fakePty([trustDialog]);
    const { ctx, sent } = fakeCtx({ refuseEntities: true });

    const pending = relayModal(pty, '42', ctx, '/tmp/x', 'before-prompt');
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].entities).toBeUndefined();
    expect(sent[0].keyboard).toHaveLength(4);

    resolvePendingQuestion(questionId(sent), 3);
    await pending;
  });
});

/**
 * A Bash prompt off a live pty running claude 2.1.284, blank rows and all.
 * The shape that used to reach the chat as a wall of gutters and cursor glyphs.
 */
const bashPrompt = [
  SEP,
  ' Bash command',
  '',
  "   │ cd /tmp/tc-probe && python3 - <<'EOF'",
  '   │ import json',
  "   │ r = json.load(open('record.json'))",
  "   │ print({k: v for k, v in r.items() if k != 'skip'})",
  '   │ EOF',
  "   │ git log -1 --format='%h %s' -- record.json",
  '   Count the entries in the probe record',
  '',
  ' Contains brace with quote character (expansion obfuscation)',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. No',
  '',
  ' Esc to cancel · Tab to amend',
].join('\n');

/** Each entity as the text it covers, so an assertion reads like the message. */
function styled(message: { text: string; entities: MessageEntity[] }): [string, string][] {
  return message.entities.map((e) => [e.type, message.text.slice(e.offset, e.offset + e.length)]);
}

describe('openDialogError', () => {
  const open: OpenDialog[] = [
    { kind: 'timeout' },
    { kind: 'declined', why: 'you chose to leave it alone' },
    { kind: 'failed', why: 'the cursor stopped on option 1, not 2' },
    { kind: 'still-open', label: '1. Yes' },
  ];

  it('says the message wasn\'t delivered only before it was', () => {
    // Mid-turn it went in long before the dialog opened; saying otherwise
    // sent people off to resend a message claude already had.
    for (const dialog of open) {
      expect(openDialogError(dialog, 'before-prompt'), dialog.kind).toMatch(/your message wasn't delivered/i);
      expect(openDialogError(dialog, 'mid-turn'), dialog.kind).not.toContain('delivered');
      expect(openDialogError(dialog, 'mid-turn'), dialog.kind).toContain('stopped waiting on this turn');
    }
  });

  it('keeps the reason a relay gave up', () => {
    expect(openDialogError(open[1], 'mid-turn'))
      .toBe('I stopped waiting on this turn — you chose to leave it alone. Claude Code is still paused on that dialog.');
  });

  it('points a dialog left open mid-turn at the next message, which offers it again', () => {
    expect(openDialogError({ kind: 'timeout' }, 'mid-turn')).toMatch(/next message, which brings its buttons back\.$/);
    expect(openDialogError({ kind: 'still-open', label: '1. Yes' }, 'mid-turn'))
      .toBe('I pressed "1. Yes", but Claude Code\'s dialog is still open, so I stopped waiting on this turn. '
        + 'Your next message brings its buttons back.');
  });
});

describe('buildModalMessage', () => {
  it('lays a Bash prompt out for a phone', () => {
    const message = buildModalMessage(parseModal(bashPrompt)!, '/tmp/tc-probe', 'mid-turn');
    const command = [
      "cd /tmp/tc-probe && python3 - <<'EOF'",
      'import json',
      "r = json.load(open('record.json'))",
      "print({k: v for k, v in r.items() if k != 'skip'})",
      'EOF',
      "git log -1 --format='%h %s' -- record.json",
    ].join('\n');

    expect(message.text).toBe([
      '⌨️ Claude Code needs an answer',
      'Project: tc-probe',
      '',
      'Bash command',
      '',
      command,
      'Count the entries in the probe record',
      '',
      'Contains brace with quote character (expansion obfuscation)',
      '',
      'Do you want to proceed?',
      '1. Yes',
      '2. No',
      '',
      "Tap your answer and I'll press it in Claude Code so it can carry on.",
    ].join('\n'));
    expect(styled(message)).toEqual([
      ['bold', 'Claude Code needs an answer'],
      ['bold', 'tc-probe'],
      ['bold', 'Bash command'],
      ['pre', command],
      ['bold', 'Do you want to proceed?'],
      ['italic', "Tap your answer and I'll press it in Claude Code so it can carry on."],
    ]);
  });

  it('leaves no cursor glyph, gutter or diff fence in the chat', () => {
    const edit = parseModal([
      SEP, ' Edit file', ' notes.txt', '╌'.repeat(120), ' 1  hello', ' 2 -world', ' 2 +there', '╌'.repeat(120),
      ' Do you want to make this edit to notes.txt?', ' ❯ 1. Yes', '   2. No', ' Esc to cancel · Tab to amend',
    ].join('\n'))!;
    for (const modal of [parseModal(bashPrompt)!, edit, parseModal(trustDialog)!, parseModal(permissionPrompt)!]) {
      expect(buildModalMessage(modal, '/tmp/x', 'mid-turn').text).not.toMatch(/[❯│╌─]/);
    }
    expect(styled(buildModalMessage(edit, '/tmp/x', 'mid-turn'))).toContainEqual(['pre', '1  hello\n2 -world\n2 +there']);
  });

  it('writes out in full each row its button clips, keyed by the same number', () => {
    const { text } = buildModalMessage(parseModal(permissionPrompt)!, '/tmp/x', 'mid-turn');
    expect(text).toContain('2. Yes, and always allow access to /tmp/tc-perm-tIf6Th from this project');
    // Unnumbered rows get a bullet instead, so they still read as choices.
    expect(buildModalMessage(parseModal(trustDialog)!, '/tmp/x', 'mid-turn').text)
      .toContain('• No, exit\n• Yes, I trust this folder');
  });

  it('says what the tap leads to: the message it is holding, or the turn carrying on', () => {
    const modal = parseModal(trustDialog)!;
    expect(buildModalMessage(modal, '/tmp/x', 'before-prompt').text).toMatch(/then send your message\.$/);
    expect(buildModalMessage(modal, '/tmp/x', 'mid-turn').text).toMatch(/so it can carry on\.$/);
  });

  it('asks for no tap when the dialog offers nothing to press', () => {
    const modal = parseModal([SEP, '  Background', '  No tasks currently running', '  ↑/↓ to select'].join('\n'))!;
    const { text } = buildModalMessage(modal, '/tmp/x', 'before-prompt');
    expect(text).toMatch(/needs someone at the terminal\.$/);
    expect(text).not.toContain('Tap');
  });
});
