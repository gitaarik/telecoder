/**
 * `telecoder service install` — placeholder. Writes a systemd user unit or a
 * launchd agent running `telecoder start` with Restart=always / KeepAlive:
 * a restart from chat is an exit (RESTART_EXIT_CODE in utils/systemd.ts) that
 * the service manager has to answer.
 */

import type { CliIo, CommandResult } from '../dispatch.js';

export async function run(args: string[], io: CliIo): Promise<CommandResult> {
  const sub = args[0] ?? 'install';
  if (sub !== 'install') {
    io.err(`Unknown service command: ${sub}`);
    return 2;
  }
  io.out('telecoder service install is coming soon.');
  io.out('');
  io.out('TeleCoder expects a supervisor that starts it again when it exits — that is how');
  io.out('/restartbot works for an npm install. Until this command exists, run');
  io.out('"telecoder start" under systemd (Restart=always), launchd (KeepAlive) or pm2.');
  return 0;
}
