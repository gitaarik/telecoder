/**
 * How Claude Code's predicted next prompt is rendered in the chat.
 *
 * The suggestion is scraped from one row of a 120-column terminal, so it can
 * arrive nearly 120 characters wide — several times what an inline button
 * shows before Telegram ellipsises it, with no way for the reader to expand
 * it. Offering it as a button alone therefore delivered a half-sentence and
 * dropped the rest: the user could still tap it, but could not read what they
 * were about to send.
 *
 * So the same rule `claudegram_ask_user` follows applies here. Text rides on
 * its own button while it fits, which keeps the common short suggestion a
 * single tap under the response and adds nothing to the chat. Anything wider
 * goes into its own message — a card — where the full prompt is in the body
 * and the button beneath it is a fixed short label that cannot be clipped.
 */

import { escapeMarkdownV2 } from './markdown.js';
import { fitsOnButton } from './button-text.js';

const BULB = '💡';

/** Fixed label for the card's button; the prompt itself is in the body above. */
export const SUGGESTION_CARD_BUTTON = `${BULB} Send this prompt`;

/**
 * Collapse scraped ghost text to a single clean line. The flattened form is
 * what gets stored, shown and ultimately sent, so what the user reads is
 * exactly what Claude receives.
 */
export function flattenSuggestion(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/** Button label for a suggestion short enough to carry its own text. */
export function formatSuggestionLabel(text: string): string {
  return `${BULB} ${flattenSuggestion(text)}`;
}

/**
 * True when the whole suggestion — bulb and all — survives on a button. False
 * means it needs a card; nothing is ever truncated on the way to the user.
 */
export function suggestionFitsOnButton(text: string): boolean {
  return fitsOnButton(formatSuggestionLabel(text));
}

/**
 * The card body, in MarkdownV2.
 *
 * `sent: true` is the same message rewritten once the button has been tapped.
 * The card is the only place the prompt is written out, so it has to keep
 * showing it — but it must stop reading as an offer, the way an answered
 * question grows a "✅ Answered" footer instead of silently losing its
 * keyboard.
 */
export function buildSuggestionCardText(text: string, opts: { sent?: boolean } = {}): string {
  const header = opts.sent ? '✅ Sent:' : `${BULB} Suggested next prompt:`;
  return `${escapeMarkdownV2(header)}\n_${escapeMarkdownV2(flattenSuggestion(text))}_`;
}

/** Plain-text fallback for when MarkdownV2 is rejected for the card. */
export function buildSuggestionCardPlainText(text: string, opts: { sent?: boolean } = {}): string {
  const header = opts.sent ? '✅ Sent:' : `${BULB} Suggested next prompt:`;
  return `${header}\n${flattenSuggestion(text)}`;
}
