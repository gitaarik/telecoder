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
 *
 * A dialog can also take more than one answer. `/mcp` is a menu several
 * screens deep — its servers, then one server's actions, then that server's
 * tools — and a tap that opens the next screen hasn't finished with the
 * dialog, it has moved it on. So the relay follows it ({@link relayDialog})
 * until claude is back at its input box, offering each screen as it offered
 * the first.
 */

import * as path from 'path';
import type { Context } from 'grammy';
import type { Message, MessageEntity } from 'grammy/types';
import { closeExpiredQuestion, createPendingQuestion, questionTimeoutMinutes } from './ask-user.js';
import { arrowsTo, keystrokeFor, parseModal, type ModalOption, type TuiModal } from './tui-modal.js';
import { hasInputBox, screenSignature } from './tui-state.js';
import { EntityText, type EntityMessage } from '../telegram/entities.js';
import { parseSessionKey } from '../utils/session-key.js';
import { sanitizeError } from '../utils/sanitize.js';

/** Settle time after writing a key, before re-reading the screen. */
const KEY_SETTLE_MS = 400;
/**
 * Gap between the arrow keys of one walk, so each arrives as a keystroke of
 * its own. Short, because a walk can be long: a list that scrolls is a page of
 * eighteen rows, and a page scroll is that many arrows twice. Measured against
 * a live 2.1.310 pty, eighteen arrows sent back to back, and ten in a single
 * write, all landed. The screen is re-read for where the cursor ended up
 * either way.
 */
const ARROW_GAP_MS = 20;
/** How often to look at the screen while waiting to see what a press did. */
const PRESS_POLL_MS = 100;
/** How long one arrow of a scroll gets to show up on screen before the scroll gives up. */
const REDRAW_MS = 500;
/**
 * Most rows offered as buttons: a whole screenful, which at 40 rows is about
 * twenty. A list longer than that scrolls, and its scroll buttons reach the
 * rest.
 */
const MAX_ROW_BUTTONS = 20;

export type ModalOutcome =
  /**
   * A key was written. `dialog` is the dialog it went into, read just before —
   * what the screen has to move on from for the press to have done anything.
   */
  | { kind: 'answered'; label: string; dialog: TuiModal }
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

/** What a button presses. */
export type ModalChoice =
  /** Walk the cursor to one of the dialog's rows, and commit it once it lands. */
  | { kind: 'row'; label: string; index: number }
  /** Press a key the dialog's footer names. */
  | { kind: 'key'; label: string; key: string }
  /** Scroll a list too long for the screen on to the rows it isn't drawing. */
  | { kind: 'page'; label: string; direction: 'up' | 'down' };

/**
 * The buttons a dialog earns. Numbered rows first, in the dialog's own order,
 * then the footer keys that are answers rather than navigation — `Esc to
 * cancel` is worth a button, `↑/↓ to select` is not, because the relay does
 * the navigating. Enter is dropped when there are rows to pick, since picking
 * a row already presses it.
 *
 * Doing the navigating includes scrolling. A list that runs past the screen
 * gets a scroll button at each end it continues beyond, placed at that end,
 * and each row it draws gets a button of its own. The cap of seven this used
 * to have left `/mcp`'s 111-tool list reachable as far as its seventh tool.
 */
