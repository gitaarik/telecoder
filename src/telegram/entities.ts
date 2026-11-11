/**
 * Plain-text messages carrying explicit Telegram entities.
 *
 * Every message TeleCoder sends is formatted this way; nothing goes out with a
 * parse mode. MarkdownV2 meant escaping, and escaping is exactly what fails
 * when the text being formatted came from the model or from a shell command — a
 * stray underscore in a URL parameter or an unbalanced backtick in a `sed`
 * script turned a `sendMessage` into a 400. It also could not be split: a long
 * reply cut in the middle of a bold run or a link broke both halves.
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

  strikethrough(text: string): this {
    return this.styled(text, (offset, length) => ({ type: 'strikethrough', offset, length }));
  }

  underline(text: string): this {
    return this.styled(text, (offset, length) => ({ type: 'underline', offset, length }));
  }

  spoiler(text: string): this {
    return this.styled(text, (offset, length) => ({ type: 'spoiler', offset, length }));
  }

  /**
   * `text` as a link to `url`, which the reader doesn't have to see spelled out.
   *
   * Telegram refuses the whole message over a link it won't accept — one to
   * `http://localhost:3000`, say, which has no TLD. Such a link goes out as
   * plain text instead, with the address after it when the label hides it.
   */
  link(text: string, url: string): this {
    if (!isLinkableUrl(url)) return this.add(text === url || !text ? url : `${text} (${url})`);
    return this.styled(text || url, (offset, length) => ({ type: 'text_link', offset, length, url }));
  }

  /**
   * A quote; `expandable` collapses it to its first lines until tapped. Telegram
   * does not nest quotes, so callers must not open one inside another.
   */
  quote(text: string | EntityMessage, expandable = false): this {
    const type = expandable ? 'expandable_blockquote' : 'blockquote';
    return this.wrap(type, (b) => (typeof text === 'string' ? b.add(text) : b.append(text)));
  }

  /**
   * Wrap whatever `build` appends in one entity of `type`, so it can carry
   * entities of its own: bold inside a link, code inside a quote.
   */
  wrap(type: WrapType, build: (b: this) => void, extra: Partial<MessageEntity> = {}): this {
    const start = this.offset;
    const at = this.entities.length;
    build(this);
    const length = this.offset - start;
    if (length > 0) {
      // Before the entities appended inside it, so a reader of the list meets
      // the outer one first, as Telegram itself orders them.
      this.entities.splice(at, 0, { type, offset: start, length, ...extra } as MessageEntity);
    }
    return this;
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

  /**
   * A moment in time, which Telegram shows in the reader's own timezone and
   * format — Bot API 9.5's `date_time` entity. The bot runs on a server whose
   * clock can be hours off the reader's, so a time it writes out itself can be
   * too. `text` is what a client too old for the entity shows instead.
   *
   * `format` is Telegram's: `t` a short time (22:45), `T` one with seconds.
   */
  dateTime(text: string, unixMs: number, format: 't' | 'T' = 't'): this {
    return this.styled(text, (offset, length) => ({
      type: 'date_time',
      offset,
      length,
      unix_time: Math.floor(unixMs / 1000),
      date_time_format: format,
      // grammy's MessageEntity predates Bot API 9.5 and has no `date_time`.
    }) as unknown as MessageEntity);
  }

  /** Append another built message, its entities shifted to where it lands. */
  append(message: EntityMessage): this {
    for (const entity of message.entities) {
      this.entities.push({ ...entity, offset: entity.offset + this.offset });
    }
    return this.add(message.text);
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
  // Never between the halves of a surrogate pair: half an emoji is invalid
  // UTF-16, which Telegram refuses.
  let cut = Math.max(0, max - 1);
  if (cut > 0 && isHighSurrogate(text.charCodeAt(cut - 1))) cut--;
  return text.slice(0, cut) + '…';
}

/** Entity types that {@link EntityText.wrap} may open around nested content. */
export type WrapType =
  | 'bold' | 'italic' | 'underline' | 'strikethrough' | 'spoiler'
  | 'text_link' | 'blockquote' | 'expandable_blockquote';

export function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * Whether Telegram accepts `url` on a `text_link`. It wants a web address with
 * a real top-level domain (no `localhost`, no bare IP, no single-label
 * intranet host) or one of its own `tg:` links; anything else makes it refuse
 * the entire message.
 */
export function isLinkableUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === 'tg:') return true;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const labels = parsed.hostname.split('.');
  if (labels.length < 2 || labels.some((l) => !l)) return false;
  const tld = labels[labels.length - 1];
  return /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/i.test(tld);
}

