/**
 * `telecoder start` — run the bot in this process.
 *
 * One bot is what `npm start` runs (index.ts); several are what
 * `npm run start:multi` runs (launcher.ts). In a checkout you pick by script;
 * here the config decides: an instances.json in the config home means the
 * launcher, otherwise a single bot from .env. --single / --multi override that.
 *
 * Either way the bot's own module takes over the process, so this resolves
 * with nothing and leaves the exit to it.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { CliIo, CommandResult } from '../dispatch.js';
import { configFile, getConfigHome } from '../../utils/config-home.js';
import { legacyEnv } from '../../utils/legacy-env.js';
import { PACKAGE_ROOT } from '../../utils/install-mode.js';

export type StartTarget = 'single' | 'multi';

export interface StartInputs {
  args: string[];
  instancesExists: boolean;
}

/** Which entry point to run. Pure, for tests. */
export function chooseStartTarget({ args, instancesExists }: StartInputs): StartTarget {
  if (args.includes('--single')) return 'single';
  if (args.includes('--multi') || args.includes('--config')) return 'multi';
  return instancesExists ? 'multi' : 'single';
}

/** The lines to print when there is no config to start from. */
export function missingConfigMessage(envPath: string): string[] {
  return [
    `No TeleCoder config found: ${envPath} doesn't exist.`,
    '',
    'Run "telecoder init" to set one up. (Not built yet — until it is, copy',
    `${path.join(PACKAGE_ROOT, '.env.example')} to ${envPath} and fill in`,
    'TELEGRAM_BOT_TOKEN and ALLOWED_USER_IDS.)',
    '',
    `Config is read from ${getConfigHome()}; set TELECODER_HOME to use another directory.`,
  ];
}

export async function run(args: string[], io: CliIo): Promise<CommandResult> {
  const target = chooseStartTarget({ args, instancesExists: fs.existsSync(configFile('instances.json')) });

  if (target === 'single') {
    const envPath = legacyEnv('ENV_PATH') || configFile('.env');
    // A token in the environment is a complete config on its own (a service
    // unit with Environment= lines, say), so only a missing both is fatal.
    if (!fs.existsSync(envPath) && !process.env.TELEGRAM_BOT_TOKEN) {
      for (const line of missingConfigMessage(envPath)) io.err(line);
      return 1;
    }
    await import('../../index.js');
    return;
  }

  await import('../../launcher.js');
}
