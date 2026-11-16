/**
 * Multi-question forms for telecoder_ask_user.
 *
 * One `telecoder_ask_user` call answers one question, and a tap on it is
 * final: the answer goes to Claude at once, so there is nothing to go back to.
 * Claude Code's own AskUserQuestion dialog is different — several questions
 * sit side by side, you can move between them and change your mind, and
 * nothing is sent until you submit. This module is that dialog in a Telegram
 * message.
 *
 * The model passes `questions` (2–4, each with 2–8 options) and the user gets
 * ONE message. Its body lists every question; the one being answered has its
 * options written out and on the keyboard, an answered one shows its answer.
 * A tap on an option records it and moves on to the next unanswered question;
 * a row of numbered buttons jumps to any question, answered or not, so an
 * earlier answer can be changed; and once every question has an answer a
 * Submit button appears. Only Submit resolves the tool call. The agent loop
 * waits throughout, like a single question.
 *
 * The form is in-memory, like single questions: a restart forgets it, and the
 * first tap afterwards takes the dead keyboard down. One clock for all of it
 * (QUESTION_TIMEOUT_MINUTES), from posting to Submit.
 *
 * Callback data (≤ 64 bytes, id is 8 hex chars):
 *   qf:<id>:o:<q>:<idx>   pick option idx on question q
 *   qf:<id>:g:<q>         go to question q
 *   qf:<id>:s             submit
 */

import * as crypto from 'crypto';
import type { Api, Context } from 'grammy';
import {
  type LetteredOption,
  buildLetteredKeyboard,
  letteredOptionLines,
  optionLetter,
} from '../telegram/lettered-options.js';
import { describeResponderRefusal } from '../telegram/admin-mention.js';
import {
  buildAskUserExpiredNote,
  closeExpiredQuestion,
  noteAwaitingUser,
  questionTimeoutMinutes,
  questionTimeoutMs,
} from './ask-user.js';

/** As many questions as Claude Code's own dialog takes. */
export const MAX_FORM_QUESTIONS = 4;
export const MIN_FORM_OPTIONS = 2;
export const MAX_FORM_OPTIONS = 8;

/** Telegram's hard cap on a text message / message edit. */
const MAX_MESSAGE_LEN = 4096;

export interface FormQuestion {
  question: string;
  options: LetteredOption[];
}

export interface FormAnswer {
  question: string;
  /** Zero-based index into that question's options. */
  index: number;
  label: string;
}

type Button = { text: string; callback_data: string };
type Keyboard = Button[][];

/** What a form looks like at one moment — everything rendering needs. */
export interface FormView {
  id: string;
  questions: FormQuestion[];
  context?: string;
  /** Chosen option index per question; undefined while unanswered. */
  answers: (number | undefined)[];
  /** The question whose options are on the keyboard; -1 once all are answered. */
  cur: number;
}

interface FormState extends FormView {
  resolve: (answers: FormAnswer[] | null) => void;
  timer: NodeJS.Timeout;
  endWait: () => void;
  /** The body as last rendered, so an expiry can be written under it. */
  lastText: string;
  allowedResponderIds?: number[];
}

const pending: Map<string, FormState> = new Map();

// ── Parsing ──────────────────────────────────────────────────────────

/**
 * Validate the `questions` argument as it arrives, straight off the IPC
 * body. Returns the questions, or the error
 * the model should read. A single question is not a form; the caller routes
 * it through the ordinary one-question path.
 */
export function parseFormQuestions(raw: unknown): FormQuestion[] | string {
  if (!Array.isArray(raw)) return 'Error: `questions` must be an array.';
  if (raw.length > MAX_FORM_QUESTIONS) {
    return `Error: a form takes at most ${MAX_FORM_QUESTIONS} questions; split the rest into a second call.`;
  }
  const out: FormQuestion[] = [];
  for (const [i, q] of raw.entries()) {
    if (!q || typeof q !== 'object') return `Error: question ${i + 1} is not an object.`;
    const qq = q as Record<string, unknown>;
    const question = typeof qq.question === 'string' ? qq.question.trim() : '';
    if (!question) return `Error: question ${i + 1} has no text.`;
    const options = parseOptions(qq.options);
    if (options.length < MIN_FORM_OPTIONS || options.length > MAX_FORM_OPTIONS) {
      return `Error: question ${i + 1} needs between ${MIN_FORM_OPTIONS} and ${MAX_FORM_OPTIONS} options.`;
    }
    out.push({ question, options });
  }
  return out;
}

