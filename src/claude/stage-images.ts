import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { ImageAttachment } from '../providers/types.js';

/**
 * Map an ImageAttachment mediaType to a sensible file extension. Falls back
 * to `.bin` for unknowns — claude code's Read tool sniffs content anyway, the
 * extension is mostly cosmetic.
 */
export function imageExtension(mediaType: string): string {
  if (mediaType === 'image/jpeg') return 'jpg';
  if (mediaType === 'image/png') return 'png';
  if (mediaType === 'image/gif') return 'gif';
  if (mediaType === 'image/webp') return 'webp';
  return 'bin';
}

/**
 * Make every attachment reachable from the prompt text — exactly once.
 *
 * Claude turns an image path it finds in a pasted prompt into an `[Image #N]`
 * chip and takes the path back out of the text. That is how a pty-mode upload
 * gets the same vision semantics as sdk mode, and it needs no Read tool. But
 * it fires once per distinct file, so staging a second copy of a picture the
 * caller had already saved attached the same image twice: double the image
 * tokens, and a note left reading "Saved at:" with nothing after it.
 *
 * So an image the caller already wrote to disk and named in the prompt needs
 * nothing from us. Only an attachment with no on-disk copy is staged to /tmp,
 * and only a path the prompt does not already carry is appended.
 *
 * Returns the prompt to send plus the temp files the caller must delete once
 * the turn ends.
 */
export function stageImagesForPty(prompt: string, images?: ImageAttachment[]): { prompt: string; tempPaths: string[] } {
  if (!images || images.length === 0) return { prompt, tempPaths: [] };

  const tempPaths: string[] = [];
  const unreferenced: string[] = [];
  for (const img of images) {
    let filePath = img.path;
    if (!filePath) {
      const ext = imageExtension(img.mediaType);
      filePath = path.join('/tmp', `telecoder-img-${randomUUID()}.${ext}`);
      fs.writeFileSync(filePath, Buffer.from(img.data, 'base64'));
      tempPaths.push(filePath);
    }
    if (!prompt.includes(filePath)) unreferenced.push(filePath);
  }

  if (unreferenced.length === 0) return { prompt, tempPaths };

  const imageList = unreferenced.map((p, i) => `  ${i + 1}. ${p}`).join('\n');
  const augmented = `${prompt}

The user attached ${unreferenced.length === 1 ? 'an image' : `${unreferenced.length} images`} at:
${imageList}`;

  return { prompt: augmented, tempPaths };
}
