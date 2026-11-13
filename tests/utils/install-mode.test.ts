import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  detectInstallMode,
  detectPackageRunner,
  getInstallMode,
  getInstalledVersion,
  PACKAGE_ROOT,
} from '../../src/utils/install-mode.js';

const ROOT = '/opt/telecoder';
const existsOnly = (...files: string[]) => (p: string) => files.includes(p);

describe('detectInstallMode', () => {
  it('is a checkout with .git next to package.json', () => {
    expect(detectInstallMode(ROOT, existsOnly(`${ROOT}/.git`))).toBe('checkout');
  });

  it('is a checkout with src/ next to package.json, even without .git', () => {
    expect(detectInstallMode(ROOT, existsOnly(`${ROOT}/src`))).toBe('checkout');
  });

  it('is a package with neither', () => {
    expect(detectInstallMode(ROOT, existsOnly(`${ROOT}/dist`, `${ROOT}/package.json`))).toBe('package');
  });

  it('calls this repo a checkout', () => {
    expect(getInstallMode()).toBe('checkout');
  });
});

describe('PACKAGE_ROOT', () => {
  it('is the directory holding package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf-8'));
    expect(pkg.name).toBe('telecoder');
    expect(getInstalledVersion()).toBe(pkg.version);
  });
});

describe('detectPackageRunner', () => {
  it("recognises npx's cache", () => {
    expect(detectPackageRunner('/home/u/.npm/_npx/0123abcd/node_modules/telecoder')).toBe('npx');
  });

  it('recognises a global install', () => {
    expect(detectPackageRunner('/usr/lib/node_modules/telecoder')).toBe('global');
    expect(detectPackageRunner('/home/u/.nvm/versions/node/v22.1.0/lib/node_modules/telecoder')).toBe('global');
  });

  it('calls anything else local', () => {
    expect(detectPackageRunner('/home/u/project/node_modules/telecoder')).toBe('local');
  });
});
