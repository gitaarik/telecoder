/**
 * Every message goes out as plain text plus entities (see
 * src/telegram/entities.ts). A parse mode anywhere in the source would bring
 * back the escaping failures and the broken splits that replaced it.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

describe('no parse mode', () => {
  it('sends nothing with parse_mode set', () => {
    const offenders = sourceFiles(path.resolve(__dirname, '../../src')).flatMap((file) =>
      fs.readFileSync(file, 'utf-8').split('\n')
        .map((line, i) => ({ line, at: `${path.relative(process.cwd(), file)}:${i + 1}` }))
        .filter(({ line }) => /parse_mode\s*:\s*['"]/.test(line) && !line.trim().startsWith('//'))
        .map(({ at }) => at),
    );
    expect(offenders).toEqual([]);
  });
});