/** The options of one question as they arrive, dropping anything malformed. */
export function parseOptions(raw: unknown): LetteredOption[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((o): LetteredOption | null => {
      if (!o || typeof o !== 'object') return null;
      const oo = o as Record<string, unknown>;
      if (typeof oo.label !== 'string' || !oo.label.trim()) return null;
      return {
        label: oo.label,
        ...(typeof oo.description === 'string' ? { description: oo.description } : {}),
      };
    })
    .filter((o): o is LetteredOption => o !== null);
}

/** What one telecoder_ask_user call asks: a form, or a single question. */
export type AskUserArgs =
  | { form: FormQuestion[]; question?: undefined; options?: undefined }
  | { form?: undefined; question: string; options: LetteredOption[] };

/**
 * Sort a call's arguments into a form or a single question — the one place
 * both transports decide, so they agree. `questions` wins when given; a
 * one-entry `questions` is just a single question. The string is the error
 * the model reads.
 */
export function resolveAskUserArgs(raw: {
  question?: unknown;
  options?: unknown;
  questions?: unknown;
}): AskUserArgs | string {
  if (Array.isArray(raw.questions) && raw.questions.length > 0) {
    const parsed = parseFormQuestions(raw.questions);
    if (typeof parsed === 'string') return parsed;
    if (parsed.length === 1) return { question: parsed[0].question, options: parsed[0].options };
    return { form: parsed };
  }
  const question = typeof raw.question === 'string' ? raw.question.trim() : '';
  const options = parseOptions(raw.options);
  if (!question || options.length < MIN_FORM_OPTIONS) {
    return 'Error: ask_user requires a non-empty question and ≥ 2 options, or a `questions` array.';
  }
  return { question, options };
}

// ── Rendering ────────────────────────────────────────────────────────

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function answerLine(q: FormQuestion, idx: number): string {
  return `   ✅ ${optionLetter(idx)}. ${oneLine(q.options[idx].label)}`;
}

function allAnswered(view: Pick<FormView, 'answers'>): boolean {
  return view.answers.every((a) => a !== undefined);
}

/**
 * The message body for a form in a given state, and the keyboard under it.
 *
 * The body is the one place every option is guaranteed to reach the user in
 * full (see lettered-options.ts), so the current question's options are
 * written out there, lettered, and its buttons carry the same letters. The
 * other questions take one line each — their answer if they have one — so the
 * message stays a form and not a wall; jumping to one brings its options back.
 *
 * `context` is trimmed to whatever room the questions leave under Telegram's
 * 4096 limit, so a form never fails to post for being wordy.
 */
export function renderForm(view: FormView): { text: string; keyboard: Keyboard } {
  const n = view.questions.length;
  const done = allAnswered(view);
  const header = done
    ? `📋 ${n} questions · all answered — check them, then Submit`
    : `📋 ${n} questions · answer each, then Submit. You can change an answer until then.`;

  const body: string[] = [];
  view.questions.forEach((q, i) => {
    const answer = view.answers[i];
    if (i === view.cur) {
      body.push('');
      body.push(`▶ ${i + 1}. ${oneLine(q.question)}`);
      letteredOptionLines(q.options).forEach((line, idx) => {
        body.push(idx === answer ? `   ✅ ${line}` : `   ${line}`);
      });
    } else {
      body.push('');
      body.push(`${i + 1}. ${oneLine(q.question)}`);
      if (answer !== undefined) body.push(answerLine(q, answer));
    }
  });

  const text = fitWithContext(header, view.context, body.join('\n'));
  return { text, keyboard: buildFormKeyboard(view) };
}

