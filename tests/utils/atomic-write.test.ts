import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { atomicWriteFileSync } from '../../src/utils/atomic-write.js';

describe('atomicWriteFileSync', () => {
  const created: string[] = [];
  const tmp = (name: string) => {
    const p = path.join(os.tmpdir(), `telecoder-aw-${process.pid}-${name}`);
    created.push(p, p + '.tmp');
    return p;
  };

  afterEach(() => {
    for (const p of created) {
      try { fs.unlinkSync(p); } catch { /* ignore */ }
    }
    created.length = 0;
  });

  it('writes the file contents', () => {
    const p = tmp('basic.txt');
    atomicWriteFileSync(p, 'hello');
    expect(fs.readFileSync(p, 'utf-8')).toBe('hello');
  });

  it('overwrites an existing file', () => {
    const p = tmp('over.txt');
    fs.writeFileSync(p, 'old');
    atomicWriteFileSync(p, 'new');
    expect(fs.readFileSync(p, 'utf-8')).toBe('new');
  });

  it('does not leave a .tmp file behind on success', () => {
    const p = tmp('clean.txt');
    atomicWriteFileSync(p, 'data');
    expect(fs.existsSync(p + '.tmp')).toBe(false);
  });

  it('applies the requested file mode', () => {
    const p = tmp('mode.txt');
    atomicWriteFileSync(p, 'data', { mode: 0o600 });
    const mode = fs.statSync(p).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('throws and cleans up the temp file when the destination dir is missing', () => {
    const bad = path.join(os.tmpdir(), 'telecoder-aw-missing-dir', 'x.txt');
    expect(() => atomicWriteFileSync(bad, 'data')).toThrow();
    expect(fs.existsSync(bad + '.tmp')).toBe(false);
  });
});
