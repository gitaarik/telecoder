/**
 * Putting a Claude Code dialog in the chat, and its answer back in the pty.
 *
 * The pty has no keyboard, so a dialog claude opens blocks forever unless
 * someone answers it. Guessing the answer is not an option — the readiness
 * check used to guess by accident, and pressing Enter at a dialog it had
 * mistaken for the input box is enough to change a setting. So the dialog goes
 * to the person the session belongs to, as buttons, and their tap becomes the
 * keystrokes.
 *
 * Three rules the flow is built around:
 *
 *   - Only offer what the dialog offers. Buttons come from its numbered rows
 *     and from the keys its own footer names; nothing is inferred. A dialog we
 *     cannot parse gets relayed as text with no buttons at all.
 *   - Confirm the cursor before committing. Arrow keys are written first and
 *     the screen re-read; Enter follows only once the glyph is on the intended
 *     row. A dialog that redrew under us, or moved in a way we did not model,
 *     stops here instead of committing the wrong row.
 *   - Silence presses nothing. On timeout the dialog is left exactly as it
 *     was. An unanswered dialog is a prompt that fails; a guessed one is a
 *     setting that changed, and only the second is unrecoverable.
 */

import * as path from 'path';
import type { Context } from 'grammy';
import type { Message, MessageEntity } from 'grammy/types';
import { closeExpiredQuestion, createPendingQuestion, questionTimeoutMinutes } from './ask-user.js';
import { arrowsTo, keystrokeFor, parseModal, type TuiModal } from './tui-modal.js';
import { hasInputBox } from './tui-state.js';
import { EntityText, type EntityMessage } from '../telegram/entities.js';
import { parseSessionKey } from '../utils/session-key.js';
import { sanitizeError } from '../utils/sanitize.js';

/** Settle time after writing a key, before re-reading the screen. */
const KEY_SETTLE_MS = 400;
/** Telegram's inline-keyboard rows we are willing to render. */
const MAX_BUTTONS = 8;

export type ModalOutcome =
  /** A key was written; the caller should re-run its readiness wait. */
  | { kind: 'answered'; label: string }
  /** Nobody tapped in time. The dialog is untouched and still on screen. */
  | { kind: 'timeout' }
  /** The user chose to leave it alone, or we could offer nothing to press. */
  | { kind: 'declined'; why: string }
  /** We could not drive it: the cursor would not land where it was asked to. */
  | { kind: 'failed'; why: string };

/** What the relay needs from the pty, kept narrow so it can be tested. */
export interface ModalPty {
  write(data: string): void;
  screen(): string;
}

/**
 * The buttons a dialog earns. Numbered rows first, in the dialog's own order,
 * then the footer keys that are answers rather than navigation — `Esc to
 * cancel` is worth a button, `↑/↓ to select` is not, because the relay does
 * the navigating. Enter is dropped when there are rows to pick, since picking
 * a row already presses it.
 */
export function buildChoices(modal: TuiModal): { label: string; send: 'option' | string; index: number }[] {
  const choices: { label: string; send: 'option' | string; index: number }[] = [];

  const navigable = modal.highlighted >= 0;
  if (navigable) {
    for (const option of modal.options) {
      const prefix = option.number === undefined ? '' : `${option.number}. `;
      choices.push({ label: `${prefix}${option.label}`, send: 'option', index: option.index });
    }
  }

  for (const hint of modal.hints) {
    if (choices.length > 0 && /^Enter/.test(hint.key)) continue;
    const key = keystrokeFor(hint.key);
    if (key === null) continue;
    choices.push({ label: `${hint.key} — ${hint.action}`, send: key, index: -1 });
  }

  return choices.slice(0, MAX_BUTTONS - 1);
}

/**
 * What is waiting on the dialog: the message the user just sent, which can't
 * be typed in while it's open, or a turn that ran into it partway through.
 */
export type RelayStage = 'before-prompt' | 'mid-turn';

/**
 * The message above the buttons: claude's dialog, laid out for a phone.
 *
 * The screen does not travel well as it is. Claude hard-wraps it at 120
 * columns, which a phone then wraps again; the indentation and the gutter that
 * set a command apart mean nothing in a proportional font; and the rows repeat
 * the buttons with a cursor glyph nobody can move. So the body goes out as the
 * parts {@link parseModal} read it into — title and question in bold, drawn
 * content in a monospace block, each row once in full, since its button is
 * clipped.
 *
 * Entities rather than a parse mode: the body is claude's own render, and the
 * underscores and asterisks of whatever command it is asking about would be
 * read as Markdown and 400 the send.
 */
export function buildModalMessage(modal: TuiModal, cwd: string, stage: RelayStage): EntityMessage {
  const b = new EntityText();
  b.add('⌨️ ').bold('Claude Code needs an answer').newline();
  b.add('Project: ').bold(path.basename(cwd) || cwd).newline(2);
  appendDialog(b, modal);
  return b.newline(2).italic(closingLine(modal, stage)).build();
}

function appendDialog(b: EntityText, modal: TuiModal): void {
  const { parts } = modal;
  // The line the rows answer — "Do you want to proceed?" — sits right above them.
  const question = parts.findIndex((p) => p.kind === 'options') - 1;

  parts.forEach((part, i) => {
    if (i > 0) b.newline(part.gapBefore ? 2 : 1);
    if (part.kind === 'verbatim') {
      b.pre(part.lines.join('\n'));
    } else if (part.kind === 'options') {
      modal.options.forEach((o, n) => {
        const key = o.number === undefined ? '•' : `${o.number}.`;
        b.newline(n > 0 ? 1 : 0).add(`${key} ${o.text}${o.detail ? ` — ${o.detail}` : ''}`);
      });
    } else {
      part.lines.forEach((line, n) => {
        const heading = (i === 0 && n === 0)
          || (i === question && n === part.lines.length - 1 && line.endsWith('?'));
        b.newline(n > 0 ? 1 : 0);
        if (heading) b.bold(line);
        else b.add(line);
      });
    }
  });
}

