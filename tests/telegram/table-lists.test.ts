import { describe, it, expect } from 'vitest';
import { tablesToLists } from '../../src/telegram/table-lists.js';

describe('tablesToLists', () => {
  it('makes each row one line, with the other headers above the list', () => {
    const md = [
      '### Estimated usage by category',
      '',
      '| Category | Tokens | Percentage |',
      '|----------|--------|------------|',
      '| System prompt | 3.8k | 0.4% |',
      '| Free space | 931.1k | 93.1% |',
      '',
      'After.',
    ].join('\n');
    expect(tablesToLists(md)).toBe([
      '### Estimated usage by category',
      '',
      '_Tokens · Percentage_',
      '- **System prompt:** 3.8k · 0.4%',
      '- **Free space:** 931.1k · 93.1%',
      '',
      'After.',
    ].join('\n'));
  });

  it('skips empty cells, and a row with no label keeps its values', () => {
    const md = '| Skill | Source | Tokens |\n|---|---|---|\n| and 8 more |  | ~480 |\n|  | Built-in |  |';
    expect(tablesToLists(md)).toBe('_Source · Tokens_\n- **and 8 more:** ~480\n- Built-in');
  });

  it('reads alignment colons, no outer pipes, and escaped pipes in a cell', () => {
    const md = 'Name | Value\n:--- | ---:\na \\| b | 1';
    // Without a leading pipe the lines aren't taken for a table at all.
    expect(tablesToLists(md)).toBe(md);
    const piped = '| Name | Value |\n|:---|---:|\n| a \\| b | 1 |';
    expect(tablesToLists(piped)).toBe('_Value_\n- **a \\| b:** 1');
  });

  it('leaves text without a header rule alone', () => {
    const md = '| not a table |\nplain line';
    expect(tablesToLists(md)).toBe(md);
  });
});
