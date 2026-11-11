import { describe, it, expect } from 'vitest';
import { EntityText, clip, indentMessage, isLinkableUrl, sliceMessage, trimMessage } from '../../src/telegram/entities.js';

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

  it('renders a time as a date_time entity, in whole seconds', () => {
    const at = Date.UTC(2026, 10, 3, 17, 20, 0) + 999;
    const { text, entities } = new EntityText().add('🕐 Updated ').dateTime('17:20', at).build();

    expect(text).toBe('🕐 Updated 17:20');
    expect(entities).toEqual([
      { type: 'date_time', offset: 11, length: 5, unix_time: Date.UTC(2026, 10, 3, 17, 20, 0) / 1000, date_time_format: 't' },
    ]);
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

describe('EntityText.link', () => {
  it('writes a link Telegram would refuse out as text, so the message still goes', () => {
    const m = new EntityText().link('the app', 'http://localhost:3000').build();
    expect(m).toEqual({ text: 'the app (http://localhost:3000)', entities: [] });
  });

  it('does not repeat an address that is its own label', () => {
    expect(new EntityText().link('http://localhost:3000', 'http://localhost:3000').build().text).toBe('http://localhost:3000');
  });
});

describe('isLinkableUrl', () => {
  it('takes a web address with a real top-level domain, and tg: links', () => {
    expect(isLinkableUrl('https://telegra.ph/abc')).toBe(true);
    expect(isLinkableUrl('https://xn--bcher-kva.example.xn--p1ai/')).toBe(true);
    expect(isLinkableUrl('tg://user?id=1')).toBe(true);
  });

  it('refuses localhost, bare IPs, single-label hosts and other schemes', () => {
    for (const url of ['http://localhost:3000', 'http://127.0.0.1/', 'http://devbox:8080', 'file:///etc/passwd', 'ftp://a.com', 'not a url']) {
      expect(isLinkableUrl(url)).toBe(false);
    }
  });
});

describe('EntityText.wrap', () => {
  it('opens one entity around nested ones, the outer first', () => {
    const m = new EntityText().add('x ').wrap('bold', (b) => b.add('a ').italic('b')).build();
    expect(m.entities).toEqual([
      { type: 'bold', offset: 2, length: 3 },
      { type: 'italic', offset: 4, length: 1 },
    ]);
  });
});

describe('sliceMessage and trimMessage', () => {
  const m = new EntityText().add('  ').bold('hello world').add('\n').build();

  it('cuts entities at the edges of a slice', () => {
    expect(sliceMessage(m, 4, 9)).toEqual({ text: 'llo w', entities: [{ type: 'bold', offset: 0, length: 5 }] });
  });

  it('strips outer whitespace and moves the entities with the text', () => {
    expect(trimMessage(m)).toEqual({ text: 'hello world', entities: [{ type: 'bold', offset: 0, length: 11 }] });
  });
});

describe('indentMessage', () => {
  it('indents every line but the first, keeping entities on their characters', () => {
    const m = new EntityText().bold('one\ntwo').build();
    const out = indentMessage(m, '  ', true);
    expect(out.text).toBe('one\n  two');
    expect(out.entities).toEqual([{ type: 'bold', offset: 0, length: 9 }]);
  });
});
