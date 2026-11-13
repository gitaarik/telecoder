import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { resolveConfigHome } from '../../src/utils/config-home.js';

const ROOT = '/opt/telecoder';
const HOME = '/home/someone';

function existsOnly(...files: string[]) {
  const set = new Set(files);
  return (p: string) => set.has(p);
}

describe('resolveConfigHome', () => {
  it('uses the package root when a .env sits next to package.json (a checkout)', () => {
    expect(resolveConfigHome({
      packageRoot: ROOT, env: {}, homedir: HOME, exists: existsOnly(`${ROOT}/.env`),
    })).toEqual({ dir: ROOT, source: 'package-root' });
  });

  it('uses the package root when only instances.json is there', () => {
    expect(resolveConfigHome({
      packageRoot: ROOT, env: {}, homedir: HOME, exists: existsOnly(`${ROOT}/instances.json`),
    })).toEqual({ dir: ROOT, source: 'package-root' });
  });

  it('falls back to ~/.telecoder when the package root has no config (an npm install)', () => {
    expect(resolveConfigHome({
      packageRoot: ROOT, env: {}, homedir: HOME, exists: existsOnly(`${HOME}/.telecoder/.env`),
    })).toEqual({ dir: path.join(HOME, '.telecoder'), source: 'home' });
  });

  it('lets TELECODER_HOME override both', () => {
    expect(resolveConfigHome({
      packageRoot: ROOT, env: { TELECODER_HOME: '/srv/tc' }, homedir: HOME, exists: existsOnly(`${ROOT}/.env`),
    })).toEqual({ dir: '/srv/tc', source: 'override' });
  });

  it('ignores a blank TELECODER_HOME', () => {
    expect(resolveConfigHome({
      packageRoot: ROOT, env: { TELECODER_HOME: '  ' }, homedir: HOME, exists: existsOnly(),
    }).source).toBe('home');
  });

  it('does not treat .env.example as config', () => {
    expect(resolveConfigHome({
      packageRoot: ROOT, env: {}, homedir: HOME, exists: existsOnly(`${ROOT}/.env.example`),
    }).source).toBe('home');
  });
});
