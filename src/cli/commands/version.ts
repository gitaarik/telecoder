import type { CliIo, CommandResult } from '../dispatch.js';
import { getInstalledVersion } from '../../utils/install-mode.js';

export async function run(_args: string[], io: CliIo): Promise<CommandResult> {
  const version = getInstalledVersion();
  if (!version) {
    io.err('Could not read the version from package.json.');
    return 1;
  }
  io.out(version);
  return 0;
}