/** The body once submitted: every question with its answer, nothing to tap. */
export function renderSubmittedForm(view: FormView): string {
  const lines: string[] = [];
  view.questions.forEach((q, i) => {
    const answer = view.answers[i];
    lines.push('');
    lines.push(`${i + 1}. ${oneLine(q.question)}`);
    if (answer !== undefined) lines.push(answerLine(q, answer));
  });
  return fitWithContext(`📋 ${view.questions.length} questions · ✅ Submitted`, view.context, lines.join('\n'));
}

/**
 * Header, context and body joined, with the context clipped to fit Telegram's
 * limit — and, should the questions alone overflow it, the whole text clipped
 * as a last resort rather than letting sendMessage 400.
 */
function fitWithContext(header: string, context: string | undefined, body: string): string {
  const ctx = context?.trim() ?? '';
  const join = (c: string) => (c ? `${header}\n\n${c}\n${body}` : `${header}\n${body}`);
  let text = join(ctx);
  if (text.length > MAX_MESSAGE_LEN && ctx) {
    const room = ctx.length - (text.length - MAX_MESSAGE_LEN) - 1;
    text = join(room > 0 ? ctx.slice(0, room) + '…' : '');
  }
  if (text.length > MAX_MESSAGE_LEN) text = text.slice(0, MAX_MESSAGE_LEN - 1) + '…';
  return text;
}

export function buildFormKeyboard(view: FormView): Keyboard {
  const rows: Keyboard = [];
  const q = view.questions[view.cur];
  if (q) {
    rows.push(
      ...buildLetteredKeyboard(
        q.options.map((o, idx) => ({ label: o.label, callbackData: `qf:${view.id}:o:${view.cur}:${idx}` })),
      ),
    );
  }
  rows.push(
    view.questions.map((_, i) => ({
      text: i === view.cur ? `▶ ${i + 1}` : view.answers[i] !== undefined ? `${i + 1} ✓` : `${i + 1}`,
      callback_data: `qf:${view.id}:g:${i}`,
    })),
  );
  if (allAnswered(view)) rows.push([{ text: '✅ Submit', callback_data: `qf:${view.id}:s` }]);
  return rows;
}

/** What the model reads back once the form is submitted. */
export function formatFormAnswers(answers: FormAnswer[]): string {
  return ['User answered:', ...answers.map((a, i) => `${i + 1}. ${oneLine(a.question)} → ${oneLine(a.label)}`)].join('\n');
}

/**
 * The confirmation posted as a reply once a form is submitted — the same
 * reasons as buildAnswerConfirmation: an edit is silent and anonymous.
 */
export function buildFormConfirmation(
  answers: FormAnswer[],
  opts: { isPrivate: boolean; who?: string },
): string {
  const who = opts.isPrivate ? 'You' : opts.who?.trim() || 'Someone';
  return `✅ ${who} answered: ${answers.map((a, i) => `${i + 1}. ${oneLine(a.label)}`).join(' · ')}`;
}

// ── Registry ─────────────────────────────────────────────────────────

function clearPending(id: string): FormState | undefined {
  const entry = pending.get(id);
  if (!entry) return undefined;
  pending.delete(id);
  clearTimeout(entry.timer);
  entry.endWait();
  return entry;
}

/**
 * Register a form. The promise resolves with every answer once the user taps
 * Submit, or `null` when the clock runs out first. `form` is the live state
 * the caller posts and, on expiry, closes; the registry drops it on resolve.
 */
