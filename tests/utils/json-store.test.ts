import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';
import { ensureStateDir, readJsonFile, writeJsonFile } from '../../src/utils/json-store.js';

const schema = z.object({ items: z.record(z.string(), z.number()) });

describe('json-store', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-js-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('ensureStateDir', () => {
    it('creates the directory owner-only when missing', () => {
      const target = path.join(dir, 'nested', 'state');
      ensureStateDir(target, 'Test');
      expect(fs.existsSync(target)).toBe(true);
      if (process.platform !== 'win32') {
        expect(fs.statSync(target).mode & 0o777).toBe(0o700);
      }
    });

    it('tightens permissions on an existing world-readable directory', () => {
      if (process.platform === 'win32') return;
      fs.chmodSync(dir, 0o755);
      ensureStateDir(dir, 'Test');
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    });

    it('warns instead of throwing when the path is a file', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const target = path.join(dir, 'not-a-dir');
      fs.writeFileSync(target, 'x');
      expect(() => ensureStateDir(target, 'Test')).not.toThrow();
      expect(warn).toHaveBeenCalled();
    });
  });

  describe('readJsonFile', () => {
    it('returns undefined for a missing file', () => {
      expect(readJsonFile(path.join(dir, 'nope.json'), schema, 'Test')).toBeUndefined();
    });

    it('returns parsed data for a valid file', () => {
      const file = path.join(dir, 'ok.json');
      fs.writeFileSync(file, JSON.stringify({ items: { a: 1 } }));
      expect(readJsonFile(file, schema, 'Test')).toEqual({ items: { a: 1 } });
    });

    it('returns undefined and warns on a schema mismatch', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const file = path.join(dir, 'bad.json');
      fs.writeFileSync(file, JSON.stringify({ items: { a: 'not-a-number' } }));
      expect(readJsonFile(file, schema, 'Test')).toBeUndefined();
      expect(warn).toHaveBeenCalled();
    });

    it('returns undefined and logs on malformed JSON', () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const file = path.join(dir, 'corrupt.json');
      fs.writeFileSync(file, '{ this is not json');
      expect(readJsonFile(file, schema, 'Test')).toBeUndefined();
      expect(error).toHaveBeenCalled();
    });
  });

  describe('writeJsonFile', () => {
    it('round-trips through readJsonFile', () => {
      const file = path.join(dir, 'rt.json');
      writeJsonFile(file, { items: { a: 1, b: 2 } }, 'Test');
      expect(readJsonFile(file, schema, 'Test')).toEqual({ items: { a: 1, b: 2 } });
    });

    it('writes owner-only', () => {
      if (process.platform === 'win32') return;
      const file = path.join(dir, 'perm.json');
      writeJsonFile(file, { items: {} }, 'Test');
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    });

    it('leaves no temp file behind', () => {
      const file = path.join(dir, 'tmp.json');
      writeJsonFile(file, { items: {} }, 'Test');
      expect(fs.existsSync(file + '.tmp')).toBe(false);
    });

    it('logs instead of throwing when the path is unwritable', () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      // A directory in place of the target file makes the rename fail.
      const file = path.join(dir, 'blocked.json');
      fs.mkdirSync(file);
      expect(() => writeJsonFile(file, { items: {} }, 'Test')).not.toThrow();
      expect(error).toHaveBeenCalled();
    });
  });
});
