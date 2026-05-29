import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  detectImageType,
  isValidImageFile,
  getFileType,
} from '../../src/utils/file-type.js';

const b = (...bytes: number[]) => Buffer.from(bytes);

describe('detectImageType', () => {
  it('detects JPEG', () => {
    expect(detectImageType(b(0xff, 0xd8, 0xff, 0xe0))).toEqual({
      extension: '.jpg',
      mimeType: 'image/jpeg',
    });
  });

  it('detects PNG', () => {
    expect(detectImageType(b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toEqual({
      extension: '.png',
      mimeType: 'image/png',
    });
  });

  it('detects GIF87a and GIF89a', () => {
    expect(detectImageType(b(0x47, 0x49, 0x46, 0x38, 0x37, 0x61))?.extension).toBe('.gif');
    expect(detectImageType(b(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))?.extension).toBe('.gif');
  });

  it('detects WebP (RIFF + WEBP) and not other RIFF files', () => {
    const webp = b(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50);
    expect(detectImageType(webp)).toEqual({ extension: '.webp', mimeType: 'image/webp' });
    // RIFF but "WAVE" not "WEBP"
    const wav = b(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45);
    expect(detectImageType(wav)).toBeNull();
  });

  it('detects HEIC and HEIF brands via ftyp box', () => {
    const ftyp = (brand: string) =>
      Buffer.concat([b(0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70), Buffer.from(brand, 'ascii')]);
    expect(detectImageType(ftyp('heic'))).toEqual({ extension: '.heic', mimeType: 'image/heic' });
    expect(detectImageType(ftyp('mif1'))).toEqual({ extension: '.heif', mimeType: 'image/heif' });
  });

  it('detects valid BMP but rejects BMP with non-zero reserved bytes', () => {
    const validBmp = b(0x42, 0x4d, 1, 2, 3, 4, 0, 0, 0, 0);
    expect(detectImageType(validBmp)).toEqual({ extension: '.bmp', mimeType: 'image/bmp' });
    const fakeBmp = b(0x42, 0x4d, 1, 2, 3, 4, 9, 9, 9, 9); // reserved bytes non-zero
    expect(detectImageType(fakeBmp)).toBeNull();
  });

  it('detects TIFF (both endians)', () => {
    expect(detectImageType(b(0x49, 0x49, 0x2a, 0x00))?.extension).toBe('.tiff');
    expect(detectImageType(b(0x4d, 0x4d, 0x00, 0x2a))?.extension).toBe('.tiff');
  });

  it('returns null for unrecognized or too-short buffers', () => {
    expect(detectImageType(b(0x00, 0x01, 0x02, 0x03))).toBeNull();
    expect(detectImageType(b(0xff))).toBeNull();
    expect(detectImageType(Buffer.alloc(0))).toBeNull();
  });
});

describe('file-backed helpers', () => {
  const tmpFiles: string[] = [];
  const writeTmp = (name: string, buf: Buffer) => {
    const p = path.join(os.tmpdir(), `claudegram-ft-${process.pid}-${name}`);
    fs.writeFileSync(p, buf);
    tmpFiles.push(p);
    return p;
  };

  afterAll(() => {
    for (const p of tmpFiles) {
      try { fs.unlinkSync(p); } catch { /* ignore */ }
    }
  });

  it('isValidImageFile returns true for a real PNG header and false otherwise', () => {
    const png = writeTmp('a.png', b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a));
    expect(isValidImageFile(png)).toBe(true);
    const txt = writeTmp('a.txt', Buffer.from('hello world'));
    expect(isValidImageFile(txt)).toBe(false);
  });

  it('isValidImageFile returns false for a missing file', () => {
    expect(isValidImageFile('/nonexistent/path/x.png')).toBe(false);
  });

  it('getFileType returns the detected type or null', () => {
    const jpg = writeTmp('a.jpg', b(0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0));
    expect(getFileType(jpg)?.mimeType).toBe('image/jpeg');
    expect(getFileType('/nonexistent/x')).toBeNull();
  });
});
