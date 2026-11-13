import { isMainThread } from 'worker_threads';

/**
 * The exit code a launcher worker uses when its configuration stops it — a
 * missing setting, or a token Telegram rejected. 78 is EX_CONFIG from
 * sysexits.h.
 *
 * The launcher reads it as "restarting won't help": it stops the bot with the
 * message the bot printed, instead of respawning it into the same error four
 * times. A bot run on its own exits 1, which is what process managers and
 * shells expect from a failed start — unless a unit from `telecoder service
 * install` runs it, see configErrorExitCode().
 */
export const EXIT_CONFIG = 78;

/**
 * Set in the environment by the units `telecoder service install` writes, so
 * the bot knows which service manager answers its exit code.
 */
export const SERVICE_MANAGER_ENV = 'TELECODER_SERVICE';

export type ServiceManager = 'systemd' | 'launchd';

export function getServiceManager(env: NodeJS.ProcessEnv = process.env): ServiceManager | null {
  const value = env[SERVICE_MANAGER_ENV];
  return value === 'systemd' || value === 'launchd' ? value : null;
}

/**
 * The code to exit with on a configuration problem — whichever code makes the
 * thing that started us stand down instead of starting us into the same error
 * again.
 *
 * - A launcher worker: 78, which the launcher reads as "don't respawn".
 * - Under our systemd unit: 78, named in its RestartPreventExitStatus=.
 * - Under our launchd agent: 0. KeepAlive can only tell zero from non-zero
 *   (SuccessfulExit), not one code from another, so a clean exit is the only
 *   way to keep launchd from restarting a bot that can't start.
 * - Anything else (a terminal, pm2): 1, as for any failed start.
 */
export function configErrorExitCode(
  mainThread: boolean = isMainThread,
  manager: ServiceManager | null = getServiceManager(),
): number {
  if (!mainThread) return EXIT_CONFIG;
  if (manager === 'systemd') return EXIT_CONFIG;
  if (manager === 'launchd') return 0;
  return 1;
}

/** Exit for a configuration problem, with the code that fits how we were started. */
export function exitForConfigError(): never {
  process.exit(configErrorExitCode());
}
