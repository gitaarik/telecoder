import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { stageImagesForPty, imageExtension } from '../../src/claude/stage-images.js';

// A real 1x1 PNG, so a staged file is a plausible image on disk.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');
const data = PNG.toString('base64');

const cleanup: string[] = [];
afterEach(() => {
  for (const p of cleanup.splice(0)) { try { fs.unlinkSync(p); } catch { /* gone */ } }
});

describe('stageImagesForPty', () => {
  it('leaves the prompt alone when the caller already named the saved path', () => {
    const saved = path.join(os.tmpdir(), 'already-saved.png');
    const prompt = `User uploaded an image to the project.\nSaved at: ${saved}\nCaption: (none)`;

    const out = stageImagesForPty(prompt, [{ data, mediaType: 'image/png', path: saved }]);

    // The single path claude will turn into one [Image #N] chip — not two.
    expect(out.prompt).toBe(prompt);
    expect(out.tempPaths).toEqual([]);
    expect(out.prompt.match(/already-saved\.png/g)).toHaveLength(1);
  });

  it('stages an attachment that has no copy on disk', () => {
    const out = stageImagesForPty('describe this', [{ data, mediaType: 'image/png' }]);
    cleanup.push(...out.tempPaths);

    expect(out.tempPaths).toHaveLength(1);
    expect(out.tempPaths[0]).toMatch(/^\/tmp\/telecoder-img-[\w-]+\.png$/);
    expect(fs.readFileSync(out.tempPaths[0]!)).toEqual(PNG);
    expect(out.prompt).toContain('The user attached an image at:');
    expect(out.prompt).toContain(out.tempPaths[0]!);
  });

  it('no longer tells claude to Read the file — the path becomes the attachment', () => {
    const out = stageImagesForPty('describe this', [{ data, mediaType: 'image/png' }]);
    cleanup.push(...out.tempPaths);
    expect(out.prompt).not.toContain('Read tool');
  });

  it('appends a saved path the prompt forgot to mention', () => {
    const saved = path.join(os.tmpdir(), 'unmentioned.png');
    const out = stageImagesForPty('look at it', [{ data, mediaType: 'image/png', path: saved }]);

    expect(out.tempPaths).toEqual([]);
    expect(out.prompt).toContain(saved);
  });

  it('counts only what it had to add when some images are already named', () => {
    const named = path.join(os.tmpdir(), 'named.png');
    const out = stageImagesForPty(`see ${named}`, [
      { data, mediaType: 'image/png', path: named },
      { data, mediaType: 'image/png' },
    ]);
    cleanup.push(...out.tempPaths);

    expect(out.tempPaths).toHaveLength(1);
    expect(out.prompt).toContain('The user attached an image at:');
    expect(out.prompt).not.toContain('2 images');
    expect(out.prompt.match(/named\.png/g)).toHaveLength(1);
  });

  it('pluralises when it stages more than one', () => {
    const out = stageImagesForPty('compare', [
      { data, mediaType: 'image/png' },
      { data, mediaType: 'image/jpeg' },
    ]);
    cleanup.push(...out.tempPaths);

    expect(out.tempPaths).toHaveLength(2);
    expect(out.prompt).toContain('The user attached 2 images at:');
  });

  it('passes an empty attachment list straight through', () => {
    expect(stageImagesForPty('hello', [])).toEqual({ prompt: 'hello', tempPaths: [] });
    expect(stageImagesForPty('hello', undefined)).toEqual({ prompt: 'hello', tempPaths: [] });
  });
});

describe('imageExtension', () => {
  it('maps the media types telegram sends', () => {
    expect(imageExtension('image/jpeg')).toBe('jpg');
    expect(imageExtension('image/png')).toBe('png');
    expect(imageExtension('image/gif')).toBe('gif');
    expect(imageExtension('image/webp')).toBe('webp');
  });

  it('falls back to bin for anything else', () => {
    expect(imageExtension('image/avif')).toBe('bin');
  });
});
