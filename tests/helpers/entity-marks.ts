import type { MessageEntity } from 'grammy/types';

const MARKS: Partial<Record<MessageEntity['type'], string>> = { bold: '*', italic: '_', code: '`' };

/**
 * `text` with its bold, italic and code entities marked as `*x*`, `_x_` and
 * `` `x` ``, so a test can state a formatted message in one readable string.
 * Only for entities that don't nest; other types are left unmarked.
 */
export function marked(text: string, entities: MessageEntity[] = []): string {
  let out = text;
  for (const e of [...entities].sort((a, b) => b.offset - a.offset)) {
    const mark = MARKS[e.type];
    if (!mark) continue;
    const end = e.offset + e.length;
    out = out.slice(0, e.offset) + mark + out.slice(e.offset, end) + mark + out.slice(end);
  }
  return out;
}
