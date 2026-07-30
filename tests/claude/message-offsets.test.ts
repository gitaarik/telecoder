import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { countJsonlLines } from '../../src/claude/message-offsets.js';

describe('countJsonlLines', () => {
  const created: string[] = [];
  const write = (name: string, content: string) => {
    const p = path.join(os.tmpdir(), `telecoder-jsonl-${process.pid}-${name}`);
    fs.writeFileSync(p, content);
    created.push(p);
    return p;
  };

  afterEach(() => {
    for (const p of created) {
      try { fs.unlinkSync(p); } catch { /* ignore */ }
    }
    created.length = 0;
  });

  it('counts records, ignoring a single trailing newline', () => {
    expect(countJsonlLines(write('a', '{"a":1}\n{"b":2}\n'))).toBe(2);
  });

  it('counts a final line without a trailing newline', () => {
    expect(countJsonlLines(write('b', '{"a":1}\n{"b":2}'))).toBe(2);
  });

  it('returns 0 for an empty file', () => {
    expect(countJsonlLines(write('c', ''))).toBe(0);
  });

  it('returns 0 for a missing file', () => {
    expect(countJsonlLines('/nonexistent/transcript.jsonl')).toBe(0);
  });

  it('counts a single line', () => {
    expect(countJsonlLines(write('d', '{"only":1}'))).toBe(1);
  });
});
