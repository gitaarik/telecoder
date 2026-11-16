/**
 * Where TeleCoder's configuration lives: the .env and instances.json. Every
 * reader goes through here.
 *
 * In order:
 *   1. TELECODER_HOME, when set — an explicit choice always wins.
 *   2. The package root, when a .env or instances.json sits next to
 *      package.json. That is a git checkout set up the way it always has been,
 *      and it keeps working exactly as before.
 *   3. ~/.telecoder — an npm install, whose package directory is no place for
 *      config (an update replaces it).
 *
 * ~/.telecoder is also the state directory (utils/json-store.ts). The two share
 * it without colliding: state is per-bot `*-<botId>.json` files and the like,
 * config is `.env`, `.env.*` and `instances.json`.
 * TELECODER_HOME moves only the config; state stays in ~/.telecoder.
 *
 * ENV_PATH and INSTANCES_CONFIG still point at a single file directly, ahead
 * of all this; their readers check them first.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PACKAGE_ROOT } from './install-mode.js';

/** The files whose presence next to package.json marks a checkout-style setup. */
export const CHECKOUT_CONFIG_FILES = ['.env', 'instances.json'] as const;

export type ConfigHomeSource = 'override' | 'package-root' | 'home';

export interface ConfigHome {
  dir: string;
  source: ConfigHomeSource;
}

export interface ConfigHomeInputs {
  packageRoot: string;
  env: NodeJS.ProcessEnv;
  homedir: string;
  exists: (p: string) => boolean;
}

/** The pure decision, for tests and for `telecoder doctor` to explain itself. */
export function resolveConfigHome({ packageRoot, env, homedir, exists }: ConfigHomeInputs): ConfigHome {
  const override = env.TELECODER_HOME?.trim();
  if (override) return { dir: path.resolve(override), source: 'override' };
  if (CHECKOUT_CONFIG_FILES.some((name) => exists(path.join(packageRoot, name)))) {
    return { dir: packageRoot, source: 'package-root' };
  }
  return { dir: path.join(homedir, '.telecoder'), source: 'home' };
}

let cached: ConfigHome | undefined;

/**
 * The config home for this process. Decided once: a .env created while the bot
 * runs (by `telecoder init`, say) must not move it halfway through.
 */
export function getConfigHomeInfo(): ConfigHome {
  cached ??= resolveConfigHome({
    packageRoot: PACKAGE_ROOT,
    env: process.env,
    homedir: os.homedir(),
    exists: fs.existsSync,
  });
  return cached;
}

export function getConfigHome(): string {
  return getConfigHomeInfo().dir;
}

/** A file in the config home, e.g. `configFile('.env')`. */
export function configFile(name: string): string {
  return path.join(getConfigHome(), name);
}

/** Test seam: forget the cached decision. */
export function resetConfigHomeCache(): void {
  cached = undefined;
}