export function buildChoices(modal: TuiModal): ModalChoice[] {
  const rows: ModalChoice[] = [];
  if (modal.highlighted >= 0) {
    for (const option of modal.options.slice(0, MAX_ROW_BUTTONS)) {
      const prefix = option.number === undefined ? '' : `${option.number}. `;
      rows.push({ kind: 'row', label: `${prefix}${option.label}`, index: option.index });
    }
    if (modal.more.above > 0) {
      rows.unshift({ kind: 'page', label: `↑ Scroll up (${modal.more.above} more)`, direction: 'up' });
    }
    if (modal.more.below > 0) {
      rows.push({ kind: 'page', label: `↓ Scroll down (${modal.more.below} more)`, direction: 'down' });
    }
  }

  const keys: ModalChoice[] = [];
  for (const hint of modal.hints) {
    if (rows.length > 0 && /^Enter/.test(hint.key)) continue;
    const key = keystrokeFor(hint.key);
    if (key === null) continue;
    keys.push({ kind: 'key', label: `${hint.key} — ${hint.action}`, key });
  }

  return [...rows, ...keys];
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
      const { above, below } = modal.more;
      [
        ...(above > 0 ? [`↑ ${above} more`] : []),
        ...modal.options.map((o) => {
          const key = o.number === undefined ? '•' : `${o.number}.`;
          return `${key} ${o.text}${o.detail ? ` — ${o.detail}` : ''}`;
        }),
        ...(below > 0 ? [`↓ ${below} more`] : []),
      ].forEach((row, n) => b.newline(n > 0 ? 1 : 0).add(row));
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

/**
 * A relay that ended with the dialog still up: nobody answered, the user left
 * it, the bot couldn't drive it — or a key was pressed and the dialog stayed
 * exactly as it was.
 */
export type OpenDialog =
  | Exclude<ModalOutcome, { kind: 'answered' }>
  | { kind: 'still-open'; label: string };

/**
 * Why the turn stops at a dialog that is still open, for the chat.
 *
 * Where the turn stands decides what's true. Before a prompt, the user's
 * message is what didn't happen: it was never typed in, and sending it again
 * is the fix. Mid-turn it was delivered long before, and saying otherwise sent
 * people off to resend a message claude already had. What stops there is the
 * bot waiting on the turn, while claude stays paused on the dialog — and the
 * next message meets it before anything else, with its buttons.
 */
export function openDialogError(dialog: OpenDialog, stage: RelayStage): string {
  if (stage === 'before-prompt') {
    switch (dialog.kind) {
      case 'still-open':
        return `I pressed "${dialog.label}", but Claude Code hasn't returned to its input box, `
          + "so your message wasn't delivered. Send it again in a moment.";
      case 'timeout':
        return "Nobody answered Claude Code's dialog, so I left it alone and your message wasn't "
          + "delivered. Send it again to get the dialog's buttons back.";
      default:
        return `Your message wasn't delivered — ${dialog.why}. Claude Code is still waiting on that dialog.`;
    }
  }
  switch (dialog.kind) {
    case 'still-open':
      return `I pressed "${dialog.label}", but Claude Code's dialog is still open, so I stopped `
        + 'waiting on this turn. Your next message brings its buttons back.';
    case 'timeout':
      return "Nobody answered Claude Code's dialog, so I left it alone and stopped waiting on "
        + 'this turn. Claude Code is paused on it until your next message, which brings its buttons back.';
    default:
      return `I stopped waiting on this turn — ${dialog.why}. Claude Code is still paused on that dialog.`;
  }
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
 * Relay the dialog on screen to the chat and press whatever comes back — one
 * screen of it; {@link relayDialog} follows it through the rest.
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

  // The tap can come minutes after the message went out. A key meant for this
  // dialog means something else anywhere else — at the input box, `s` is a
  // letter typed into the next message — so look again before pressing it.
  const screen = pty.screen();
  const current = hasInputBox(screen) ? null : parseModal(screen);
  if (!current || !sameDialog(current, modal)) {
    return { kind: 'failed', why: 'the dialog changed before your answer reached it' };
  }

  if (choice.kind === 'key') {
    pty.write(choice.key);
    return { kind: 'answered', label: choice.label, dialog: current };
  }
  if (choice.kind === 'page') return scroll(pty, current, choice.direction, choice.label);
  return pressOption(pty, current, choice.index, choice.label);
}

/**
 * True when two reads are of the same dialog, whatever has changed inside it.
 * A row can be redrawn while the dialog waits for its answer without changing
 * what that answer presses. A different heading, a different number of rows
 * or different keys in the footer would.
 */
function sameDialog(a: TuiModal, b: TuiModal): boolean {
  return a.title === b.title && a.options.length === b.options.length && sameHints(a, b);
}

/** True when two reads show the dialog exactly as it was: same rows, same cursor, same keys. */
function drawnAlike(a: TuiModal, b: TuiModal): boolean {
  return screenSignature(a.body) === screenSignature(b.body) && sameHints(a, b);
}

function sameHints(a: TuiModal, b: TuiModal): boolean {
  return a.hints.length === b.hints.length
    && a.hints.every((hint, i) => hint.key === b.hints[i].key && hint.action === b.hints[i].action);
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
    await delay(ARROW_GAP_MS);
  }
  await delay(KEY_SETTLE_MS);

  const landed = parseModal(pty.screen());
  if (!landed) return { kind: 'failed', why: 'the dialog changed shape while being answered' };

  // Which row the cursor is on is read off what the row says. A list that
  // scrolls moves its rows under the cursor: past its first screen, `/mcp`'s
  // tool list keeps the cursor on its bottom row and shifts the rest, so the
  // row asked for is on screen but never at the index it was asked for at. A
  // list that didn't scroll has to match on the index too, which is what
  // tells apart two rows that read the same.
  const wanted = modal.options[index];
  const reached = landed.options[landed.highlighted];
  const scrolled = landed.more.above !== modal.more.above || landed.more.below !== modal.more.below;
  if (!reached || !sameRow(reached, wanted) || (!scrolled && landed.highlighted !== index)) {
    return {
      kind: 'failed',
      why: `the cursor stopped on "${reached?.label ?? 'no row'}", not "${wanted.label}"`,
    };
  }

  pty.write('\r');
  return { kind: 'answered', label, dialog: landed };
}

function sameRow(a: ModalOption, b: ModalOption): boolean {
  return a.number === b.number && a.text === b.text;
}