export function createPendingForm(
  questions: FormQuestion[],
  context: string | undefined,
  timeoutMs: number = questionTimeoutMs(),
  sessionKey?: string,
  allowedResponderIds?: number[],
): { id: string; promise: Promise<FormAnswer[] | null>; form: FormView & { readonly lastText: string } } {
  const id = crypto.randomBytes(4).toString('hex');
  let resolveFn!: (answers: FormAnswer[] | null) => void;
  const promise = new Promise<FormAnswer[] | null>((resolve) => {
    resolveFn = resolve;
  });
  const timer = setTimeout(() => {
    const entry = clearPending(id);
    if (entry) entry.resolve(null);
  }, timeoutMs);

  const state: FormState = {
    id,
    questions,
    context,
    answers: questions.map(() => undefined),
    cur: 0,
    resolve: resolveFn,
    timer,
    endWait: sessionKey ? noteAwaitingUser(sessionKey) : () => {},
    lastText: '',
    ...(allowedResponderIds && allowedResponderIds.length > 0 ? { allowedResponderIds } : {}),
  };
  state.lastText = renderForm(state).text;
  pending.set(id, state);
  return { id, promise, form: state };
}

export function hasPendingForm(id: string): boolean {
  return pending.has(id);
}

export type FormTap =
  | { kind: 'option'; question: number; index: number }
  | { kind: 'goto'; question: number }
  | { kind: 'submit' };

/** Decode a `qf:` callback, or undefined for one that is not well formed. */
export function parseFormCallback(data: string): { id: string; tap: FormTap } | undefined {
  const parts = data.split(':');
  if (parts[0] !== 'qf' || !parts[1]) return undefined;
  const id = parts[1];
  const num = (s: string | undefined) => (s !== undefined && /^\d+$/.test(s) ? Number(s) : undefined);
  switch (parts[2]) {
    case 'o': {
      const question = num(parts[3]);
      const index = num(parts[4]);
      if (question === undefined || index === undefined || parts.length !== 5) return undefined;
      return { id, tap: { kind: 'option', question, index } };
    }
    case 'g': {
      const question = num(parts[3]);
      if (question === undefined || parts.length !== 4) return undefined;
      return { id, tap: { kind: 'goto', question } };
    }
    case 's':
      return parts.length === 3 ? { id, tap: { kind: 'submit' } } : undefined;
    default:
      return undefined;
  }
}

export type FormTapOutcome =
  | { kind: 'expired' }
  | { kind: 'forbidden'; allowed: number[] | undefined }
  /** The form changed; redraw it. `toast` is a short note for the tapper. */
  | { kind: 'redraw'; text: string; keyboard: Keyboard; toast?: string }
  | { kind: 'submitted'; text: string; answers: FormAnswer[] };

/**
 * Apply one tap to a form. The option tap names its question, not "the
 * current one": two quick taps before Telegram redraws the keyboard must not
 * land the second on the question the first moved to.
 *
 * The responder check lives here for the same reason as in ask-user.ts: a
 * restricted form must be impossible to advance without saying who tapped.
 */
export function tapForm(id: string, tap: FormTap, responderId?: number): FormTapOutcome {
  const entry = pending.get(id);
  if (!entry) return { kind: 'expired' };
  const allowed = entry.allowedResponderIds;
  if (allowed && (responderId === undefined || !allowed.includes(responderId))) {
    return { kind: 'forbidden', allowed };
  }

  let toast: string | undefined;
  const n = entry.questions.length;
  switch (tap.kind) {
    case 'option': {
      const q = entry.questions[tap.question];
      if (q && tap.index >= 0 && tap.index < q.options.length) {
        entry.answers[tap.question] = tap.index;
        entry.cur = nextUnanswered(entry.answers, tap.question);
      }
      break;
    }
    case 'goto':
      if (tap.question >= 0 && tap.question < n) entry.cur = tap.question;
      break;
    case 'submit': {
      if (allAnswered(entry)) {
        clearPending(id);
        const answers = entry.questions.map((q, i) => {
          const idx = entry.answers[i] as number;
          return { question: q.question, index: idx, label: q.options[idx].label };
        });
        entry.resolve(answers);
        return { kind: 'submitted', text: renderSubmittedForm(entry), answers };
      }
      entry.cur = nextUnanswered(entry.answers, -1);
      toast = `Answer question ${entry.cur + 1} first.`;
      break;
    }
  }
  const drawn = renderForm(entry);
  entry.lastText = drawn.text;
  return { kind: 'redraw', ...drawn, ...(toast ? { toast } : {}) };
}

