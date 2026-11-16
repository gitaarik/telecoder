/**
 * How this copy of TeleCoder was installed, decided once for every caller.
 *
 * - `checkout`: a git clone (or any tree with its sources beside it). It builds
 *   itself — /rebuildbot, the git-based /version check.
 * - `package`: an npm install (`npm install -g telecoder`, or npx). There is no
 *   source to build and no git to ask; updating goes through npm, and a restart
 *   is an exit for the service manager to answer.
 *
 * Nothing here reads config: where the .env lives is utils/config-home.ts.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

/**
 * The directory holding package.json. Two levels up from here both as
 * src/utils/install-mode.ts (tsx) and dist/utils/install-mode.js (built).
 */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export type InstallMode = 'checkout' | 'package';

/**
 * A checkout has its git metadata or its sources next to package.json; a
 * published package ships neither (see `files` in package.json). Either one is
 * enough, so a tarball of a checkout or a clone with .git removed still counts.
 */
export function detectInstallMode(
  packageRoot: string,
  exists: (p: string) => boolean = fs.existsSync,
): InstallMode {
  return exists(path.join(packageRoot, '.git')) || exists(path.join(packageRoot, 'src'))
    ? 'checkout'
    : 'package';
}

let cachedMode: InstallMode | undefined;

export function getInstallMode(): InstallMode {
  cachedMode ??= detectInstallMode(PACKAGE_ROOT);
  return cachedMode;
}

export function isCheckout(): boolean {
  return getInstallMode() === 'checkout';
}

/**
 * How a package install was put on this machine, which decides how it updates.
 * `npx` runs from npm's throwaway cache (`…/_npx/<hash>/node_modules/…`), where
 * an update is just running `npx telecoder@latest` next time.
 */
export type PackageRunner = 'npx' | 'global' | 'local';

export function detectPackageRunner(packageRoot: string = PACKAGE_ROOT): PackageRunner {
  const normalized = packageRoot.split(path.sep).join('/');
  if (normalized.includes('/_npx/')) return 'npx';
  // A global install lives in <prefix>/lib/node_modules/telecoder (or
  // <prefix>/node_modules on Windows); a local one in <project>/node_modules.
  if (/\/lib\/node_modules\/telecoder$/.test(normalized) || /\/npm\/node_modules\/telecoder$/i.test(normalized)) {
    return 'global';
  }
  return 'local';
}

/** The version in package.json, or null if it can't be read. */
export function getInstalledVersion(packageRoot: string = PACKAGE_ROOT): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf-8'));
    return typeof pkg?.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

/** Test seam: forget the cached mode. */
export function resetInstallModeCache(): void {
  cachedMode = undefined;
}
