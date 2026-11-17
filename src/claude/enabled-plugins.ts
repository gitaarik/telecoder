/**
 * Which marketplace plugins the bot enables on top of the settings claude reads.
 *
 * Claude Code keeps plugin enablement in settings.json under `enabledPlugins`.
 * A plugin enabled in the terminal sits in the user's copy of that file, which
 * the pty reads along with the rest of the user setup — unless that setup
 * stays out, as it does on a bot with guests (loadsUserSetup in
 * pty-spawn-config.ts). Then a plugin enabled in the terminal is simply absent
 * in Telegram, and absent silently: a missing skill looks like a model that
 * ignored it.
 *
 * CLAUDE_PLUGINS names the ones to bring across in that case, or to enable for
 * the bot alone. It goes in at the *flag* tier, `--settings`, which sits above
 * the other tiers in Claude Code's precedence order and merges with them
 * key-by-key, so a project that enables its own plugins keeps them and picks
 * these up as well.
 */

import { config } from '../config.js';

/**
 * `plugin@marketplace`, the id `claude plugin list` prints. The bare plugin
 * name is the natural guess and never matches anything — Claude Code looks the
 * entry up by the full id and finds nothing, which is indistinguishable from
 * the plugin not being installed. Rejecting it here at least says so.
 */
const PLUGIN_ID = /^[^@\s]+@[^@\s]+$/;

/** Bad ids already reported, so a respawn loop doesn't repeat itself. */
const warned = new Set<string>();

/**
 * The `enabledPlugins` settings fragment for this install, or undefined when
 * nothing is configured — callers spread it conditionally so the key stays out
 * of the settings payload entirely rather than appearing as `{}`.
 */
export function enabledPluginsSetting(): Record<string, true> | undefined {
  const enabled: Record<string, true> = {};

  for (const id of config.CLAUDE_PLUGINS) {
    if (!PLUGIN_ID.test(id)) {
      if (!warned.has(id)) {
        warned.add(id);
        console.warn(
          `[plugins] ignoring CLAUDE_PLUGINS entry "${id}": expected plugin@marketplace, ` +
          'e.g. frontend-design@claude-plugins-official. Run `claude plugin list` for the ids.'
        );
      }
      continue;
    }
    enabled[id] = true;
  }

  return Object.keys(enabled).length > 0 ? enabled : undefined;
}

/** Reset the warn-once state. Test seam — production never needs this. */
export function resetPluginWarnings(): void {
  warned.clear();
}
