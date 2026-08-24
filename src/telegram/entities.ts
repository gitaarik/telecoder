/**
 * Plain-text messages carrying explicit Telegram entities.
 *
 * Everywhere else TeleCoder formats with MarkdownV2, which means escaping, and
 * escaping is exactly what fails when the text being formatted came from the
 * model or from a shell command — a stray underscore in a URL parameter or an
 * unbalanced backtick in a `sed` script turns a `sendMessage` into a 400. The
 * existing workaround is a try/catch that re-sends the whole message unstyled.
 *
 * Entities sidestep that: the text is sent verbatim with no parse mode, and the
 * formatting rides alongside as offsets. Nothing in the payload can be
 * misparsed, because nothing is parsed.
 *
 * It also buys the one thing MarkdownV2 cannot express — `text_mention`, a
 * mention of a user by numeric id. That is what makes an approval prompt raise
 * a notification for the admin who has to answer it, even in a muted group,
 * and even for an admin who has no @username.
 *
 * Offsets are UTF-16 code units, which is what `String.length` counts, so the
 * running length below is the offset Telegram expects — including for emoji,
 * which occupy two units each.
 */

import type { MessageEntity } from 'grammy/types';

export interface EntityMessage {
  text: string;
  entities: MessageEntity[];
}

/**
 * Accumulates text and the entities that describe it. Every method returns
 * `this` so a message reads top-to-bottom in the order it renders.
 */
export class EntityText {
  private parts: string[] = [];
  private offset = 0;
  private readonly entities: MessageEntity[] = [];

  /** Append unstyled text. */
  add(text: string): this {
    if (text) {
      this.parts.push(text);
      this.offset += text.length;
    }
    return this;
  }

  /** Append a newline (or several). */
  newline(count = 1): this {
    return this.add('\n'.repeat(count));
  }

  private styled(text: string, entity: (offset: number, length: number) => MessageEntity): this {
    if (!text) return this;
    this.entities.push(entity(this.offset, text.length));
    return this.add(text);
  }

  bold(text: string): this {
    return this.styled(text, (offset, length) => ({ type: 'bold', offset, length }));
  }

  italic(text: string): this {
    return this.styled(text, (offset, length) => ({ type: 'italic', offset, length }));
  }

  /** Inline monospace — for a tool name, a path, a flag. */
  code(text: string): this {
    return this.styled(text, (offset, length) => ({ type: 'code', offset, length }));
  }

  /**
   * A monospace block, for a shell command or other multi-line verbatim text.
   * Telegram renders `pre` with its own trailing newline, so callers should not
   * add one inside `text`.
   */
  pre(text: string, language?: string): this {
    return this.styled(text, (offset, length) => ({
      type: 'pre',
      offset,
      length,
      ...(language ? { language } : {}),
    }));
  }

  /**
   * Mention a user by numeric id. Telegram notifies them if they are a member
   * of the chat, whether or not they have a @username, and renders `label` as
   * a link to their profile.
   */
  mention(label: string, userId: number): this {
    return this.styled(label, (offset, length) => ({
      type: 'text_mention',
      offset,
      length,
      // Telegram only reads `id` off this object; the rest of grammy's User
      // shape is required by the type but ignored on the wire.
      user: { id: userId, is_bot: false, first_name: label },
    }));
  }

  /** Current length in UTF-16 code units — the unit Telegram's 4096 cap counts. */
  get length(): number {
    return this.offset;
  }

  build(): EntityMessage {
    return { text: this.parts.join(''), entities: this.entities };
  }
}

/**
 * Clip text to `max` code units, marking the cut. Entity offsets are computed
 * from the text as appended, so anything long has to be shortened *before* it
 * goes into the builder rather than after.
 */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)) + '…';
}
