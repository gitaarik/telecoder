/**
 * Parse a comma-separated list of numeric Telegram ids from the environment.
 *
 * Kept free of config imports so config.ts can use it and tests can call it
 * directly. The two mistakes it exists to catch both used to start the bot
 * quietly broken: `@alice` parsed to NaN ("Allowed users: NaN", nobody let
 * in), and the .env.example placeholder 123456789 was accepted as a real
 * admin — someone else's account, for all anyone could tell.
 */

/** The user id .env.example ships with. Never a real install's id. */
export const PLACEHOLDER_USER_ID = 123456789;

export type IdListResult = { ok: true; ids: number[] } | { ok: false; error: string };

/**
 * `kind` decides the hint: user ids are positive, and group ids are negative
 * (supergroups start with -100).
 */
export function parseIdList(name: string, raw: string, kind: 'user' | 'group' = 'user'): IdListResult {
  const entries = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const ids: number[] = [];

  for (const entry of entries) {
    if (!/^-?\d+$/.test(entry)) {
      const hint = entry.startsWith('@')
        ? ` Telegram usernames can't be used here: the bot can't look a username up, and usernames can change.`
        : '';
      const how = kind === 'user'
        ? 'Each entry must be a numeric Telegram user id, like 412345678 — message @userinfobot on Telegram to get yours.'
        : 'Each entry must be a numeric Telegram chat id, like -1001234567890 — add @RawDataBot to the group to see it.';
      return { ok: false, error: `${name} contains "${entry}", which is not a number.${hint} ${how}` };
    }

    const id = Number(entry);
    if (!Number.isSafeInteger(id)) {
      return { ok: false, error: `${name} contains "${entry}", which is too large to be a Telegram id.` };
    }

    if (kind === 'user' && id === PLACEHOLDER_USER_ID) {
      return {
        ok: false,
        error:
          `${name} still contains ${PLACEHOLDER_USER_ID}, the example value from .env.example. ` +
          'Replace it with your own numeric Telegram user id — message @userinfobot on Telegram to get it.',
      };
    }

    ids.push(id);
  }

  return { ok: true, ids };
}
