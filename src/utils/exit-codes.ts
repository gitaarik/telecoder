import { isMainThread } from 'worker_threads';

/**
 * The exit code a launcher worker uses when its configuration stops it — a
 * missing setting, or a token Telegram rejected. 78 is EX_CONFIG from
 * sysexits.h.
 *
 * The launcher reads it as "restarting won't help": it stops the bot with the
 * message the bot printed, instead of respawning it into the same error four
 * times. A bot run on its own exits 1, which is what process managers and
 * shells expect from a failed start.
 */
export const EXIT_CONFIG = 78;

/** Exit for a configuration problem, with the code that fits how we were started. */
export function exitForConfigError(): never {
  process.exit(isMainThread ? 1 : EXIT_CONFIG);
}
