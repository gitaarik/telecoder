/**
 * Lettered options — the A/B/C rendering any picker uses once its choices are
 * too long to survive on an inline button.
 *
 * A Telegram inline button is a single line the client ellipsises, with no way
 * for the reader to expand it, so text past the clip is not buried, it is gone
 * ({@link MAX_BUTTON_TEXT_LEN}). The rule that fixes that is the same wherever
 * a keyboard offers a choice: write every option out in the message body keyed
 * `A`, `B`, `C`, and let the same letter prefix its button. The body is then
 * the one place the full text is guaranteed to reach the user, and the button
 * only has to point back at it.
 *
 * `claudegram_ask_user` established the rule and `/resume` follows it; both
 * build their keyboard here so a question and a session list clip at the same
 * place instead of each keeping their own copy of the threshold.
 */

import { MAX_BUTTON_TEXT_LEN, fitsOnButton } from './button-text.js';

/** Separator between an option's letter and its label on a button. */
const BUTTON_SEP = ' · ';

/** Bare-letter buttons per row, once a keyboard has gone compact. */
const LETTERS_PER_ROW = 4;

/**
 * A label is one line by construction: a newline in it would break the A/B/C
 * listing apart, and a button renders a single line regardless. Model- and
 * user-written text reaches here unflattened, so flatten it once, here, rather
 * than at every call site.
 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** An option as the body spells it out. */
export interface LetteredOption {
  /** The option's full text — what a reader decides on. */
  label: string;
  /** Optional note after the label, set off by an em dash. */
  description?: string;
}

/**
 * The key an option is known by: `A`, `B`, `C`, … It prefixes the option both
 * in the message body and on its button, so a letter-only button still points
 * at the full text above it. Past `Z` it falls back to the 1-based index;
 * callers offer nowhere near 26 options, so that is defensive only.
 */
export function optionLetter(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

/**
 * One body line per option — `A. Label — description` — for the caller to put
 * under whatever heading it is asking beneath. Returned unescaped: a caller
 * sending MarkdownV2 escapes the lines, one sending plain text does not.
 */
export function letteredOptionLines(options: LetteredOption[]): string[] {
  return options.map((o, idx) => {
    const desc = o.description ? oneLine(o.description) : '';
    return `${optionLetter(idx)}. ${oneLine(o.label)}${desc ? ` — ${desc}` : ''}`;
  });
}

/**
 * The inline keyboard for a lettered list.
 *
 * A label rides on its own button while it fits ({@link MAX_BUTTON_TEXT_LEN})
 * — `A · Patch the regex` reads fine and saves a glance at the body. The
 * moment one option is too wide, every button in that keyboard falls back to
 * its bare letter and they pack four to a row: a keyboard that is half labels
 * and half mystery letters is harder to read than one that is uniformly keyed,
 * and the body above it already spells out what each letter stands for.
 *
 * `label` is what the button would carry, which is not always the whole of
 * what the body says — a caller free to park detail in `description` keeps
 * more of its buttons readable.
 */
export function buildLetteredKeyboard(
  options: { label: string; callbackData: string }[],
): { text: string; callback_data: string }[][] {
  const labelled = options.map((o, idx) => `${optionLetter(idx)}${BUTTON_SEP}${oneLine(o.label)}`);

  if (labelled.every(fitsOnButton)) {
    return labelled.map((text, idx) => [{ text, callback_data: options[idx].callbackData }]);
  }

  return buildLetterKeyboard(options.map((o) => o.callbackData));
}

/**
 * A keyboard of bare letters, four to a row: `A` for the first callback, `B`
 * for the next. For a message whose body is already the full list — a tree
 * drawn line by line, say — where a label on the button would only repeat it.
 */
export function buildLetterKeyboard(callbackData: string[]): { text: string; callback_data: string }[][] {
  const rows: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < callbackData.length; i += LETTERS_PER_ROW) {
    rows.push(
      callbackData.slice(i, i + LETTERS_PER_ROW).map((data, j) => ({
        text: optionLetter(i + j),
        callback_data: data,
      })),
    );
  }
  return rows;
}
