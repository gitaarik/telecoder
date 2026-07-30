/**
 * TeleCoder was renamed from Claudegram in July 2026, and its environment
 * variables moved from `CLAUDEGRAM_*` to `TELECODER_*`. Anyone upgrading across
 * that rename still has the old names in their `.env` or exported shell env, so
 * every *user-settable* var reads the new name first and falls back to the old
 * one — warning once per var so the deprecation is visible without spamming a
 * line on every read.
 *
 * Internal parent→child vars are deliberately NOT routed through here. The ones
 * `launcher.ts` sets for its workers and `pty-provider.ts` sets for the MCP
 * subprocess are written and read by the same build, so they rename in lockstep
 * and have no older peer to stay compatible with.
 */

const warned = new Set<string>();

/**
 * Read `TELECODER_<suffix>`, falling back to the pre-rename `CLAUDEGRAM_<suffix>`.
 * Pass the suffix only — e.g. `legacyEnv('PERMISSION_PROMPTS')`.
 */
export function legacyEnv(suffix: string): string | undefined {
  const current = process.env[`TELECODER_${suffix}`];
  if (current !== undefined) return current;

  const legacy = process.env[`CLAUDEGRAM_${suffix}`];
  if (legacy !== undefined && !warned.has(suffix)) {
    warned.add(suffix);
    console.warn(
      `[env] CLAUDEGRAM_${suffix} is deprecated — rename it to TELECODER_${suffix}. ` +
      'The old name still works, but support for it will be dropped.'
    );
  }
  return legacy;
}

/** Reset the warn-once state. Test seam — production never needs this. */
export function resetLegacyEnvWarnings(): void {
  warned.clear();
}
