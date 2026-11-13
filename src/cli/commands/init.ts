/**
 * `telecoder init` — placeholder. The interactive setup (token, allowed users,
 * writing <config home>/.env) goes here; utils/config-home.ts says where.
 */

import * as path from 'path';
import type { CliIo, CommandResult } from '../dispatch.js';
import { getConfigHome } from '../../utils/config-home.js';
import { PACKAGE_ROOT } from '../../utils/install-mode.js';

export async function run(_args: string[], io: CliIo): Promise<CommandResult> {
  io.out('telecoder init is coming soon.');
  io.out('');
  io.out('Until then, set up by hand:');
  io.out(`  mkdir -p ${getConfigHome()}`);
  io.out(`  cp ${path.join(PACKAGE_ROOT, '.env.example')} ${path.join(getConfigHome(), '.env')}`);
  io.out('  then fill in TELEGRAM_BOT_TOKEN and ALLOWED_USER_IDS, and run "telecoder doctor".');
  return 0;
}