/** What a tap does, and what happens once it has. */
function closingLine(modal: TuiModal, stage: RelayStage): string {
  if (buildChoices(modal).length === 0) {
    return 'It offers no key I can press from here, so it needs someone at the terminal.';
  }
  return stage === 'before-prompt'
    ? "Tap your answer and I'll press it in Claude Code, then send your message."
    : "Tap your answer and I'll press it in Claude Code so it can carry on.";
}

/**
 * Relay `screen`'s dialog to the chat and press whatever comes back.
 *
 * Returns without pressing anything when the dialog cannot be parsed, when it
 * offers nothing pressable, or when nobody answers — the caller turns each of
 * those into a message saying the prompt was not delivered, which is the
 * honest outcome and leaves the dialog for a person to deal with.
 */
export async function relayModal(
  pty: ModalPty,
  sessionKey: string,
  ctx: Context,
  cwd: string,
  stage: RelayStage,
): Promise<ModalOutcome> {
  const modal = parseModal(pty.screen());
  if (!modal) return { kind: 'declined', why: 'the screen could not be read as a dialog' };

  const choices = buildChoices(modal);
  const labels = [...choices.map((c) => c.label), '✋ Leave it alone'];
  const message = buildModalMessage(modal, cwd, stage);
  if (choices.length === 0) {
    await send(ctx, sessionKey, message, undefined);
    return { kind: 'declined', why: 'the dialog offers no keys this bot can press' };
  }

  // Waits QUESTION_TIMEOUT_MINUTES, like any other question the turn asks.
  const { id, promise } = createPendingQuestion(labels, undefined, sessionKey);
  const keyboard = labels.map((label, idx) => [{ text: label, callback_data: `q:${id}:${idx}` }]);
  const { sent, entities } = await send(ctx, sessionKey, message, keyboard);

  const answer = await promise;
  if (!answer) {
    await closeExpiredQuestion(
      ctx.api, sent, message.text,
      `No answer within ${questionTimeoutMinutes()} min, so I left the dialog alone.`,
      entities,
    );
    return { kind: 'timeout' };
  }
  const choice = choices[answer.index];
  if (!choice) return { kind: 'declined', why: 'you chose to leave it alone' };

  if (choice.send !== 'option') {
    pty.write(choice.send);
    return { kind: 'answered', label: choice.label };
  }
  return pressOption(pty, modal, choice.index, choice.label);
}

/**
 * Walk the cursor to `index` and commit — but only after seeing it arrive.
 *
 * The re-read is the whole point. Arrow keys are a bet that the dialog moves
 * its cursor the way every dialog we measured moves it, and a bet that is
 * wrong must not end in Enter: a dialog whose cursor did not land where we
 * asked is one where Enter commits an option nobody chose.
 */
async function pressOption(
  pty: ModalPty, modal: TuiModal, index: number, label: string,
): Promise<ModalOutcome> {
  const arrows = arrowsTo(modal, index);
  if (arrows === null) return { kind: 'failed', why: 'the dialog\'s cursor position could not be read' };

  for (const arrow of arrows) {
    pty.write(arrow);
    await delay(KEY_SETTLE_MS / 2);
  }
  await delay(KEY_SETTLE_MS);

  const landed = parseModal(pty.screen());
  if (!landed) return { kind: 'failed', why: 'the dialog changed shape while being answered' };
  if (landed.highlighted !== index) {
    return {
      kind: 'failed',
      why: `the cursor stopped on option ${landed.highlighted + 1}, not ${index + 1}`,
    };
  }

  pty.write('\r');
  return { kind: 'answered', label };
}

/**
 * The dialog standing between claude and the end of a turn, or null.
 *
 * Both halves matter. Claude draws its input box for the whole of a working
 * turn, so the box being *gone* is what separates a dialog from ordinary
 * progress; and an ordinary footer (`⏵⏵ bypass permissions on · ← for agents`)
 * parses as no dialog, so a half-drawn frame can't be mistaken for one.
 *
 * Split out from the caller because this is the judgement that decides whether
 * a turn gets interrupted, and it is worth being able to point real screens at.
 */
export function blockingModal(screenText: string): TuiModal | null {
  if (hasInputBox(screenText)) return null;
  return parseModal(screenText);
}

/** True once the dialog is gone and claude is back at its input box. */
export async function waitForDialogToClear(pty: ModalPty, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasInputBox(pty.screen())) return true;
    await delay(200);
  }
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Send the dialog, and say which entities it went out with — closing it later
 * has to repeat them, or the edit strips the formatting.
 */
async function send(
  ctx: Context,
  sessionKey: string,
  message: EntityMessage,
  keyboard: { text: string; callback_data: string }[][] | undefined,
): Promise<{ sent: Message.TextMessage; entities?: MessageEntity[] }> {
  const { chatId, threadId } = parseSessionKey(sessionKey);
  const extra = {
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
  };
  try {
    const sent = await ctx.api.sendMessage(chatId, message.text, { ...extra, entities: message.entities });
    return { sent, entities: message.entities };
  } catch (err) {
    // Nothing in the text is parsed, so if Telegram refused it, an entity is
    // what it refused — and that shouldn't cost the dialog its buttons, the
    // only way to answer it from the chat. Anything else, like a network
    // failure, fails the plain send too and surfaces as it always did.
    console.warn('[ModalRelay] formatted dialog refused, sending it plain:', sanitizeError(err));
    return { sent: await ctx.api.sendMessage(chatId, message.text, extra) };
  }
}