/**
 * Scroll a long list on by a screenful less one row. The one row is what
 * keeps the screens joined: a list that has scrolled draws a marker at the
 * end it came from, in a row's place, and a whole screenful would carry the
 * row beside the old screen past without ever drawing it.
 *
 * One arrow at a time, with the list read after each, until its `↓ 92 more`
 * has come down by that much. Counting the presses ahead of time would mean
 * knowing how the list scrolls, and lists don't agree: some move the cursor
 * to their edge before the rows move at all, while `/mcp`'s tool list, once
 * past its first screen, moves every row on every press. Nothing is committed
 * either way, so nothing needs confirming. Wherever the list ends up is the
 * next screen, and it is relayed like any other.
 */
async function scroll(
  pty: ModalPty, modal: TuiModal, direction: 'up' | 'down', label: string,
): Promise<ModalOutcome> {
  const hidden = (m: TuiModal): number => (direction === 'down' ? m.more.below : m.more.above);
  if (modal.highlighted < 0 || hidden(modal) === 0) {
    return { kind: 'failed', why: 'the list had nothing further to scroll to' };
  }
  const arrow = direction === 'down' ? '\x1b[B' : '\x1b[A';
  const goal = Math.max(0, hidden(modal) - Math.max(1, modal.options.length - 1));
  // A walk to the edge and a page past it is the most this takes. A list
  // still short of the goal after that isn't scrolling the way it says.
  const most = 2 * modal.options.length + hidden(modal);

  let now = modal;
  for (let presses = 0; hidden(now) > goal && presses < most; presses++) {
    pty.write(arrow);
    const next = await redrawn(pty, now);
    if (!next) return { kind: 'failed', why: 'the list stopped moving while being scrolled' };
    now = next;
  }
  return { kind: 'answered', label, dialog: modal };
}

/** The dialog once the screen has redrawn after a key, or null if it doesn't redraw in time. */
async function redrawn(pty: ModalPty, before: TuiModal): Promise<TuiModal | null> {
  const deadline = Date.now() + REDRAW_MS;
  while (Date.now() < deadline) {
    await delay(ARROW_GAP_MS);
    const screen = pty.screen();
    const next = hasInputBox(screen) ? null : parseModal(screen);
    if (next && !drawnAlike(next, before)) return next;
  }
  return null;
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

/** How a dialog the relay followed ended: closed, or left open for one of the reasons in {@link OpenDialog}. */
export type DialogOutcome = { kind: 'closed'; label: string } | OpenDialog;

export interface DialogTiming {
  /** How long a press gets to close the dialog or move it on before it counts as still open. */
  clearMs: number;
  /** How long a screen the dialog moved on to must stand still before it is relayed. */
  settleMs: number;
}

/**
 * Relay a dialog, and keep relaying it for as long as answering it leads on
 * to more of it.
 *
 * Every press used to be expected to close the dialog. In `/mcp` that holds
 * only for the last one: picking a server opens that server's screen, `View
 * tools` opens its tool list, and Esc there steps back up a level rather than
 * out. The first tap left the menu on whatever screen it opened and ended the
 * turn calling the dialog still open — so a menu could be opened from the
 * chat, and never used. What a press leads to is looked at instead: claude
 * back at its input box ends the relay, a screen that differs from the one
 * answered is relayed in its turn, and only a press that changes nothing
 * leaves the dialog counted as still open.
 *
 * No count caps the screens. Each one waits on a tap, and each offers "Leave
 * it alone", so the person answering decides when it ends.
 */
export async function relayDialog(
  pty: ModalPty,
  sessionKey: string,
  ctx: Context,
  cwd: string,
  stage: RelayStage,
  timing: DialogTiming,
): Promise<DialogOutcome> {
  for (;;) {
    const outcome = await relayModal(pty, sessionKey, ctx, cwd, stage);
    if (outcome.kind !== 'answered') return outcome;
    const next = await afterPress(pty, outcome.dialog, timing);
    if (next === 'closed') return { kind: 'closed', label: outcome.label };
    if (next === 'unchanged') return { kind: 'still-open', label: outcome.label };
  }
}

/**
 * Where a press left the dialog: closed, moved on to a screen of its own, or
 * still showing exactly what was answered when the deadline came.
 *
 * Closed counts the moment the input box is back, as it always has. A new
 * screen has to stand still first, as a screen must before the readiness wait
 * will read it: a read taken while claude is still drawing can catch a frame
 * halfway, and buttons built from it would be for a dialog that was never on
 * screen. Only a press that changed nothing at all waits out the deadline.
 */
export async function afterPress(
  pty: ModalPty,
  pressed: TuiModal,
  timing: DialogTiming,
): Promise<'closed' | 'moved' | 'unchanged'> {
  const deadline = Date.now() + timing.clearMs;
  let seen: string | null = null;
  let stillSince = Date.now();
  while (Date.now() < deadline) {
    const screen = pty.screen();
    if (hasInputBox(screen)) return 'closed';
    const signature = screenSignature(screen);
    if (signature !== seen) {
      seen = signature;
      stillSince = Date.now();
    } else if (Date.now() - stillSince >= timing.settleMs) {
      const modal = parseModal(screen);
      if (modal && !drawnAlike(modal, pressed)) return 'moved';
    }
    await delay(PRESS_POLL_MS);
  }
  return 'unchanged';
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
