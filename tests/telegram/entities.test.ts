import { describe, it, expect } from 'vitest';
import { EntityText, clip } from '../../src/telegram/entities.js';

describe('EntityText', () => {
  it('records offsets against the text it has already appended', () => {
    const { text, entities } = new EntityText()
      .add('Tool: ')
      .code('Bash')
      .build();

    expect(text).toBe('Tool: Bash');
    expect(entities).toEqual([{ type: 'code', offset: 6, length: 4 }]);
  });

  it('counts offsets in UTF-16 code units, so emoji shift them by two', () => {
    // Telegram reads offsets as UTF-16 units, which is what String.length
    // counts — an emoji before a span must push it along by 2, not 1.
    const { text, entities } = new EntityText().add('🔐 ').bold('Permission').build();

    expect(text).toBe('🔐 Permission');
    expect(entities[0]).toMatchObject({ type: 'bold', offset: 3, length: 10 });
    expect(text.slice(entities[0].offset, entities[0].offset + entities[0].length)).toBe('Permission');
  });

  it('carries a language on a pre block', () => {
    const { entities } = new EntityText().pre('rm -rf /tmp/x', 'bash').build();
    expect(entities[0]).toMatchObject({ type: 'pre', offset: 0, length: 13, language: 'bash' });
  });

  it('renders a mention as a text_mention carrying the user id', () => {
    const { text, entities } = new EntityText().add('Only ').mention('Rik', 42).add(' can approve.').build();

    expect(text).toBe('Only Rik can approve.');
    expect(entities[0]).toMatchObject({ type: 'text_mention', offset: 5, length: 3 });
    expect((entities[0] as { user: { id: number } }).user.id).toBe(42);
  });

  it('keeps several spans in order and non-overlapping', () => {
    const { text, entities } = new EntityText()
      .bold('A')
      .add(' — ')
      .code('B')
      .newline()
      .italic('C')
      .build();

    expect(text).toBe('A — B\nC');
    expect(entities.map((e) => [e.type, e.offset, e.length])).toEqual([
      ['bold', 0, 1],
      ['code', 4, 1],
      ['italic', 6, 1],
    ]);
  });

  it('adds no entity for empty text', () => {
    const { text, entities } = new EntityText().bold('').add('x').build();
    expect(text).toBe('x');
    expect(entities).toEqual([]);
  });

  it('tracks length so callers can stay under Telegram’s cap', () => {
    const b = new EntityText().add('12345').bold('678');
    expect(b.length).toBe(8);
  });
});

describe('clip', () => {
  it('leaves short text alone', () => {
    expect(clip('abc', 10)).toBe('abc');
  });

  it('marks the cut and respects the budget', () => {
    const out = clip('abcdefghij', 5);
    expect(out).toBe('abcd…');
    expect(out.length).toBe(5);
  });
});