/** The first unanswered question after `from`, wrapping round; -1 when none. */
function nextUnanswered(answers: (number | undefined)[], from: number): number {
  const n = answers.length;
  for (let step = 1; step <= n; step++) {
    const i = (from + step) % n;
    if (answers[i] === undefined) return i;
  }
  return -1;
}

// ── Posting and waiting ──────────────────────────────────────────────

/**
 * Post a form and wait for Submit: the whole of what the IPC handler does
 * once it has a chat to post into. Returns the text the
 * model reads as its tool result.
 */
export async function runAskUserForm(opts: {
  api: Api;
  chatId: number;
  threadId?: number;
  sessionKey: string;
  questions: FormQuestion[];
  context?: string;
  onPosted?: () => Promise<void>;
  onSettled?: () => Promise<void>;
}): Promise<string> {
  const { promise, form } = createPendingForm(opts.questions, opts.context, undefined, opts.sessionKey);
  const { text, keyboard } = renderForm(form);
  // Plain text, no parse_mode, for the reasons the single question gives: the
  // text is the model's and a stray underscore would 400 the whole post.
  const sent = await opts.api.sendMessage(opts.chatId, text, {
    reply_markup: { inline_keyboard: keyboard },
    ...(opts.threadId !== undefined ? { message_thread_id: opts.threadId } : {}),
  });
  await opts.onPosted?.();

  const answers = await promise;
  await opts.onSettled?.();
  if (!answers) {
    await closeExpiredQuestion(opts.api, sent, form.lastText, buildAskUserExpiredNote());
    return `User did not respond within ${questionTimeoutMinutes()} minutes. Proceed using your best judgment or ask again.`;
  }
  return formatFormAnswers(answers);
}

// ── The tap handler ──────────────────────────────────────────────────

/**
 * Telegram callback handler for `qf:` buttons. Registered in bot.ts outside
 * the sequentialize middleware, like the single question's: the turn is
 * blocked on this exact tap.
 */
export async function handleAskUserFormCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;
  const parsed = parseFormCallback(data);
  if (!parsed) return;

  const outcome = tapForm(parsed.id, parsed.tap, ctx.from?.id);
  if (outcome.kind === 'expired') {
    await ctx.answerCallbackQuery({ text: 'This form already closed.' });
    // Closed by whoever was waiting on it, or forgotten by a restart: either
    // way the keyboard must stop looking live.
    try {
      await ctx.editMessageReplyMarkup();
    } catch {
      // Already gone, or not editable — nothing left to do.
    }
    return;
  }
  if (outcome.kind === 'forbidden') {
    await ctx.answerCallbackQuery({
      text: describeResponderRefusal(outcome.allowed, ctx.from?.id),
      show_alert: true,
    });
    return;
  }

  await ctx.answerCallbackQuery(outcome.kind === 'redraw' && outcome.toast ? { text: outcome.toast } : undefined);

  const message = ctx.callbackQuery?.message as { message_id?: number } | undefined;
  if (outcome.kind === 'redraw') {
    try {
      await ctx.editMessageText(outcome.text, { reply_markup: { inline_keyboard: outcome.keyboard } });
    } catch {
      // A redraw to the same text ("message is not modified") or a message
      // that cannot be edited: the state moved on regardless, and the next
      // tap redraws again.
    }
    return;
  }

  try {
    await ctx.editMessageText(outcome.text);
  } catch {
    try {
      await ctx.editMessageReplyMarkup();
    } catch {
      // A second tap is answered "already closed" anyway.
    }
  }
  try {
    await ctx.reply(
      buildFormConfirmation(outcome.answers, {
        isPrivate: ctx.chat?.type === 'private',
        who: ctx.from?.first_name,
      }),
      message?.message_id === undefined
        ? undefined
        : { reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true } },
    );
  } catch {
    // Non-fatal — the submitted body above already records the answers.
  }
}

/** For tests: forget every open form without resolving it. */
export function _resetFormsForTests(): void {
  for (const id of [...pending.keys()]) clearPending(id);
}
