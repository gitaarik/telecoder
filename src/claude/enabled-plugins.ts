/**
 * Which marketplace plugins the agent loads.
 *
 * Claude Code keeps plugin enablement in settings.json under `enabledPlugins`,
 * and both transports deliberately decline to read the user's copy of that
 * file. The pty spawns with `--setting-sources project,local` so that
 * `editorMode: "vim"` cannot turn Enter into a newline and swallow every prompt
 * (see pty-provider.ts); the SDK defaults to `settingSources: ['project']` so
 * that a machine's worth of MCP servers cannot inflate the tool count into
 * deferral. Both are worth keeping — but `enabledPlugins` lives in the file
 * they skip, so a plugin enabled in the terminal is simply absent in Telegram,
 * and absent silently: a missing skill looks like a model that ignored it.
 *
 * CLAUDE_PLUGINS names the few worth bringing across. It goes in at the *flag*
 * tier — `--settings` for the pty, `settings:` for the SDK — which sits above
 * project and local in Claude Code's precedence order and merges with them
 * key-by-key, so a project that enables its own plugins keeps them and picks
 * these up as well. Nothing else from ~/.claude/settings.json comes with it.
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
