/**
 * How wide inline-button text may be before Telegram clips it.
 *
 * An inline button is a single line the client ellipsises, and there is no way
 * for the reader to expand it — text past the clip is not buried, it is gone.
 * So anything the user has to *read* in order to decide belongs in a message
 * body, and the button carries at most a label short enough to survive whole.
 *
 * The number is deliberately conservative: a full-width button on a narrow
 * phone is the case that clips first, and a label that stops short of the cut
 * costs nothing. Both features that put model-written text on a button —
 * `claudegram_ask_user` options and the predicted next prompt — measure
 * against this one constant so they clip at the same place.
 */
export const MAX_BUTTON_TEXT_LEN = 30;

/**
 * True when `text` renders on a button without being ellipsised.
 *
 * Length is counted in UTF-16 units rather than code points on purpose: an
 * emoji costs 2 there and renders about twice as wide as a letter, so the
 * cheap count tracks the rendered width better than a "correct" one would.
 */
export function fitsOnButton(text: string): boolean {
  return text.length <= MAX_BUTTON_TEXT_LEN;
}
