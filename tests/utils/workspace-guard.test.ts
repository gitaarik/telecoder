import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isPathWithinRoot, resolvePathWithinRoot } from '../../src/utils/workspace-guard.js';

describe('workspace-guard', () => {
  let root: string;
  let inside: string;
  let outside: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'claudegram-ws-root-'));
    inside = path.join(root, 'sub', 'file.txt');
    fs.mkdirSync(path.dirname(inside), { recursive: true });
    fs.writeFileSync(inside, 'x');
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'claudegram-ws-out-'));
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  describe('isPathWithinRoot', () => {
    it('accepts the root itself', () => {
      expect(isPathWithinRoot(root, root)).toBe(true);
    });

    it('accepts an existing path inside the root', () => {
      expect(isPathWithinRoot(root, inside)).toBe(true);
    });

    it('accepts a non-existent path that resolves inside the root', () => {
      expect(isPathWithinRoot(root, path.join(root, 'does-not-exist.txt'))).toBe(true);
    });

    it('rejects a path outside the root', () => {
      expect(isPathWithinRoot(root, outside)).toBe(false);
    });

    it('rejects traversal escapes', () => {
      expect(isPathWithinRoot(root, path.join(root, '..', 'escape.txt'))).toBe(false);
    });

    it('rejects a sibling that shares a name prefix with the root', () => {
      expect(isPathWithinRoot(root, root + '-sibling')).toBe(false);
    });

    it('returns false when the root does not exist', () => {
      expect(isPathWithinRoot('/nonexistent/root', inside)).toBe(false);
    });
  });

  describe('resolvePathWithinRoot', () => {
    it('returns the resolved path for an in-root target', () => {
      const resolved = resolvePathWithinRoot(root, inside);
      expect(resolved).toBe(fs.realpathSync(inside));
    });

    it('returns null for an out-of-root target', () => {
      expect(resolvePathWithinRoot(root, outside)).toBeNull();
    });
  });
});