/** Plain text, no formatting. */
export function plain(text: string): EntityMessage {
  return { text, entities: [] };
}

/** Join messages with `separator`, shifting each one's entities into place. */
export function joinMessages(messages: EntityMessage[], separator = '\n\n'): EntityMessage {
  const b = new EntityText();
  messages.forEach((m, i) => {
    if (i > 0) b.add(separator);
    b.append(m);
  });
  return b.build();
}

/**
 * The slice `[start, end)` of a message, with its entities cut to fit. An
 * entity running across either edge keeps the part inside, which is what lets
 * a long reply be split in the middle of a bold run or a code block and keep
 * the formatting on both sides.
 */
export function sliceMessage(message: EntityMessage, start: number, end = message.text.length): EntityMessage {
  const entities: MessageEntity[] = [];
  for (const e of message.entities) {
    const from = Math.max(e.offset, start);
    const to = Math.min(e.offset + e.length, end);
    if (to <= from) continue;
    entities.push({ ...e, offset: from - start, length: to - from });
  }
  return { text: message.text.slice(start, end), entities: dropBlankEntities(message.text.slice(start, end), entities) };
}

/**
 * Strip leading and trailing whitespace, as Telegram does to every message on
 * arrival. It strips it *before* applying the offsets, so a message that
 * starts with a newline would otherwise have all its formatting shifted one
 * character to the left — or refused, when an entity then runs off the end.
 */
export function trimMessage(message: EntityMessage): EntityMessage {
  const start = message.text.length - message.text.trimStart().length;
  const end = message.text.trimEnd().length;
  if (start === 0 && end === message.text.length) return message;
  if (end <= start) return plain('');
  return sliceMessage(message, start, end);
}

/**
 * Drop entities with nothing visible in them. Telegram rejects a message with
 * an entity over whitespace alone ("text must be non-empty") for some types,
 * and a slice can leave one behind at either edge.
 */
function dropBlankEntities(text: string, entities: MessageEntity[]): MessageEntity[] {
  return entities.filter((e) => e.length > 0 && (e.type === 'pre' || text.slice(e.offset, e.offset + e.length).trim() !== ''));
}

/**
 * Prefix every line of `message` with `prefix`, keeping its entities on the
 * same characters. For list items: a nested paragraph or sub-list lines up
 * under its bullet.
 */
export function indentMessage(message: EntityMessage, prefix: string, skipFirstLine = false): EntityMessage {
  if (!prefix) return message;
  const { text } = message;
  // shift[i] is how far character i moves: one prefix for every line start at
  // or before it.
  const shift = new Array<number>(text.length + 1);
  let added = 0;
  let out = '';
  for (let i = 0; i <= text.length; i++) {
    const lineStart = i === 0 ? !skipFirstLine : text[i - 1] === '\n';
    if (lineStart && i < text.length && text[i] !== '\n') {
      out += prefix;
      added += prefix.length;
    }
    shift[i] = added;
    if (i < text.length) out += text[i];
  }
  const entities = message.entities.map((e) => {
    const from = e.offset + shift[e.offset];
    // The end keeps the shift of the last character inside the entity, so a
    // prefix inserted at the next line's start stays outside it.
    const lastShift = e.length > 0 ? shift[e.offset + e.length - 1] : shift[e.offset];
    return { ...e, offset: from, length: e.offset + e.length + lastShift - from };
  });
  return { text: out, entities };
}

